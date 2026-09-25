/**
 * Executes one QA run for a project: calls the runner, saves findings to
 * the database, then generates the xlsx/pdf reports. Used by the
 * /api/projects/[id]/run route — kicked off in the background so the
 * button click returns instantly instead of making the user wait for the
 * whole browser-automation run to finish.
 */
const path = require("path");
const fs = require("fs");
const db = require("./db");
const { runQa } = require("./runner");
const { buildXlsx, buildPdf } = require("./report");

const REPORTS_DIR = path.join(process.cwd(), "reports");
fs.mkdirSync(REPORTS_DIR, { recursive: true });

const RUNS_TO_KEEP = 3;

// Removes a run's generated report files (xlsx, pdf, screenshots dir) from
// disk. DB rows are handled separately by the caller.
function removeRunFiles(runId) {
  fs.rmSync(path.join(REPORTS_DIR, `run_${runId}`), { recursive: true, force: true });
  fs.rmSync(path.join(REPORTS_DIR, `run_${runId}.xlsx`), { force: true });
  fs.rmSync(path.join(REPORTS_DIR, `run_${runId}.pdf`), { force: true });
}

// Only the most recent RUNS_TO_KEEP runs (of any status) are kept per
// project — older runs' DB rows and report files (xlsx/pdf/screenshots) are
// deleted so reports don't accumulate forever.
function pruneOldRuns(projectId, keep = RUNS_TO_KEEP) {
  const runs = db
    .prepare("SELECT id FROM runs WHERE project_id = ? ORDER BY started_at DESC")
    .all(projectId);
  const stale = runs.slice(keep);
  if (!stale.length) return;

  const deleteFindings = db.prepare("DELETE FROM findings WHERE run_id = ?");
  const deleteRun = db.prepare("DELETE FROM runs WHERE id = ?");
  const tx = db.transaction((ids) => {
    for (const id of ids) {
      deleteFindings.run(id);
      deleteRun.run(id);
    }
  });
  tx(stale.map((r) => r.id));

  for (const r of stale) removeRunFiles(r.id);
}

async function executeRun(runId) {
  const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(runId);
  const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(run.project_id);

  db.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(runId);

  try {
    const extraPaths = (project.extra_paths || "").split("\n").filter((p) => p.trim());
    const screenshotDir = path.join(REPORTS_DIR, `run_${runId}`, "screenshots");
    const findings = await runQa(project.base_url, project.sitemap_url, extraPaths, screenshotDir);

    const insert = db.prepare(`
      INSERT INTO findings (run_id, page_url, page_title, category, check_name, status, result, notes, screenshot_path)
      VALUES (@runId, @pageUrl, @pageTitle, @category, @check, @status, @result, @notes, @screenshotPath)
    `);
    const insertMany = db.transaction((rows) => {
      for (const f of rows) insert.run({ runId, ...f });
    });
    insertMany(findings);

    const finishedAt = new Date().toISOString();
    db.prepare("UPDATE runs SET status = 'done', finished_at = ? WHERE id = ?").run(finishedAt, runId);

    const updatedRun = db.prepare("SELECT * FROM runs WHERE id = ?").get(runId);
    const xlsxPath = path.join(REPORTS_DIR, `run_${runId}.xlsx`);
    const pdfPath = path.join(REPORTS_DIR, `run_${runId}.pdf`);
    await buildXlsx(project.name, project.base_url, updatedRun, findings, xlsxPath);
    await buildPdf(project.name, project.base_url, updatedRun, findings, pdfPath);

    db.prepare("UPDATE runs SET xlsx_path = ?, pdf_path = ? WHERE id = ?").run(xlsxPath, pdfPath, runId);
  } catch (e) {
    db.prepare("UPDATE runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?").run(
      String(e.message || e),
      new Date().toISOString(),
      runId
    );
  } finally {
    pruneOldRuns(run.project_id);
  }
}

function getConsolidated(projectId) {
  const runs = db
    .prepare("SELECT * FROM runs WHERE project_id = ? AND status = 'done' ORDER BY started_at ASC")
    .all(projectId);

  const latest = new Map();
  for (const run of runs) {
    const findings = db.prepare("SELECT * FROM findings WHERE run_id = ?").all(run.id);
    for (const f of findings) {
      const key = `${f.page_url}||${f.category}||${f.check_name}`;
      latest.set(key, {
        pageUrl: f.page_url,
        category: f.category,
        check: f.check_name,
        status: f.status,
        result: f.result,
        runId: run.id,
        runDate: run.started_at,
      });
    }
  }
  const order = ["FAIL", "WARNING", "NOT TESTED", "N/A", "PASS"];
  return [...latest.values()].sort((a, b) => {
    const ai = order.indexOf(a.status);
    const bi = order.indexOf(b.status);
    return ai - bi || a.pageUrl.localeCompare(b.pageUrl);
  });
}

module.exports = { executeRun, getConsolidated, pruneOldRuns, removeRunFiles, REPORTS_DIR };
