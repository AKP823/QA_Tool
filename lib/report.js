/**
 * Turns a run's findings into downloadable reports.
 *  - buildXlsx(): color-coded workbook, one sheet per page + a Summary sheet.
 *  - buildPdf(): renders the same data as HTML and prints it to PDF using
 *    Playwright (already a dependency for the runner, so no extra PDF
 *    library needed).
 */
const fs = require("fs");
const ExcelJS = require("exceljs");
const { chromium } = require("playwright");

// Roughly-correct display sizes (px) for each viewport's screenshot so it
// doesn't render huge or tiny in the report — keyed by a substring match
// against the finding's category (e.g. "Responsive - Mobile (390x844)").
function imageDisplaySize(category) {
  if (category.includes("Mobile")) return { width: 180, height: 389 }; // ~390x844 aspect
  if (category.includes("Tablet")) return { width: 260, height: 347 }; // ~768x1024 aspect
  return { width: 240, height: 240 };
}

const STATUS_HEX = {
  PASS: "FFC6EFCE",
  WARNING: "FFFFEB9C",
  FAIL: "FFFFC7CE",
  "NOT TESTED": "FFF2F2F2",
  "N/A": "FFF2F2F2",
};
const STATUS_CSS = {
  PASS: "#C6EFCE",
  WARNING: "#FFEB9C",
  FAIL: "#FFC7CE",
  "NOT TESTED": "#F2F2F2",
  "N/A": "#F2F2F2",
};
const HEADER_FILL = "FF1F3864";

function groupByPage(findings) {
  const pages = new Map();
  for (const f of findings) {
    const key = `${f.pageUrl}||${f.pageTitle || f.pageUrl}`;
    if (!pages.has(key)) pages.set(key, { pageUrl: f.pageUrl, pageTitle: f.pageTitle || f.pageUrl, rows: [] });
    pages.get(key).rows.push(f);
  }
  return [...pages.values()];
}

