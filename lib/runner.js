/**
 * The actual QA engine. Given a base URL + extra paths, drives real headless
 * Chromium browser contexts and returns an array of finding objects:
 *
 *   { pageUrl, pageTitle, category, check, status, result, notes, screenshotPath? }
 *
 * status is one of: PASS, WARNING, FAIL, NOT TESTED, N/A
 *
 * Checks, by category:
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

const VIEWPORTS = [
  { label: "Mobile (390x844)", width: 390, height: 844 },
  { label: "Tablet (768x1024)", width: 768, height: 1024 },
];

function finding(pageUrl, pageTitle, category, check, status, result = "", notes = "", screenshotPath = "") {
  return { pageUrl, pageTitle, category, check, status, result, notes, screenshotPath };
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

async function checkInternalLinks(context, page, url, title, targetHost, findings) {
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
  const broken = [];

  for (const link of uniqueLinks) {
    try {
      let resp = await context.request.fetch(link, { method: "HEAD", timeout: LINK_CHECK_TIMEOUT });
      if (resp.status() === 405 || resp.status() === 501) {
        // Some servers don't support HEAD — retry with GET before giving up.
        resp = await context.request.fetch(link, { method: "GET", timeout: LINK_CHECK_TIMEOUT });
      }
      if (resp.status() >= 400) broken.push({ status: String(resp.status()), link });
    } catch (e) {
      broken.push({ status: "ERROR", link, detail: e.message.slice(0, 60) });
    }
  }

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

async function checkPage(context, url, findings, isHomepage = false) {
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
    await checkInternalLinks(context, page, url, title, targetHost, findings);
  } catch (e) {
    findings.push(finding(url, "", "Connectivity", "Page loads successfully", "FAIL", e.message));
  } finally {
    await page.close();
  }
}

// --------------------------------------------------------------------------
// Responsive pass — re-check a page at a smaller viewport, with a screenshot
// --------------------------------------------------------------------------

async function checkResponsiveViewport(browser, url, viewport, findings, screenshotDir) {
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

    const fileName = `${sanitizeForFilename(title || url)}_${sanitizeForFilename(viewport.label)}.png`;
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
    findings.push(finding(url, "", category, "Page loads at this viewport", "FAIL", e.message));
  } finally {
    await page.close();
    await context.close();
  }
}

// --------------------------------------------------------------------------
// Entry point
// --------------------------------------------------------------------------

async function runQa(baseUrl, extraPaths, screenshotDir) {
  const findings = [];
  fs.mkdirSync(screenshotDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await checkRobotsAndSitemap(context, baseUrl, findings);

    const urls = [baseUrl, ...extraPaths.map((p) => p.trim()).filter(Boolean).map((p) => new URL(p, baseUrl).toString())];

    for (let i = 0; i < urls.length; i++) {
      await checkPage(context, urls[i], findings, i === 0);
    }
    await context.close();

    // Responsive pass: re-check every page at mobile and tablet sizes.
    for (const url of urls) {
      for (const viewport of VIEWPORTS) {
        await checkResponsiveViewport(browser, url, viewport, findings, screenshotDir);
      }
    }
  } finally {
    await browser.close();
  }

  return findings;
}

module.exports = { runQa };
