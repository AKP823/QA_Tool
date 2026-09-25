/**
 * The actual QA engine. Given a base URL, a sitemap URL (defaults to
 * <base>/page-sitemap.xml) and extra paths, checks the homepage, every page
 * listed in the sitemap and every extra path, driving real headless Chromium
 * browser contexts. Returns an array of finding objects:
 *
 *   { pageUrl, pageTitle, category, check, status, result, notes, screenshotPath? }
 *
 * status is one of: PASS, WARNING, FAIL, NOT TESTED, N/A
 *
 * Checks, by category:
 *   Crawl                 pages discovered from the sitemap
 *   SEO                   robots.txt, sitemap.xml, title, meta description, canonical
 *   Connectivity          page loads, correct status
 *   SSL/TLS               served over https
 *   Site Functionality    nav present, no dev/staging asset hosts, no broken <img> tags
 *   Console/JS Errors     no console errors, no failed (4xx/5xx) network requests
 *   Links                 every internal link on the page returns a non-error status
 *   Responsive - Mobile   page loads / screenshot / console errors at 390x844
 *   Responsive - Tablet   page loads / screenshot / console errors at 768x1024
 */
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const STAGING_HINTS = ["staging", "stage.", "-stage", "dev.", ".dev", "test.", "preview.", "localhost"];
const MAX_INTERNAL_LINKS_PER_PAGE = 25;
const LINK_CHECK_TIMEOUT = 8000;

// Parallelism. Pages are checked by a small pool of workers sharing one
// browser; each worker runs a page's desktop, mobile and tablet passes in
// sequence, so at most PAGE_CONCURRENCY tabs are open at once. Link checks
// share one run-wide limit and cache, since most internal links (nav,
// footer) repeat on every page. Kept deliberately low: each worker adds
// ~300 MB of browser memory and another concurrent visitor on the target
// site; on a 40-page site 3/4/5 workers took 195s/146s/122s, so 4 is where
// returns start to flatten. Override with QA_PAGE_CONCURRENCY /
// QA_LINK_CONCURRENCY.
const envInt = (name, fallback, min, max) => {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const PAGE_CONCURRENCY = envInt("QA_PAGE_CONCURRENCY", 4, 1, 6);
const LINK_CONCURRENCY = envInt("QA_LINK_CONCURRENCY", 6, 1, 12);

const VIEWPORTS = [
  { label: "Mobile (390x844)", width: 390, height: 844 },
  { label: "Tablet (768x1024)", width: 768, height: 1024 },
];

function finding(pageUrl, pageTitle, category, check, status, result = "", notes = "", screenshotPath = "") {
  return { pageUrl, pageTitle, category, check, status, result, notes, screenshotPath };
}

// Sitemaps sometimes list URLs that serve a file (e.g. a PDF) rather than a
// page — Playwright reports that as a cryptic "Download is starting".
function describeLoadError(e) {
  return e.message.includes("Download is starting")
    ? "URL serves a file download instead of an HTML page"
    : e.message;
}

// Wraps async functions so no more than `max` run at once; the rest queue.
function createLimiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || !queue.length) return;
    active += 1;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => {
      active -= 1;
      next();
    });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}

// Runs worker(0..count-1) with at most `concurrency` in flight.
async function runPool(count, concurrency, worker) {
  let nextIndex = 0;
  const lanes = Array.from({ length: Math.min(concurrency, count) }, async () => {
    while (nextIndex < count) await worker(nextIndex++);
  });
  await Promise.all(lanes);
}

function sanitizeForFilename(str) {
  return (str || "page").replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "page";
}

// --------------------------------------------------------------------------
// robots.txt / sitemap.xml — checked once per run, not per page
// --------------------------------------------------------------------------