async function buildXlsx(projectName, baseUrl, run, findings, outPath) {
  const wb = new ExcelJS.Workbook();
  const pages = groupByPage(findings);
  const counts = { PASS: 0, WARNING: 0, FAIL: 0, "NOT TESTED": 0, "N/A": 0 };
  for (const f of findings) counts[f.status] = (counts[f.status] || 0) + 1;

  // --- Summary sheet ---
  const summary = wb.addWorksheet("Summary");
  summary.getColumn(1).width = 22;
  summary.getColumn(2).width = 50;
  summary.getCell("A1").value = `QA Report — ${projectName}`;
  summary.getCell("A1").font = { bold: true, size: 16, color: { argb: "FF1F3864" } };

  const meta = [
    ["Base URL", baseUrl],
    ["Run started", run.started_at],
    ["Run finished", run.finished_at || ""],
    ["Pages checked", String(pages.length)],
  ];
  let r = 3;
  for (const [label, value] of meta) {
    summary.getCell(r, 1).value = label;
    summary.getCell(r, 1).font = { bold: true };
    summary.getCell(r, 2).value = value;
    r += 1;
  }
  r += 1;
  summary.getCell(r, 1).value = "Status counts";
  summary.getCell(r, 1).font = { bold: true };
  r += 1;
  for (const status of ["PASS", "WARNING", "FAIL", "NOT TESTED", "N/A"]) {
    const cell = summary.getCell(r, 1);
    cell.value = status;
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: STATUS_HEX[status] } };
    summary.getCell(r, 2).value = counts[status] || 0;
    r += 1;
  }

  // --- One sheet per page ---
  // Excel worksheet names can't contain * ? : \ / [ ] or exceed 31 chars —
  // a page's title (used as the sheet name) is often blank on failed loads,
  // falling back to its URL, which always contains "/".
  const sanitizeSheetName = (str) => (str || "Page").replace(/[*?:\\/[\]]/g, "-").slice(0, 31) || "Page";
  const usedNames = new Set(["Summary"]);
  for (const { pageUrl, pageTitle, rows } of pages) {
    let name = sanitizeSheetName(pageTitle || pageUrl);
    let i = 1;
    while (usedNames.has(name)) {
      i += 1;
      name = sanitizeSheetName(`${pageTitle || "Page"} ${i}`);
    }
    usedNames.add(name);

    const ws = wb.addWorksheet(name);
    ws.mergeCells("A1:E1");
    ws.getCell("A1").value = pageTitle || pageUrl;
    ws.getCell("A1").font = { bold: true, size: 14, color: { argb: "FF1F3864" } };
    ws.mergeCells("A2:E2");
    ws.getCell("A2").value = pageUrl;
    ws.getCell("A2").font = { italic: true, size: 10, color: { argb: "FF595959" } };

    const headerRow = ws.getRow(4);
    ["Category", "Check", "Status", "Result / Details", "Notes"].forEach((h, i) => {
      const cell = headerRow.getCell(i + 1);
      cell.value = h;
      cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
      cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    });

    let rr = 5;
    for (const f of rows) {
      const row = ws.getRow(rr);
      row.getCell(1).value = f.category;
      row.getCell(2).value = f.check;
      const statusCell = row.getCell(3);
      statusCell.value = f.status;
      statusCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: STATUS_HEX[f.status] || STATUS_HEX["N/A"] } };
      statusCell.font = { bold: true, size: 10 };
      statusCell.alignment = { horizontal: "center", vertical: "middle" };
      row.getCell(4).value = f.result || "";
      row.getCell(5).value = f.notes || "";
      for (let c = 1; c <= 5; c++) {
        if (c !== 3) row.getCell(c).alignment = { vertical: "top", wrapText: true };
      }
      rr += 1;

      // Broken images / links: one clickable hyperlink row per failing URL,
      // so a reviewer can jump straight to the exact asset or page that failed.
      if (f.links && f.links.length) {
        for (const l of f.links) {
          const linkRow = ws.getRow(rr);
          linkRow.getCell(2).value = `↳ ${l.label}`;
          linkRow.getCell(2).font = { italic: true, size: 10, color: { argb: "FF595959" } };
          const cell = linkRow.getCell(4);
          cell.value = { text: l.url, hyperlink: l.url };
          cell.font = { color: { argb: "FF0563C1" }, underline: true, size: 10 };
          cell.alignment = { vertical: "top", wrapText: true };
          rr += 1;
        }
      }
    }

    ws.getColumn(1).width = 20;
    ws.getColumn(2).width = 34;
    ws.getColumn(3).width = 13;
    ws.getColumn(4).width = 48;
    ws.getColumn(5).width = 34;
    ws.views = [{ state: "frozen", ySplit: 4 }];

    // Embed any screenshots captured for this page (mobile/tablet passes)
    // below the findings table.
    const shots = rows.filter((f) => f.screenshotPath && fs.existsSync(f.screenshotPath));
    if (shots.length) {
      let shotRow = rr + 2;
      ws.getCell(shotRow, 1).value = "Screenshots";
      ws.getCell(shotRow, 1).font = { bold: true, size: 12, color: { argb: "FF1F3864" } };
      shotRow += 1;
      let shotCol = 1; // column A, columns advance per screenshot
      const colStep = 6; // ~6 default-width columns of horizontal space per image
      for (const shot of shots) {
        const { width, height } = imageDisplaySize(shot.category);
        ws.getCell(shotRow, shotCol).value = shot.category;
        ws.getCell(shotRow, shotCol).font = { italic: true, size: 10, color: { argb: "FF595959" } };
        const imageId = wb.addImage({ filename: shot.screenshotPath, extension: "png" });
        ws.addImage(imageId, {
          tl: { col: shotCol - 1, row: shotRow },
          ext: { width, height },
        });
        shotCol += colStep;
      }
    }
  }

  await wb.xlsx.writeFile(outPath);
}

