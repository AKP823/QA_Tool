/**
 * Site-discovery helpers for the auto-crawl feature: sitemap parsing,
 * nav-link extraction, and the bounded crawl queue that decides which pages
 * get the full checklist. Kept separate from runner.js (the check engine)
 * since this is "what to check," not "how to check a page."
 */
const MAX_CHILD_SITEMAPS = 5;
const MAX_SITEMAP_URLS = 200;
const SITEMAP_FETCH_TIMEOUT = 15000;

function normalizeUrl(rawUrl, baseUrl) {
  let u;
  try {
    u = new URL(rawUrl, baseUrl);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  u.hash = "";
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
    u.pathname = u.pathname.slice(0, -1);
  }
  return u.toString();
}

async function fetchText(context, url, timeout) {
  try {
    const resp = await context.request.get(url, { timeout });
    if (!resp.ok()) return "";
    return await resp.text();
  } catch {
    return "";
  }
}

function extractLocs(xmlText) {
  return [...xmlText.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((m) => m[1].trim());
}

// Fetches /sitemap.xml (following one level of sitemap-index nesting) and
// returns same-host page URLs. Never throws — no sitemap is a normal case.
async function parseSitemapLocs(context, baseUrl) {
  const targetHost = new URL(baseUrl).hostname;
  const sitemapUrl = new URL("/sitemap.xml", baseUrl).toString();
  const xmlText = await fetchText(context, sitemapUrl, SITEMAP_FETCH_TIMEOUT);
  if (!xmlText) return [];

  const locs = extractLocs(xmlText);
  if (!locs.length) return [];

  const isIndex = /<sitemapindex[\s>]/i.test(xmlText);
  let rawUrls = locs;
  if (isIndex) {
    rawUrls = [];
    for (const childUrl of locs.slice(0, MAX_CHILD_SITEMAPS)) {
      const childXml = await fetchText(context, childUrl, SITEMAP_FETCH_TIMEOUT);
      if (childXml) rawUrls.push(...extractLocs(childXml));
    }
  }

  const seen = new Set();
  const urls = [];
  for (const raw of rawUrls) {
    const normalized = normalizeUrl(raw, baseUrl);
    if (!normalized || seen.has(normalized)) continue;
    try {
      if (new URL(normalized).hostname !== targetHost) continue;
    } catch {
      continue;
    }
    seen.add(normalized);
    urls.push(normalized);
    if (urls.length >= MAX_SITEMAP_URLS) break;
  }
  return urls;
}

// Reads the main nav/header links from an already-loaded page.
async function discoverNavLinks(page, targetHost) {
  const hrefs = await page.evaluate(
    () => Array.from(document.querySelectorAll("nav a, header a")).map((a) => a.href)
  );
  return hrefs.filter((href) => {
    try {
      return new URL(href).hostname === targetHost;
    } catch {
      return false;
    }
  });
}

// Merges discovery sources into a bounded crawl queue. Mandatory sources
// (homepage, nav links, manually-configured extra paths) are always
// included even if that alone exceeds maxPages; sitemap URLs only fill
// whatever budget is left.
function buildCrawlQueue({ baseUrl, navUrls = [], extraPathUrls = [], sitemapUrls = [], maxPages }) {
  const seen = new Set();
  const queue = [];
  let mandatoryCount = 0;
  let sitemapCount = 0;
  let sitemapExcluded = 0;

  const addMandatory = (url) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    queue.push(url);
    mandatoryCount++;
  };

  addMandatory(baseUrl);
  for (const url of navUrls) addMandatory(url);
  for (const url of extraPathUrls) addMandatory(url);

  for (const url of sitemapUrls) {
    if (seen.has(url)) continue;
    if (queue.length >= maxPages) {
      sitemapExcluded++;
      continue;
    }
    seen.add(url);
    queue.push(url);
    sitemapCount++;
  }

  return { queue, mandatoryCount, sitemapCount, sitemapExcluded };
}

// HEAD-then-GET status check for an external link, cached in `registry` so
// the same URL is never checked twice across a run.
async function checkExternalLink(context, link, registry, timeout = 8000) {
  if (registry.has(link)) return registry.get(link);
  let result;
  try {
    let resp = await context.request.fetch(link, { method: "HEAD", timeout });
    if (resp.status() === 405 || resp.status() === 501) {
      resp = await context.request.fetch(link, { method: "GET", timeout });
    }
    result = { ok: resp.status() < 400, status: String(resp.status()) };
  } catch (e) {
    result = { ok: false, status: "ERROR", detail: e.message.slice(0, 60) };
  }
  registry.set(link, result);
  return result;
}

module.exports = { normalizeUrl, parseSitemapLocs, discoverNavLinks, buildCrawlQueue, checkExternalLink };
