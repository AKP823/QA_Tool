# QA Tool

A self-hosted QA automation tool built with Next.js and Playwright. Create a
project, point it at a base URL, click **Run**, and get a color-coded QA
report — Excel or PDF — covering connectivity, SSL, broken links, console
errors, SEO basics, and responsive rendering across your pages. Every run is
stored in a local SQLite database, so a **Consolidated** view on each project
page shows the latest status of every check across all runs.

## What gets checked

Each run drives real headless Chromium sessions against your project's
base URL and any extra paths you configure:

- **Connectivity** — page loads, correct HTTP status
- **SSL/TLS** — served over HTTPS
- **Site Functionality** — nav present, no assets pointing at staging/dev
  hosts, **every `<img>` on the page actually loaded** (no broken images)
- **Console/JS Errors** — no console errors, no failed (4xx/5xx) network requests
- **Links** — **every internal link found on the page returns a
  non-error status** (crawls up to 25 same-host links per page; flags
  404s and similar)
- **SEO** — robots.txt / sitemap.xml present and valid, title / meta
  description / canonical tag present per page
- **Responsive — Mobile (390×844)** and **Responsive — Tablet
  (768×1024)** — re-loads every page at each viewport, confirms it still
  loads with no new console errors, and **captures a screenshot** —
  embedded directly into both the Excel and PDF reports so you can see
  what the page actually looked like at that size, not just a pass/fail

Screenshots are also saved as plain PNG files under
`reports/run_<id>/screenshots/` if you want to look at them outside the
report. The internal-link crawl is capped at 25 links per page to keep
runs fast — raise `MAX_INTERNAL_LINKS_PER_PAGE` in `lib/runner.js` if you
want deeper coverage.

## Setup

Requires Node.js 18+ (Node 20/22 recommended).

```bash
npm install
npx playwright install chromium   # downloads the browser binary Playwright drives
```

`npx playwright install chromium` needs internet access to Playwright's CDN
— only needs to be done once per machine.

## Run it

```bash
npm run dev
```

Then open **http://localhost:3000**.

- **New Project** — name, base URL, and optional extra paths (one per line).
- **Run QA Checks** — kicks off a background run; the page auto-refreshes
  until it's done.
- **Excel / PDF** — download the report for any completed run.
- **Consolidated** — latest result per check across all runs.

For a long-running/production setup, build and start instead of `dev`:

```bash
npm run build
npm run start
```

## Data

Stored in `data/qa_tool.db` (SQLite) and `reports/` (generated files) —
both created automatically on first run.

## Deploying for real use

- This runs a run in the background on the same Node process
  (`executeRun()` in `lib/runs.js`, not awaited) — fine for `next start` on
  a normal server/VM, since the process stays alive after the response is
  sent. It will **not** work as-is on a serverless platform (e.g. Vercel
  functions) that freezes the process after the response — for that,
  you'd move the run itself into a real background worker or queue
  (e.g. a small separate Node process, or a queue like BullMQ + Redis).
- Swap SQLite for Postgres if more than one person needs concurrent write
  access at scale.
- Put it behind a reverse proxy (nginx/Caddy) with HTTPS and basic auth if
  it's reachable outside your network.
- Add scheduled runs via cron calling `POST /api/projects/{id}/run`.

## Extending the checklist

Every check lives in `lib/runner.js` as a plain async function pushing
finding objects into an array — follow the same pattern to add new checks
(mobile-viewport screenshots, auth-flow testing, accessibility, etc.).
