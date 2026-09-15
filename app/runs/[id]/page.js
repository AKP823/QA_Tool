import db from "../../../lib/db";

export default function RunReportPage({ params }) {
  const runId = Number(params.id);
  const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(runId);

  if (!run) {
    return (
      <div className="container">
        <p>Run not found.</p>
      </div>
    );
  }

  const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(run.project_id);
  const projectRunIds = db
    .prepare("SELECT id FROM runs WHERE project_id = ? ORDER BY started_at DESC")
    .all(run.project_id)
    .map((r) => r.id);
  const runNumber = projectRunIds.indexOf(run.id) + 1;

  if (run.status !== "done" || !run.pdf_path) {
    return (
      <div className="container">
        <a href={`/projects/${run.project_id}`} className="back-link">
          &larr; Back to {project ? project.name : "project"}
        </a>
        <h1>Report not ready</h1>
        <p className="hint">This run hasn&apos;t finished yet, or it failed before a report was generated.</p>
      </div>
    );
  }

  return (
    <div className="container report-view">
      <a href={`/projects/${run.project_id}`} className="back-link">
        &larr; Back to {project ? project.name : "project"}
      </a>
      <h1>Report — Run #{runNumber}</h1>
      <p className="subtitle">
        {project ? project.name : ""} &middot; started {new Date(run.started_at).toLocaleString()}
      </p>

      <div className="report-actions">
        <a href={`/api/runs/${run.id}/pdf`}>
          <button>⬇ Download PDF</button>
        </a>
        <a href={`/api/runs/${run.id}/xlsx`}>
          <button>⬇ Download Excel</button>
        </a>
      </div>

      <p className="hint">Preview below — use the buttons above to download the full PDF or Excel report.</p>
      <iframe src={`/api/runs/${run.id}/pdf?inline=1`} title={`Run ${run.id} report`} />
    </div>
  );
}
