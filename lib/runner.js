/**
 * The actual QA engine. Given a base URL, an optional sitemap URL and extra
 * paths, checks the homepage, every page listed in the site's page sitemap
 * (auto-detected for Yoast, Rank Math and WordPress core when no sitemap URL
 * is set) and every extra path, driving real headless Chromium
 * browser contexts. Returns an array of finding objects:
 *
 *   { pageUrl, pageTitle, category, check, status, result, notes, screenshotPath? }
 *
 * status is one of: PASS, WARNING, FAIL, NOT TESTED, N/A
 *
 * Checks, by category:
 *   Crawl                 pages discovered from the sitemap
 *   SEO                   robots.txt, XML sitemap (Yoast / Rank Math / WP core / generic),
 *                         title, meta description, canonical
 *   Connectivity          page loads, correct status
 *   SSL/TLS               served over https
 *   Performance           TTFB, LCP, CLS, load time, page weight (desktop pass)
 *   Security              HSTS, CSP, X-Content-Type-Options, clickjacking protection, mixed content
 *   Site Functionality    nav present, no dev/staging asset hosts, no broken <img> tags
 *   Console/JS Errors     no console errors, no failed (4xx/5xx) network requests
 *   Links                 every internal link on the page returns a non-error status
 *   Responsive - Mobile   page loads / no horizontal overflow / full-page screenshot / console errors at 390x844
 *   Responsive - Tablet   page loads / no horizontal overflow / full-page screenshot / console errors at 768x1024
 */
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const STAGING_HINTS = ["staging", "stage.", "-stage", "dev.", ".dev", "test.", "preview.", "localhost"];
const MAX_INTERNAL_LINKS_PER_PAGE = 25;
const LINK_CHECK_TIMEOUT = 8000;
// Full-page screenshots stop here so an endless page doesn't produce a
// giant image (CSS px).
const MAX_SCREENSHOT_HEIGHT = 8000;

// Performance budgets as [good, poor]: at or under `good` is PASS, over
// `poor` is FAIL, in between WARNING. TTFB/LCP/CLS use Google's Core Web
// Vitals bands.
const PERF_BUDGETS = {
  ttfbMs: [800, 1800],
  lcpMs: [2500, 4000],
  cls: [0.1, 0.25],
  loadMs: [3000, 6000],
  weightBytes: [2 * 1024 * 1024, 5 * 1024 * 1024],
};

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

// Console errors Chromium logs about its own privacy features rather than the
// site's code — e.g. a third-party iframe (consent banner, embed) asking for
// storage access in a fresh headless profile. They come and go between runs
// and there's nothing on the page to fix.
const BENIGN_CONSOLE_ERRORS = [/requestStorageAccess/i, /Storage access/i];

// Records console errors on `page` into `errors`, dropping the benign ones.
function collectConsoleErrors(page, errors) {
  page.on("console", (msg) => {
    if (msg.type() === "error" && !BENIGN_CONSOLE_ERRORS.some((re) => re.test(msg.text()))) errors.push(msg.text());
  });
}

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

// Scrolls to the bottom in steps so lazy-loaded content (images, sections)
// gets fetched.
async function scrollThroughPage(page) {
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
}

function sanitizeForFilename(str) {
  return (str || "page").replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "page";
}

// --------------------------------------------------------------------------
// robots.txt / XML sitemap — checked once per run, not per page
// --------------------------------------------------------------------------