function renderHtmlReport(projectName, baseUrl, run, findings) {
  const pages = groupByPage(findings);
  const counts = { PASS: 0, WARNING: 0, FAIL: 0, "NOT TESTED": 0, "N/A": 0 };
  for (const f of findings) counts[f.status] = (counts[f.status] || 0) + 1;

  const statusSpan = (s) =>
    `<span style="background:${STATUS_CSS[s] || "#eee"};padding:2px 8px;border-radius:4px;font-weight:bold;">${s}</span>`;

  const escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // Broken images/links carry an explicit list of {label, url}: render each as
  // its own clickable link so a reviewer can jump straight to the exact
  // failing asset or page instead of parsing a semicolon-joined string.
  const resultCell = (f) => {
    if (f.links && f.links.length) {
      return f.links
        .map(
          (l) =>
            `<a href="${escapeHtml(l.url)}" target="_blank" rel="noopener">${escapeHtml(l.label)}: ${escapeHtml(l.url)}</a>`
        )
        .join("<br/>");
    }
    return escapeHtml(f.result || "").replace(/\n/g, "<br/>");
  };

  const pagesHtml = pages
    .map(({ pageUrl, pageTitle, rows }) => {
      const rowsHtml = rows
        .map(
          (f) =>
            `<tr><td>${f.category}</td><td>${f.check}</td><td>${statusSpan(f.status)}</td><td>${resultCell(f)}</td><td>${f.notes || ""}</td></tr>`
        )
        .join("");

      const shots = rows.filter((f) => f.screenshotPath && fs.existsSync(f.screenshotPath));
      const shotsHtml = shots.length
        ? `<div class="shots">
            <h3>Screenshots</h3>
            <div class="shot-row">
              ${shots
                .map((f) => {
                  const b64 = fs.readFileSync(f.screenshotPath).toString("base64");
                  const wide = f.category.includes("Tablet");
                  return `<div class="shot"><img src="data:image/png;base64,${b64}" style="width:${wide ? 200 : 140}px;"/><div class="shot-caption">${f.category}</div></div>`;
                })
                .join("")}
            </div>
          </div>`
        : "";

      return `
        <h2>${pageTitle || pageUrl}</h2>
        <p style="color:#666;font-size:12px;">${pageUrl}</p>
        <table>
          <tr><th>Category</th><th>Check</th><th>Status</th><th>Result / Details</th><th>Notes</th></tr>
          ${rowsHtml}
        </table>
        ${shotsHtml}`;
    })
    .join("");

  const countsHtml = ["PASS", "WARNING", "FAIL", "NOT TESTED", "N/A"]
    .map((s) => `<div><b>${s}:</b> ${counts[s] || 0}</div>`)
    .join("");

  return `
  <html><head><meta charset="utf-8"><style>
    body { font-family: Arial, sans-serif; color: #1a1a1a; margin: 40px; }
    h1 { color: #1F3864; }
    h2 { color: #1F3864; margin-top: 30px; border-bottom: 2px solid #1F3864; padding-bottom: 4px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 12px; }
    th { background: #1F3864; color: white; padding: 6px; text-align: left; }
    td { padding: 6px; border: 1px solid #ccc; vertical-align: top; }
    td a { color: #0563C1; word-break: break-all; }
    .meta { color: #555; font-size: 13px; margin-bottom: 20px; }
    .counts { display: flex; gap: 20px; margin-bottom: 20px; }
    .shots h3 { color: #1F3864; font-size: 14px; margin-bottom: 8px; }
    .shot-row { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 24px; }
    .shot { text-align: center; }
    .shot img { border: 1px solid #ccc; border-radius: 4px; display: block; }
    .shot-caption { font-size: 11px; color: #666; margin-top: 4px; }
  </style></head>
  <body>
    <h1>QA Report — ${projectName}</h1>
    <div class="meta">
      <div><b>Base URL:</b> ${baseUrl}</div>
      <div><b>Run started:</b> ${run.started_at}</div>
      <div><b>Run finished:</b> ${run.finished_at || ""}</div>
    </div>
    <div class="counts">${countsHtml}</div>
    ${pagesHtml}
  </body></html>`;
}

async function buildPdf(projectName, baseUrl, run, findings, outPath) {
  const html = renderHtmlReport(projectName, baseUrl, run, findings);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    await page.pdf({
      path: outPath,
      format: "A4",
      printBackground: true,
      margin: { top: "20px", bottom: "20px", left: "20px", right: "20px" },
    });
  } finally {
    await browser.close();
  }
}

module.exports = { buildXlsx, buildPdf, renderHtmlReport };