async function checkRobotsAndSitemap(context, baseUrl, findings) {
  for (const [urlPath, label] of [["/robots.txt", "robots.txt"], ["/sitemap.xml", "sitemap.xml"]]) {
    const url = new URL(urlPath, baseUrl).toString();
    const page = await context.newPage();
    try {
      const resp = await page.goto(url, { timeout: 15000 });
      const statusCode = resp ? resp.status() : null;
      const body = resp ? (await resp.text()).slice(0, 200).toLowerCase() : "";
      const looksValid =
        statusCode === 200 &&
        (body.includes("sitemap") || body.includes("user-agent") || body.includes("<urlset") || body.includes("disallow"));
      if (looksValid) {
        findings.push(finding(url, label, "SEO", `${label} returns 200 with expected content`, "PASS", `HTTP ${statusCode}`));
      } else {
        findings.push(
          finding(
            url, label, "SEO", `${label} returns 200 with expected content`, "FAIL",
            `HTTP ${statusCode}, body did not look like a valid ${label}`,
            `Add a real ${label} before this environment is indexed or promoted.`
          )
        );
      }
    } catch (e) {
      findings.push(finding(url, label, "SEO", `${label} returns 200 with expected content`, "FAIL", `Request failed: ${e.message}`));
    } finally {
      await page.close();
    }
  }
}

// --------------------------------------------------------------------------
// Page discovery — every <loc> in the sitemap (following sitemap indexes)
// --------------------------------------------------------------------------

const MAX_SITEMAP_DEPTH = 3;

function decodeXml(str) {
  return str
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .trim();
}

