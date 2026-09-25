import db from "../../../lib/db";
import { getConsolidated } from "../../../lib/runs";

export default async function ProjectPage({ params }) {
  const projectId = Number((await params).id);
  const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId);
  const runs = db
    .prepare("SELECT * FROM runs WHERE project_id = ? ORDER BY started_at DESC")
    .all(projectId);
  const consolidated = getConsolidated(projectId);

  if (!project) {
    return (
      <div className="container">
        <p>Project not found.</p>
      </div>
    );
  }

  const anyInProgress = runs.some((r) => r.status === "queued" || r.status === "running");
  // Runs are ordered newest-first, so the latest run is #1 and older ones
  // count up from there — this is a display-only number, not the DB id.
  const runNumberById = new Map(runs.map((r, i) => [r.id, i + 1]));

  return (
    <div className="container">
      <a href="/" className="back-link">
        &larr; All projects
      </a>
      <h1>{project.name}</h1>
      <p className="subtitle">
        <a href={project.base_url} target="_blank" rel="noreferrer">
          {project.base_url}
        </a>
      </p>

      <form method="post" action={`/api/projects/${project.id}/run`}>
        <button type="submit" className="run-btn">
          ▶ Run QA Checks
        </button>
      </form>
      <p className="hint">
        A run checks the homepage plus any extra pages configured for this project. This page
        auto-refreshes while a run is in progress.
      </p>

      <h2>Run History</h2>
      {runs.length > 0 ? (
        <table className="list-table">
          <tbody>
            <tr>
              <th>#</th>
              <th>Status</th>
              <th>Started</th>
              <th>Finished</th>
              <th>Reports</th>
            </tr>
            {runs.map((r, i) => (
              <tr key={r.id}>
                <td>{i + 1}</td>
                <td>
                  <span className={`badge badge-${r.status}`}>{r.status}</span>
                </td>
                <td>{new Date(r.started_at).toLocaleString()}</td>
                <td>{r.finished_at ? new Date(r.finished_at).toLocaleString() : "—"}</td>
                <td>
                  {r.status === "done" ? (
                    <a href={`/runs/${r.id}`}>View Report</a>
                  ) : r.status === "failed" ? (
                    <span className="error-text" title={r.error || ""}>
                      error — hover for details
                    </span>
                  ) : (
                    "in progress…"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="empty">No runs yet — click &quot;Run QA Checks&quot; above.</p>
      )}

      <h2>Consolidated — latest status per check</h2>
      <p className="hint">
        Across all completed runs, this shows the most recent result for every (page, check)
        combination — useful for spotting regressions or confirming fixes.
      </p>
      {consolidated.length > 0 ? (
        <table className="list-table">
          <tbody>
            <tr>
              <th>Page</th>
              <th>Category</th>
              <th>Check</th>
              <th>Status</th>
              <th>Result</th>
              <th>From run</th>
            </tr>
            {consolidated.map((row, i) => (
              <tr key={i}>
                <td className="small">{row.pageUrl}</td>
                <td>{row.category}</td>
                <td>{row.check}</td>
                <td>
                  <span className={`badge badge-status-${row.status.replace(/ /g, "_")}`}>
                    {row.status}
                  </span>
                </td>
                <td className="small">{row.result}</td>
                <td>
                  <a href={`/runs/${row.runId}`}>#{runNumberById.get(row.runId) ?? row.runId}</a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="empty">No completed runs yet.</p>
      )}

      {anyInProgress && (
        <script
          // Auto-refresh while a run is queued/running, same as the Python version.
          dangerouslySetInnerHTML={{ __html: "setTimeout(() => window.location.reload(), 4000);" }}
        />
      )}
    </div>
  );
}