// How the common WordPress sitemap generators lay things out. Yoast and Rank
// Math serve an index at /sitemap_index.xml (with /sitemap.xml redirecting
// to it) whose page children are page-sitemap.xml, page-sitemap2.xml, ...;
// WordPress core (5.5+, when no SEO plugin replaces it) serves
// /wp-sitemap.xml with pages in wp-sitemap-posts-page-1.xml, -2, ...
const SITEMAP_CANDIDATES = ["sitemap_index.xml", "wp-sitemap.xml", "sitemap.xml"];
const PAGE_SITEMAP_PATTERN = /\/(page-sitemap\d*|wp-sitemap-posts-page-\d+)\.xml$/i;
const SITEMAP_GENERATORS = [
  { name: "Yoast SEO", test: /generated by Yoast|\/wordpress-seo\//i },
  { name: "Rank Math", test: /Rank Math|\/seo-by-rank-math\//i },
  { name: "All in One SEO", test: /aioseo|All in One SEO/i },
  { name: "SEOPress", test: /seopress/i },
  { name: "HubSpot", test: /\/hubfs\/|\.hs-sites\.com\//i },
  { name: "WordPress core", test: /wp-sitemap/i },
];

// Classifies a sitemap body: an index of child sitemaps, a flat list of
// pages, or neither. Comments, the <?xml-stylesheet?> line and the order of
// attributes don't matter.
function parseSitemap(xml) {
  const type = /<sitemapindex[\s>]/i.test(xml) ? "index" : /<urlset[\s>]/i.test(xml) ? "urlset" : null;
  if (!type) return { type: null, locs: [] };
  const locRe = type === "index" ? /<sitemap[\s>][\s\S]*?<loc>([\s\S]*?)<\/loc>/gi : /<url[\s>][\s\S]*?<loc>([\s\S]*?)<\/loc>/gi;
  return { type, locs: [...xml.matchAll(locRe)].map((m) => decodeXml(m[1])) };
}

function detectGenerator(xml, url) {
  return SITEMAP_GENERATORS.find((g) => g.test.test(xml) || g.test.test(url))?.name || "Unknown generator";
}

// Checks robots.txt, then locates the site's XML sitemap: first any
// same-host Sitemap: lines in robots.txt, then the usual Yoast / Rank Math /
// WordPress core locations. Returns { sitemaps, topLevelOnly }: the
// sitemaps to crawl (empty if none were found), and whether only top-level
// pages should be taken from them — true for a flat sitemap, which lists
// every URL on the site rather than just its pages.
async function checkRobotsAndSitemap(context, baseUrl, findings) {
  const bareHost = (h) => h.replace(/^www\./, "");
  const baseHost = bareHost(new URL(baseUrl).hostname);
  const check = (url, label, name, status, result, notes = "") =>
    findings.push(finding(url, label, "SEO", name, status, result, notes));

  // --- robots.txt ---
  const robotsUrl = new URL("/robots.txt", baseUrl).toString();
  const declared = [];
  try {
    const resp = await context.request.get(robotsUrl, { timeout: 15000 });
    const body = await resp.text();
    const looksValid = resp.status() === 200 && !/^\s*</.test(body) && /^\s*(user-agent|disallow|allow|sitemap)\s*:/im.test(body);
    check(robotsUrl, "robots.txt", "robots.txt returns 200 with expected content",
      looksValid ? "PASS" : "FAIL",
      looksValid ? `HTTP ${resp.status()}` : `HTTP ${resp.status()}, body did not look like a valid robots.txt`,
      looksValid ? "" : "Add a real robots.txt before this environment is indexed or promoted.");
    if (looksValid) {
      for (const m of body.matchAll(/^\s*sitemap\s*:\s*(\S+)/gim)) declared.push(m[1]);
    }
  } catch (e) {
    check(robotsUrl, "robots.txt", "robots.txt returns 200 with expected content", "FAIL", `Request failed: ${e.message}`);
  }

  const sameHost = declared.filter((u) => {
    try {
      return bareHost(new URL(u).hostname) === baseHost;
    } catch {
      return false;
    }
  });
  const otherHosts = declared.length - sameHost.length;
  check(robotsUrl, "robots.txt", "robots.txt declares an XML sitemap",
    sameHost.length ? "PASS" : "WARNING",
    sameHost.length
      ? sameHost.slice(0, 5).join("\n") + (sameHost.length > 5 ? `\n… and ${sameHost.length - 5} more` : "")
      : "No Sitemap: line for this host",
    [
      sameHost.length ? "" : "Add a Sitemap: line so crawlers can find the sitemap without guessing.",
      otherHosts ? `${otherHosts} Sitemap: line(s) point at another domain and were ignored.` : "",
    ].filter(Boolean).join(" "));

  // --- XML sitemap ---
  // When the base URL is a subfolder (e.g. a multisite's /blog/), robots.txt
  // may list every subsite's sitemap — prefer the ones under this project's
  // path, then the standard locations, then the rest.
  const basePath = new URL(".", baseUrl).pathname;
  const underBase = sameHost.filter((u) => new URL(u).pathname.startsWith(basePath));
  const candidates = [...new Set([
    ...underBase,
    ...SITEMAP_CANDIDATES.map((p) => new URL(p, baseUrl).toString()),
    ...sameHost,
  ])];
  const tried = [];
  let found = null;
  for (const url of candidates) {
    try {
      const resp = await context.request.get(url, { timeout: 15000 });
      const xml = resp.ok() ? await resp.text() : "";
      const parsed = parseSitemap(xml);
      if (parsed.type) {
        found = { url, finalUrl: resp.url(), xml, ...parsed };
        break;
      }
      tried.push(`${url} — HTTP ${resp.status()}${resp.ok() ? ", not a sitemap" : ""}`);
    } catch (e) {
      tried.push(`${url} — ${e.message.split("\n")[0].slice(0, 60)}`);
    }
  }

  if (!found) {
    check(candidates[0], "XML sitemap", "XML sitemap found and valid", "FAIL",
      `No valid sitemap found. Tried:\n${tried.join("\n")}`,
      "Enable the sitemap in Yoast / Rank Math / WordPress core (or add one), and reference it from robots.txt.");
    return { sitemaps: [], topLevelOnly: false };
  }

  const generator = detectGenerator(found.xml, found.finalUrl);
  const where = found.finalUrl !== found.url ? `${found.url} → ${found.finalUrl}` : found.url;
  const kind = found.type === "index" ? `sitemap index with ${found.locs.length} child sitemap(s)` : `${found.locs.length} URL(s)`;
  check(found.finalUrl, "XML sitemap", "XML sitemap found and valid",
    found.locs.length ? "PASS" : "WARNING",
    `${generator}: ${kind}\n${where}`,
    found.locs.length ? "" : "The sitemap is valid XML but lists nothing.");

  // A flat sitemap is the page list itself; an index needs its page children.
  if (found.type === "urlset") return { sitemaps: [found.finalUrl], topLevelOnly: true };
  const pageSitemaps = found.locs.filter((u) => PAGE_SITEMAP_PATTERN.test(new URL(u, found.finalUrl).pathname));
  check(found.finalUrl, "XML sitemap", "Page sitemap listed in sitemap index",
    pageSitemaps.length ? "PASS" : "WARNING",
    pageSitemaps.length ? pageSitemaps.join("\n") : `None of the ${found.locs.length} child sitemap(s) is a page sitemap`,
    pageSitemaps.length ? "" : "Pages may be excluded from the sitemap. Set the project's sitemap URL to choose which one to crawl.");
  return { sitemaps: pageSitemaps, topLevelOnly: false };
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

  const { type, locs } = parseSitemap(xml);
  if (!type) throw new Error(`${sitemapUrl} is not a sitemap (no <urlset> or <sitemapindex>)`);
  if (type === "urlset") return locs;

  // A sitemap index lists child sitemaps rather than pages — follow each.
  const pages = [];
  for (const child of locs) {
    try {
      pages.push(...(await fetchSitemapPages(context, child, depth + 1, seen)));
    } catch {
      /* one broken child sitemap shouldn't sink the rest */
    }
  }
  return pages;
}

// Returns the ordered, de-duplicated list of pages to check: homepage first,
// then sitemap pages, then extra paths. Sitemap pages on another host are
// skipped (www/non-www is treated as the same host). With topLevelOnly, only
// sitemap pages one level below the base URL are kept (/about, not
// /docs/guides/setup).
async function discoverPages(context, baseUrl, sitemapUrls, extraPaths, findings, topLevelOnly = false) {
  const bareHost = (h) => h.replace(/^www\./, "");
  const baseHost = bareHost(new URL(baseUrl).hostname);
  const crawlUrl = sitemapUrls[0];

  let sitemapPages = [];
  const errors = [];
  for (const sitemapUrl of sitemapUrls) {
    try {
      sitemapPages.push(...(await fetchSitemapPages(context, sitemapUrl)));
    } catch (e) {
      errors.push(e.message);
    }
  }
  if (!sitemapPages.length) {
    findings.push(
      finding(crawlUrl, "Sitemap", "Crawl", "Pages discovered from sitemap", "FAIL",
        errors.join("\n") || "Sitemap lists no pages",
        "Only the homepage and extra paths were checked. Set the project's sitemap URL if the site uses a different one.")
    );
  }

  const urls = [];
  const seen = new Set();
  let offHost = 0;
  let nested = 0;
  const basePath = new URL(".", baseUrl).pathname;
  const depthBelowBase = (u) => {
    const { pathname } = new URL(u);
    if (!pathname.startsWith(basePath)) return Infinity;
    return pathname.slice(basePath.length).split("/").filter(Boolean).length;
  };
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
    if (u && topLevelOnly && depthBelowBase(u) > 1) {
      nested += 1;
      continue;
    }
    add(raw);
  }
  for (const p of extraPaths.map((p) => p.trim()).filter(Boolean)) add(p);

  if (sitemapPages.length) {
    const problems = [
      offHost ? `${offHost} URL(s) point to a different host than ${baseHost} and were skipped.` : "",
      errors.length ? `Some sitemaps could not be read: ${errors.join("; ")}` : "",
    ].filter(Boolean);
    const notes = [
      ...problems,
      nested ? `${nested} nested URL(s) skipped — only top-level pages are taken from a flat sitemap. Set the project's sitemap URL to crawl all of them.` : "",
    ].filter(Boolean).join(" ");
    findings.push(
      finding(crawlUrl, "Sitemap", "Crawl", "Pages discovered from sitemap",
        problems.length ? "WARNING" : "PASS",
        `${sitemapPages.length} URL(s) in ${sitemapUrls.join(", ")}; ${urls.length} unique page(s) will be checked`,
        notes)
    );
  }
  return urls;
}

// --------------------------------------------------------------------------
// Broken images — every <img> on the page must have actually loaded
// --------------------------------------------------------------------------

// How long to wait for visible images that are still downloading before
// judging them.
const IMAGE_SETTLE_TIMEOUT = 5000;

// Why an image failed, from what the network listeners in checkPage saw for
// its URL. An image with no recorded request was never fetched — typically a
// lazy-load placeholder whose real src was never swapped in.
function describeImageFailure(imageUrl, imageRequests) {
  const r = imageRequests.get(imageUrl);
  if (!r) return "never requested";
  if (r.error) return `network error: ${r.error}`;
  if (r.status >= 400) return `HTTP ${r.status}`;
  return `HTTP ${r.status}, but not a valid image`;
}

async function checkBrokenImages(page, url, title, findings, imageRequests) {
  // Give visible images that are still downloading a chance to finish, so a
  // slow image isn't mistaken for a broken one.
  await page.evaluate(
    (ms) =>
      Promise.race([
        Promise.all(
          Array.from(document.images)
            .filter((img) => !img.complete && img.getClientRects().length)
            .map((img) => new Promise((r) => {
              img.addEventListener("load", r, { once: true });
              img.addEventListener("error", r, { once: true });
            }))
        ),
        new Promise((r) => setTimeout(r, ms)),
      ]),
    IMAGE_SETTLE_TIMEOUT
  );

  const candidates = await page.evaluate(() => {
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

        // Tracking pixels (ad/analytics beacons) are 0x0 or 1x1 by design and
        // often get an empty response, which reads as "broken".
        const box = img.getBoundingClientRect();
        const attrW = img.getAttribute("width");
        const attrH = img.getAttribute("height");
        const isPixel =
          (attrW !== null && attrH !== null && Number(attrW) <= 1 && Number(attrH) <= 1) ||
          (box.width > 0 && box.width <= 1 && box.height <= 1);
        // Takes up space on the page. Opacity isn't considered: sliders fade
        // slides in, and those images should still load.
        const rendered =
          img.getClientRects().length > 0 &&
          getComputedStyle(img).visibility !== "hidden" &&
          box.width > 0 &&
          box.height > 0;

        return {
          url: resolved && !resolved.startsWith("data:") ? resolved : "",
          alt: img.getAttribute("alt") || "",
          isPixel,
          rendered,
          loading: !img.complete,
        };
      });
  });

  // Sorts each candidate into broken (FAIL), slow (WARNING) or skipped.
  // Hidden images — inactive popups, src-less placeholders filled in by
  // script, never-requested lazy images — are skipped unless their file
  // itself returned an HTTP error, since that's broken wherever it's used.
  const broken = [];
  const slow = [];
  let skippedPixels = 0;
  let skippedHidden = 0;
  for (const c of candidates) {
    const reason = c.url ? describeImageFailure(c.url, imageRequests) : "no src";
    const httpError = /^HTTP [45]\d\d$/.test(reason);
    const item = { url: c.url || "(no src attribute)", alt: c.alt, reason };
    if (c.isPixel) skippedPixels += 1;
    else if (!c.rendered && !httpError) skippedHidden += 1;
    else if (c.loading && !httpError && !reason.startsWith("network error")) {
      slow.push({ ...item, reason: `still loading after ${IMAGE_SETTLE_TIMEOUT / 1000}s` });
    } else broken.push(item);
  }

  const shown = [...broken, ...slow].slice(0, 8);
  const lines = [];
  if (broken.length) lines.push(`${broken.length} broken image(s)`);
  if (slow.length) lines.push(`${slow.length} image(s) still loading after ${IMAGE_SETTLE_TIMEOUT / 1000}s`);
  if (broken.length + slow.length > shown.length) lines.push(`(showing first ${shown.length})`);
  lines.push(...shown.map((b, i) => `${i + 1}. [${b.reason}] ${b.url}`));
  const skipped = [
    skippedPixels && `${skippedPixels} tracking pixel(s)`,
    skippedHidden && `${skippedHidden} hidden image(s)`,
  ].filter(Boolean);
  if (skipped.length) lines.push(`Skipped ${skipped.join(" and ")}.`);

  const status = broken.length ? "FAIL" : slow.length ? "WARNING" : "PASS";
  const f = finding(
    url, title, "Site Functionality", "All images load successfully", status,
    lines.join("\n"),
    broken.length
      ? "The broken image's source URL won't open (that's the failure) — use the page link below to navigate to where it's used."
      : slow.length
        ? `These hadn't finished downloading after ${IMAGE_SETTLE_TIMEOUT / 1000}s — check their file size and how fast the server responds.`
        : ""
  );
  if (shown.length) {
    // The image src itself is a dead link by definition (that's the failure
    // being reported), so link to the page instead — a reviewer can navigate
    // there and locate the broken image using the src/alt shown in the label.
    f.links = shown.map((b, i) => ({
      label: b.alt
        ? `Image ${i + 1} [${b.reason}] — alt: "${b.alt}" (src: ${b.url})`
        : `Image ${i + 1} [${b.reason}] (src: ${b.url})`,
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
  const { links, skippedPlaceholders } = await page.evaluate((host) => {
    // Hidden links whose href is an unfilled template token — e.g. Cookiebot's
    // consent dialog ships <a href="[#DSR_FORM_URL#]"> and only shows it once
    // a URL is configured. Nobody can click them, so they aren't broken links.
    // A visible one is still checked (and will fail).
    const PLACEHOLDER = /\[#[^\]]*#\]|\{\{[^}]*\}\}|%5B%23|%7B%7B/i;
    let skipped = 0;
    const out = [];
    for (const a of document.querySelectorAll("a[href]")) {
      try {
        if (new URL(a.href).hostname !== host) continue;
      } catch {
        continue;
      }
      if (PLACEHOLDER.test(a.getAttribute("href")) && !a.getClientRects().length) {
        skipped += 1;
        continue;
      }
      out.push(a.href);
    }
    return { links: out, skippedPlaceholders: skipped };
  }, targetHost);

  const uniqueLinks = [...new Set(links)].slice(0, MAX_INTERNAL_LINKS_PER_PAGE);
  const broken = (await Promise.all(uniqueLinks.map((link) => checkLink(context, link, linkState)))).filter(Boolean);

  const label = `Internal links return a non-error status (checked ${uniqueLinks.length}${links.length > uniqueLinks.length ? ` of ${new Set(links).size}` : ""})`;
  const shown = broken.slice(0, 8);
  const f = finding(
    url, title, "Links", label,
    broken.length ? "FAIL" : "PASS",
    [
      ...shown.map((b) => (b.detail ? `${b.status} ${b.link} (${b.detail})` : `${b.status} ${b.link}`)),
      skippedPlaceholders ? `Skipped ${skippedPlaceholders} hidden template placeholder link(s).` : "",
    ].filter(Boolean).join("\n"),
    broken.length ? "Open each link below directly to verify — the exact broken URL is linked." : ""
  );
  if (shown.length) {
    f.links = shown.map((b) => ({ label: `HTTP ${b.status}`, url: b.link }));
  }
  findings.push(f);
}

// --------------------------------------------------------------------------
// Performance — lab timings for the initial load, before any scrolling
// --------------------------------------------------------------------------

function rateAgainst(value, [good, poor]) {
  return value <= good ? "PASS" : value <= poor ? "WARNING" : "FAIL";
}

const formatMs = (ms) => `${(ms / 1000).toFixed(2)} s`;
const formatBytes = (b) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(2)} MB` : `${Math.round(b / 1024)} KB`);

// Reads TTFB and load time from the navigation entry, and LCP/CLS from
// buffered PerformanceObserver entries. Called right after the load event,
// so CLS covers shifts during load only.
function collectPerformance(page) {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        const out = { ttfb: null, load: null, lcp: null, cls: 0 };
        const nav = performance.getEntriesByType("navigation")[0];
        if (nav) {
          out.ttfb = nav.responseStart;
          out.load = nav.loadEventEnd || nav.loadEventStart;
        }
        try {
          new PerformanceObserver((list) => {
            const entries = list.getEntries();
            if (entries.length) out.lcp = entries[entries.length - 1].startTime;
          }).observe({ type: "largest-contentful-paint", buffered: true });
          new PerformanceObserver((list) => {
            for (const e of list.getEntries()) if (!e.hadRecentInput) out.cls += e.value;
          }).observe({ type: "layout-shift", buffered: true });
        } catch {
          /* entry type unsupported — leave the defaults */
        }
        // Buffered entries are delivered asynchronously.
        setTimeout(() => resolve(out), 100);
      })
  );
}

function checkPerformance(url, title, perf, transfer, findings) {
  const note = (status) =>
    status === "PASS"
      ? ""
      : `Lab measurement from the QA host with up to ${PAGE_CONCURRENCY} pages loading in parallel — compare across runs rather than treating it as real-user data.`;
  const add = (check, value, budget, format) => {
    if (value == null) {
      findings.push(finding(url, title, "Performance", check, "NOT TESTED", "Browser did not report this metric"));
      return;
    }
    const status = rateAgainst(value, budget);
    findings.push(
      finding(url, title, "Performance", check, status,
        `${format(value)} (good ≤ ${format(budget[0])}, poor > ${format(budget[1])})`, note(status))
    );
  };

  add("Time to first byte (TTFB)", perf.ttfb, PERF_BUDGETS.ttfbMs, formatMs);
  add("Largest Contentful Paint (LCP)", perf.lcp, PERF_BUDGETS.lcpMs, formatMs);
  add("Cumulative Layout Shift during load (CLS)", perf.cls, PERF_BUDGETS.cls, (v) => v.toFixed(3));
  add("Page load time (load event)", perf.load, PERF_BUDGETS.loadMs, formatMs);
  if (transfer) {
    const status = rateAgainst(transfer.bytes, PERF_BUDGETS.weightBytes);
    findings.push(
      finding(url, title, "Performance", "Page weight on load", status,
        `${formatBytes(transfer.bytes)} transferred across ${transfer.requests} request(s) (good ≤ ${formatBytes(PERF_BUDGETS.weightBytes[0])}, poor > ${formatBytes(PERF_BUDGETS.weightBytes[1])})`,
        status === "PASS" ? "" : "Check for uncompressed images, unused JS/CSS bundles and render-blocking third-party scripts.")
    );
  }
}

// --------------------------------------------------------------------------
// Security — response headers on the page itself, and mixed content
// --------------------------------------------------------------------------

const MIN_HSTS_MAX_AGE = 180 * 24 * 60 * 60; // 180 days, in seconds

function checkSecurityHeaders(url, title, headers, findings) {
  const isHttps = url.startsWith("https://");
  const hsts = headers["strict-transport-security"] || "";
  const csp = headers["content-security-policy"] || "";
  const cspReportOnly = headers["content-security-policy-report-only"] || "";
  const xfo = headers["x-frame-options"] || "";
  const nosniff = (headers["x-content-type-options"] || "").toLowerCase() === "nosniff";

  if (!isHttps) {
    findings.push(finding(url, title, "Security", "Strict-Transport-Security (HSTS) header set", "N/A", "Page is not served over HTTPS"));
  } else if (!hsts) {
    findings.push(
      finding(url, title, "Security", "Strict-Transport-Security (HSTS) header set", "WARNING", "Header missing",
        `Add e.g. "Strict-Transport-Security: max-age=31536000; includeSubDomains" so browsers never fall back to HTTP.`)
    );
  } else {
    const maxAge = parseInt((hsts.match(/max-age=(\d+)/i) || [])[1], 10) || 0;
    const ok = maxAge >= MIN_HSTS_MAX_AGE;
    findings.push(
      finding(url, title, "Security", "Strict-Transport-Security (HSTS) header set", ok ? "PASS" : "WARNING", hsts,
        ok ? "" : `max-age is ${Math.round(maxAge / 86400)} day(s); at least 180 days is recommended.`)
    );
  }

  // A CSP of just "upgrade-insecure-requests" (HubSpot's default) is set but
  // doesn't limit where scripts load from.
  const cspLimitsScripts = /(^|;)\s*(default-src|script-src)\b/i.test(csp);
  if (csp) {
    findings.push(
      finding(url, title, "Security", "Content-Security-Policy header set", cspLimitsScripts ? "PASS" : "WARNING", csp.slice(0, 200),
        cspLimitsScripts ? "" : "Set, but has no default-src or script-src, so it doesn't restrict scripts.")
    );
  } else {
    findings.push(
      finding(url, title, "Security", "Content-Security-Policy header set", "WARNING",
        cspReportOnly ? "Only Content-Security-Policy-Report-Only is set (not enforced)" : "Header missing",
        "A CSP limits where scripts can load from, which blunts XSS.")
    );
  }

  findings.push(
    finding(url, title, "Security", "X-Content-Type-Options: nosniff set", nosniff ? "PASS" : "WARNING",
      nosniff ? "nosniff" : headers["x-content-type-options"] || "Header missing",
      nosniff ? "" : "Stops browsers guessing content types, e.g. running an uploaded file as script.")
  );

  const frameAncestors = /frame-ancestors/i.test(csp);
  const clickjackOk = /^(deny|sameorigin)$/i.test(xfo.trim()) || frameAncestors;
  findings.push(
    finding(url, title, "Security", "Clickjacking protection (X-Frame-Options or CSP frame-ancestors)",
      clickjackOk ? "PASS" : "WARNING",
      clickjackOk ? (frameAncestors ? "CSP frame-ancestors" : `X-Frame-Options: ${xfo}`) : "Neither header set",
      clickjackOk ? "" : "Without it, other sites can embed this page in an iframe and trick users into clicking.")
  );
}

// Resource URLs on an HTTPS page that use plain http://. Chromium blocks or
// auto-upgrades most of these, so the requests seen by the listener miss
// some — the DOM is scanned as well.
async function checkMixedContent(page, url, title, insecureRequests, findings) {
  if (!url.startsWith("https://")) {
    findings.push(finding(url, title, "Security", "No mixed content (HTTP resources on an HTTPS page)", "N/A", "Page is not served over HTTPS"));
    return;
  }
  const fromDom = await page.evaluate(() =>
    Array.from(document.querySelectorAll(
      "img[src], script[src], iframe[src], source[src], video[src], audio[src], embed[src], link[rel~='stylesheet'][href]"
    ))
      .map((el) => el.src || el.href || "")
      .filter((u) => u.startsWith("http:"))
  );
  const insecure = [...new Set([...insecureRequests, ...fromDom])];
  findings.push(
    finding(url, title, "Security", "No mixed content (HTTP resources on an HTTPS page)",
      insecure.length ? "FAIL" : "PASS",
      insecure.length ? [`${insecure.length} insecure resource(s)`, ...insecure.slice(0, 8)].join("\n") : "",
      insecure.length ? "Serve these over https:// — browsers block or warn on them." : "")
  );
}

// --------------------------------------------------------------------------
// Desktop pass — the full checklist, at normal desktop viewport
// --------------------------------------------------------------------------

async function checkPage(context, url, findings, isHomepage, linkState) {
  const page = await context.newPage();
  const consoleErrors = [];
  const failedRequests = [];
  const stagingHosts = new Set();
  const imageRequests = new Map(); // image URL -> { status } or { error }
  const insecureRequests = new Set();
  const targetHost = new URL(url).hostname;
  const isHttps = url.startsWith("https://");

  collectConsoleErrors(page, consoleErrors);
  page.on("response", (resp) => {
    try {
      if (resp.request().resourceType() === "image") imageRequests.set(resp.url(), { status: resp.status() });
      if (resp.status() >= 400) failedRequests.push(`${resp.status()} ${resp.url()}`);
      const host = new URL(resp.url()).hostname || "";
      if (STAGING_HINTS.some((h) => host.includes(h)) && host !== targetHost) {
        stagingHosts.add(host);
      }
    } catch {
      /* ignore malformed URLs */
    }
  });
  page.on("request", (req) => {
    if (isHttps && req.url().startsWith("http:")) insecureRequests.add(req.url());
  });
  page.on("requestfailed", (req) => {
    if (req.resourceType() === "image") {
      imageRequests.set(req.url(), { error: req.failure()?.errorText || "request failed" });
    }
  });

  try {
    // Bytes on the wire, from Chromium's network events (Playwright's own
    // events don't expose transfer size without an extra round-trip per
    // request).
    const transfer = { bytes: 0, requests: 0 };
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    cdp.on("Network.loadingFinished", (e) => {
      transfer.bytes += e.encodedDataLength;
      transfer.requests += 1;
    });

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

    // Measured before scrolling, so lazy-loaded content doesn't count.
    const perf = await collectPerformance(page);
    checkPerformance(url, title, perf, { ...transfer }, findings);
    checkSecurityHeaders(url, title, resp.headers(), findings);

    await scrollThroughPage(page);
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

    // "none" means noindex, nofollow. Expected on a staging/preview domain
    // (HubSpot's *.hs-sites.com sends it), a launch blocker on the live one.
    const metaRobots = await page.evaluate(
      () => document.querySelector('meta[name="robots"]')?.content || ""
    );
    const robotsDirectives = [
      resp.headers()["x-robots-tag"] && `X-Robots-Tag: ${resp.headers()["x-robots-tag"]}`,
      metaRobots && `<meta name="robots" content="${metaRobots}">`,
    ].filter(Boolean);
    const noindex = robotsDirectives.some((d) => /\b(noindex|none)\b/i.test(d.split(/:\s|content=/)[1] || ""));
    findings.push(
      finding(url, title, "SEO", "Page is indexable (no noindex)", noindex ? "WARNING" : "PASS",
        robotsDirectives.join("\n") || "No robots directives",
        noindex ? "Search engines won't index this page. Fine on a staging/preview domain — remove it before go-live." : "")
    );

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

    await checkMixedContent(page, url, title, insecureRequests, findings);
    await checkBrokenImages(page, url, title, findings, imageRequests);
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

// Whether the page scrolls sideways at this viewport, and if so the
// outermost elements sticking out past the right edge. Elements that are
// fixed or inside a container clipping its overflow can't cause page
// overflow, so they're skipped.
function findHorizontalOverflow(page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const vw = root.clientWidth;
    const width = root.scrollWidth;
    const clippedByRoot = [root, document.body].some((el) =>
      ["hidden", "clip"].includes(getComputedStyle(el).overflowX)
    );
    if (width <= vw + 1 || clippedByRoot) return { overflows: false, vw, width, culprits: [] };

    const sticksOut = (el) => el.getBoundingClientRect().right > vw + 1;
    const contained = (el) => {
      if (getComputedStyle(el).position === "fixed") return true;
      for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
        const style = getComputedStyle(a);
        if (style.position === "fixed" || style.overflowX !== "visible") return true;
      }
      return false;
    };
    const describe = (el) => {
      const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : [];
      return el.tagName.toLowerCase() + (el.id ? `#${el.id}` : "") + cls.map((c) => `.${c}`).join("");
    };

    const culprits = [];
    for (const el of document.body.querySelectorAll("*")) {
      if (!el.getBoundingClientRect().width || !sticksOut(el)) continue;
      const parent = el.parentElement;
      if (parent && parent !== document.body && sticksOut(parent)) continue; // report the outermost one
      if (contained(el)) continue;
      culprits.push(`${describe(el)} (right edge at ${Math.round(el.getBoundingClientRect().right)}px)`);
      if (culprits.length >= 5) break;
    }
    return { overflows: true, vw, width, culprits };
  });
}