// Resolves against the base URL and drops the #fragment.
function normalizeUrl(raw, base) {
  try {
    const u = new URL(raw, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

// Treats "/about" and "/about/" as the same page when de-duplicating.
function dedupeKey(url) {
  return url.replace(/\/(?=\?|$)/, "");
}

async function fetchSitemapPages(context, sitemapUrl, depth = 0, seen = new Set()) {
  if (depth > MAX_SITEMAP_DEPTH || seen.has(sitemapUrl)) return [];
  seen.add(sitemapUrl);

  const resp = await context.request.get(sitemapUrl, { timeout: 20000 });
  if (!resp.ok()) throw new Error(`HTTP ${resp.status()} fetching ${sitemapUrl}`);
  const xml = await resp.text();

  // A sitemap index (e.g. Yoast's sitemap_index.xml) lists child sitemaps
  // rather than pages — follow each of them.
  if (/<sitemapindex[\s>]/i.test(xml)) {
    const pages = [];
    for (const m of xml.matchAll(/<sitemap[\s>][\s\S]*?<loc>([\s\S]*?)<\/loc>/gi)) {
      const child = decodeXml(m[1]);
      try {
        pages.push(...(await fetchSitemapPages(context, child, depth + 1, seen)));
      } catch {
        /* one broken child sitemap shouldn't sink the rest */
      }
    }
    return pages;
  }

  if (!/<urlset[\s>]/i.test(xml)) throw new Error(`${sitemapUrl} is not a sitemap (no <urlset> or <sitemapindex>)`);
  return [...xml.matchAll(/<loc>([\s\S]*?)<\/loc>/gi)].map((m) => decodeXml(m[1]));
}

// Returns the ordered, de-duplicated list of pages to check: homepage first,
// then sitemap pages, then extra paths. Sitemap pages on another host are
// skipped (www/non-www is treated as the same host).
async function discoverPages(context, baseUrl, sitemapUrl, extraPaths, findings) {
  const bareHost = (h) => h.replace(/^www\./, "");
  const baseHost = bareHost(new URL(baseUrl).hostname);

  let sitemapPages = [];
  try {
    sitemapPages = await fetchSitemapPages(context, sitemapUrl);
  } catch (e) {
    findings.push(
      finding(sitemapUrl, "Sitemap", "Crawl", "Pages discovered from sitemap", "FAIL", e.message,
        "Only the homepage and extra paths were checked. Set the project's sitemap URL if the site uses a different one.")
    );
  }

  const urls = [];
  const seen = new Set();
  let offHost = 0;
  const add = (raw) => {
    const u = normalizeUrl(raw, baseUrl);
    if (!u || seen.has(dedupeKey(u))) return;
    seen.add(dedupeKey(u));
    urls.push(u);
  };

  add(baseUrl);
  for (const raw of sitemapPages) {
    const u = normalizeUrl(raw, baseUrl);
    if (u && bareHost(new URL(u).hostname) !== baseHost) {
      offHost += 1;
      continue;
    }
    add(raw);
  }
  for (const p of extraPaths.map((p) => p.trim()).filter(Boolean)) add(p);

  if (sitemapPages.length) {
    findings.push(
      finding(sitemapUrl, "Sitemap", "Crawl", "Pages discovered from sitemap",
        offHost ? "WARNING" : "PASS",
        `${sitemapPages.length} URL(s) in sitemap; ${urls.length} unique page(s) will be checked`,
        offHost ? `${offHost} URL(s) point to a different host than ${baseHost} and were skipped.` : "")
    );
  }
  return urls;
}

// --------------------------------------------------------------------------
// Broken images — every <img> on the page must have actually loaded
// --------------------------------------------------------------------------

async function checkBrokenImages(page, url, title, findings) {
  const broken = await page.evaluate(() => {
    // Lazy-loaded images often sit on a blank placeholder (e.g. "data:," or a
    // 1x1 gif) until an IntersectionObserver swaps in the real image. That
    // placeholder isn't a useful link to report (it "opens" to nothing), so
    // prefer the real target from common lazy-load attributes when present.
    const LAZY_ATTRS = ["data-src", "data-lazy-src", "data-original", "data-srcset", "data-lazy"];
    return Array.from(document.querySelectorAll("img"))
      .filter((img) => !img.complete || img.naturalWidth === 0)
      .map((img) => {
        const raw = img.getAttribute("src") || "";
        let candidate = img.currentSrc || raw;
        if (!candidate || candidate.startsWith("data:")) {
          for (const attr of LAZY_ATTRS) {
            const v = img.getAttribute(attr);
            if (v) {
              candidate = v.split(",")[0].trim().split(" ")[0]; // first URL of a srcset-style value
              break;
            }
          }
        }
        let resolved = candidate;
        if (resolved) {
          try {
            resolved = new URL(resolved, document.baseURI).href;
          } catch {
            /* not resolvable (e.g. malformed src) — keep as typed */
          }
        }
        return { url: resolved || "(no src attribute)", alt: img.getAttribute("alt") || "" };
      });
  });

  const shown = broken.slice(0, 8);
  const f = finding(
    url, title, "Site Functionality", "All images load successfully",
    broken.length ? "FAIL" : "PASS",
    shown.map((b, i) => `${i + 1}. ${b.url}`).join("\n"),
    broken.length ? "The broken image's source URL won't open (that's the failure) — use the page link below to navigate to where it's used." : ""
  );
  if (shown.length) {
    // The image src itself is a dead link by definition (that's the failure
    // being reported), so link to the page instead — a reviewer can navigate
    // there and locate the broken image using the src/alt shown in the label.
    f.links = shown.map((b, i) => ({
      label: b.alt ? `Image ${i + 1} — alt: "${b.alt}" (src: ${b.url})` : `Image ${i + 1} (src: ${b.url})`,
      url,
    }));
  }
  findings.push(f);
}

// --------------------------------------------------------------------------
// Internal broken links — crawl <a> tags pointing at the same host, check status
// --------------------------------------------------------------------------

// Resolves to null when the link is fine, or { status, link, detail? } when
// broken. Results are cached per run so a link shared by many pages is only
// requested once.
function checkLink(context, link, linkState) {
  if (!linkState.cache.has(link)) {
    linkState.cache.set(
      link,
      linkState.limit(async () => {
        try {
          let resp = await context.request.fetch(link, { method: "HEAD", timeout: LINK_CHECK_TIMEOUT });
          if (resp.status() === 405 || resp.status() === 501) {
            // Some servers don't support HEAD — retry with GET before giving up.
            resp = await context.request.fetch(link, { method: "GET", timeout: LINK_CHECK_TIMEOUT });
          }
          return resp.status() >= 400 ? { status: String(resp.status()), link } : null;
        } catch (e) {
          return { status: "ERROR", link, detail: e.message.slice(0, 60) };
        }
      })
    );
  }
  return linkState.cache.get(link);
}

async function checkInternalLinks(context, page, url, title, targetHost, findings, linkState) {
  const links = await page.evaluate((host) => {
    return Array.from(document.querySelectorAll("a[href]"))
      .map((a) => a.href)
      .filter((href) => {
        try {
          return new URL(href).hostname === host;
        } catch {
          return false;
        }
      });
  }, targetHost);

  const uniqueLinks = [...new Set(links)].slice(0, MAX_INTERNAL_LINKS_PER_PAGE);
  const broken = (await Promise.all(uniqueLinks.map((link) => checkLink(context, link, linkState)))).filter(Boolean);

  const label = `Internal links return a non-error status (checked ${uniqueLinks.length}${links.length > uniqueLinks.length ? ` of ${new Set(links).size}` : ""})`;
  const shown = broken.slice(0, 8);
  const f = finding(
    url, title, "Links", label,
    broken.length ? "FAIL" : "PASS",
    shown.map((b) => (b.detail ? `${b.status} ${b.link} (${b.detail})` : `${b.status} ${b.link}`)).join("\n"),
    broken.length ? "Open each link below directly to verify — the exact broken URL is linked." : ""
  );
  if (shown.length) {
    f.links = shown.map((b) => ({ label: `HTTP ${b.status}`, url: b.link }));
  }
  findings.push(f);
}

// --------------------------------------------------------------------------
// Desktop pass — the full checklist, at normal desktop viewport
// --------------------------------------------------------------------------

async function checkPage(context, url, findings, isHomepage, linkState) {
  const page = await context.newPage();
  const consoleErrors = [];
  const failedRequests = [];
  const stagingHosts = new Set();
  const targetHost = new URL(url).hostname;

  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("response", (resp) => {
    try {
      if (resp.status() >= 400) failedRequests.push(`${resp.status()} ${resp.url()}`);
      const host = new URL(resp.url()).hostname || "";
      if (STAGING_HINTS.some((h) => host.includes(h)) && host !== targetHost) {
        stagingHosts.add(host);
      }
    } catch {
      /* ignore malformed URLs */
    }
  });

  try {
    const resp = await page.goto(url, { timeout: 20000, waitUntil: "load" });
    const statusCode = resp ? resp.status() : null;
    const title = await page.title();

    if (statusCode && statusCode < 400) {
      findings.push(finding(url, title, "Connectivity", "Page loads successfully", "PASS", `HTTP ${statusCode}`));
    } else {
      findings.push(finding(url, title, "Connectivity", "Page loads successfully", "FAIL", `HTTP ${statusCode}`));
      return;
    }

    findings.push(
      finding(url, title, "SSL/TLS", "Served over HTTPS", url.startsWith("https://") ? "PASS" : "WARNING",
        url.startsWith("https://") ? "" : "Page loaded over plain HTTP")
    );

    // Scroll to trigger lazy-loaded content (images, sections, etc.)
    try {
      await page.evaluate(async () => {
        for (let y = 0; y < document.body.scrollHeight; y += 400) {
          window.scrollTo(0, y);
          await new Promise((r) => setTimeout(r, 100));
        }
      });
    } catch {
      /* non-fatal */
    }
    await page.waitForTimeout(1000);

    const metaDesc = await page.evaluate(
      () => document.querySelector('meta[name="description"]')?.content || ""
    );
    const canonical = await page.evaluate(
      () => document.querySelector('link[rel="canonical"]')?.href || ""
    );

    findings.push(finding(url, title, "SEO", "Title present", title ? "PASS" : "FAIL", title));
    findings.push(finding(url, title, "SEO", "Meta description present", metaDesc ? "PASS" : "WARNING", metaDesc));
    findings.push(finding(url, title, "SEO", "Canonical tag present", canonical ? "PASS" : "WARNING", canonical || "none found"));

    findings.push(
      finding(url, title, "Console/JS Errors", "No console errors on load/scroll",
        consoleErrors.length ? "FAIL" : "PASS", consoleErrors.slice(0, 5).join("; "))
    );
    findings.push(
      finding(url, title, "Console/JS Errors", "No failed (4xx/5xx) network requests",
        failedRequests.length ? "WARNING" : "PASS", failedRequests.slice(0, 8).join("; "))
    );
    findings.push(
      finding(url, title, "Site Functionality", "Assets not pointing to dev/staging hosts",
        stagingHosts.size ? "FAIL" : "PASS",
        stagingHosts.size ? `Found asset host(s): ${[...stagingHosts].join(", ")}` : "",
        stagingHosts.size ? "Confirm these staging hosts are expected for this environment." : "")
    );

    if (isHomepage) {
      const navCount = await page.evaluate(() => document.querySelectorAll("nav a, header a").length);
      findings.push(
        finding(url, title, "Site Functionality", "Primary navigation present",
          navCount > 0 ? "PASS" : "FAIL", `${navCount} nav link(s) found`)
      );
    }

    await checkBrokenImages(page, url, title, findings);
    await checkInternalLinks(context, page, url, title, targetHost, findings, linkState);
  } catch (e) {
    findings.push(finding(url, "", "Connectivity", "Page loads successfully", "FAIL", describeLoadError(e)));
  } finally {
    await page.close();
  }
}

// --------------------------------------------------------------------------
// Responsive pass — re-check a page at a smaller viewport, with a screenshot
// --------------------------------------------------------------------------

async function checkResponsiveViewport(browser, url, viewport, findings, screenshotDir, pageIndex) {
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  const category = `Responsive - ${viewport.label}`;

  try {
    const resp = await page.goto(url, { timeout: 20000, waitUntil: "load" });
    const statusCode = resp ? resp.status() : null;
    const title = await page.title();

    findings.push(
      finding(url, title, category, "Page loads at this viewport",
        statusCode && statusCode < 400 ? "PASS" : "FAIL", `HTTP ${statusCode}`)
    );

    if (!statusCode || statusCode >= 400) return;

    await page.waitForTimeout(400);

    // Prefixed with the page's position so pages sharing a title don't
    // overwrite each other's screenshots.
    const fileName = `${String(pageIndex + 1).padStart(3, "0")}_${sanitizeForFilename(title || url)}_${sanitizeForFilename(viewport.label)}.png`;
    const filePath = path.join(screenshotDir, fileName);
    await page.screenshot({ path: filePath, fullPage: false });

    findings.push(
      finding(url, title, category, "Screenshot captured", "PASS", fileName, "", filePath)
    );
    findings.push(
      finding(url, title, category, "No console errors at this viewport",
        consoleErrors.length ? "FAIL" : "PASS", consoleErrors.slice(0, 5).join("; "))
    );
  } catch (e) {
    findings.push(finding(url, "", category, "Page loads at this viewport", "FAIL", describeLoadError(e)));
  } finally {
    await page.close();
    await context.close();
  }
}

// --------------------------------------------------------------------------
// Entry point
// --------------------------------------------------------------------------

async function runQa(baseUrl, sitemapUrl, extraPaths, screenshotDir) {
  const findings = [];
  fs.mkdirSync(screenshotDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await checkRobotsAndSitemap(context, baseUrl, findings);

    const urls = await discoverPages(context, baseUrl, sitemapUrl || new URL("/page-sitemap.xml", baseUrl).toString(), extraPaths, findings);

    // Each page collects into its own array so the merged findings stay in
    // page order no matter which worker finishes first.
    const linkState = { cache: new Map(), limit: createLimiter(LINK_CONCURRENCY) };
    const perPage = urls.map(() => []);
    await runPool(urls.length, PAGE_CONCURRENCY, async (i) => {
      await checkPage(context, urls[i], perPage[i], i === 0, linkState);
      // Responsive pass: re-check the page at mobile and tablet sizes.
      for (const viewport of VIEWPORTS) {
        await checkResponsiveViewport(browser, urls[i], viewport, perPage[i], screenshotDir, i);
      }
    });
    findings.push(...perPage.flat());
    await context.close();
  } finally {
    await browser.close();
  }

  return findings;
}

module.exports = { runQa };