async function checkResponsiveViewport(browser, url, viewport, findings, screenshotDir, pageIndex) {
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
  const page = await context.newPage();
  const consoleErrors = [];
  collectConsoleErrors(page, consoleErrors);

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

    // Scroll through first so lazy-loaded content shows in the full-page
    // screenshot and counts towards overflow.
    await scrollThroughPage(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(400);

    const overflow = await findHorizontalOverflow(page);
    const overflowSummary = `Page is ${overflow.width}px wide in a ${overflow.vw}px viewport.`;
    findings.push(
      !overflow.overflows
        ? finding(url, title, category, "No horizontal scrolling at this viewport", "PASS")
        : overflow.culprits.length
          ? finding(url, title, category, "No horizontal scrolling at this viewport", "FAIL",
            [`${overflowSummary} Elements sticking out:`, ...overflow.culprits].join("\n"),
            "Usually a fixed width, a wide image/table/embed, or negative margins — check the elements listed.")
          : finding(url, title, category, "No horizontal scrolling at this viewport", "WARNING",
            `${overflowSummary} Couldn't pin it to a single element.`,
            "Open the page at this width in DevTools to find what's overflowing.")
    );

    // Prefixed with the page's position so pages sharing a title don't
    // overwrite each other's screenshots.
    const fileName = `${String(pageIndex + 1).padStart(3, "0")}_${sanitizeForFilename(title || url)}_${sanitizeForFilename(viewport.label)}.png`;
    const filePath = path.join(screenshotDir, fileName);
    const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    const shotHeight = Math.min(pageHeight, MAX_SCREENSHOT_HEIGHT);
    await page.screenshot({
      path: filePath,
      fullPage: true,
      clip: { x: 0, y: 0, width: viewport.width, height: shotHeight },
    });

    findings.push(
      finding(url, title, category, "Full-page screenshot captured", "PASS",
        pageHeight > shotHeight ? `${fileName} (first ${shotHeight}px of ${pageHeight}px)` : fileName, "", filePath)
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
// Site-wide results — reported once instead of on every page
// --------------------------------------------------------------------------

// Checks that usually come from server/CDN config rather than the page, so a
// missing header otherwise shows up as one identical row per page.
const SITE_WIDE_CHECKS = [
  "Strict-Transport-Security (HSTS) header set",
  "Content-Security-Policy header set",
  "X-Content-Type-Options: nosniff set",
  "Clickjacking protection (X-Frame-Options or CSP frame-ancestors)",
  "Page is indexable (no noindex)",
];

// When every page that ran a site-wide check got the same status and
// result, keeps only the first page's row (the homepage, when it loaded)
// and says it applies to all of them. Pages that differ keep their own rows.
function collapseSiteWideFindings(perPage) {
  for (const check of SITE_WIDE_CHECKS) {
    const hits = perPage.flatMap((rows, i) => rows.filter((f) => f.check === check).map((f) => ({ f, i })));
    if (hits.length < 2) continue;
    const same = hits.every(({ f }) => f.status === hits[0].f.status && f.result === hits[0].f.result);
    if (!same) continue;
    const kept = hits[0].f;
    kept.notes = [`Same on all ${hits.length} pages checked.`, kept.notes].filter(Boolean).join(" ");
    for (const { f, i } of hits.slice(1)) perPage[i].splice(perPage[i].indexOf(f), 1);
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
    const detected = await checkRobotsAndSitemap(context, baseUrl, findings);

    // A sitemap set on the project wins and is crawled in full; otherwise
    // crawl the sitemaps found above, falling back to the Yoast / Rank Math
    // default name.
    const sitemapUrls = sitemapUrl ? [sitemapUrl] : detected.sitemaps.length ? detected.sitemaps : [new URL("page-sitemap.xml", baseUrl).toString()];
    const topLevelOnly = !sitemapUrl && detected.topLevelOnly;
    const urls = await discoverPages(context, baseUrl, sitemapUrls, extraPaths, findings, topLevelOnly);

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
    collapseSiteWideFindings(perPage);
    findings.push(...perPage.flat());
    await context.close();
  } finally {
    await browser.close();
  }

  return findings;
}

module.exports = { runQa };
