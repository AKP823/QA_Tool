import db from "../lib/db";

// Reads from SQLite on every request — never prerender at build time.
export const dynamic = "force-dynamic";

export default function HomePage() {
  const projects = db.prepare("SELECT * FROM projects ORDER BY created_at DESC").all();

  return (
    <div className="container">
      <h1>QA NFT Tool</h1>
      <p className="subtitle">
        Automated website QA checks — connectivity, SSL, functionality, console errors, and SEO —
        run on demand, tracked over time.
      </p>

      <div className="card">
        <h2>New Project</h2>
        <form method="post" action="/api/projects">
          <label>
            Project name
            <input type="text" name="name" placeholder="Marketing site" required />
          </label>
          <label>
            Base URL
            <input type="url" name="base_url" placeholder="https://example.com/" required />
          </label>
          <label>
            Sitemap URL (optional — auto-detected for Yoast, Rank Math and WordPress core)
            <input type="url" name="sitemap_url" placeholder="https://example.com/page-sitemap.xml" />
          </label>
          <label>
            Extra pages to check (one path per line, optional)
            <textarea name="extra_paths" rows={3} placeholder={"/about\n/pricing\n/contact"} />
          </label>
          <button type="submit">Create Project</button>
        </form>
      </div>

      <h2>Projects</h2>
      {projects.length > 0 ? (
        <table className="list-table">
          <tbody>
            <tr>
              <th>Name</th>
              <th>Base URL</th>
              <th>Created</th>
              <th className="actions-col"></th>
            </tr>
            {projects.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td>
                  <a href={p.base_url} target="_blank" rel="noreferrer">
                    {p.base_url}
                  </a>
                </td>
                <td>{new Date(p.created_at).toLocaleString()}</td>
                <td className="actions-cell">
                  <a href={`/projects/${p.id}`}>
                    <button>Open</button>
                  </a>
                  <form method="post" action={`/api/projects/${p.id}/delete`} className="delete-form">
                    <button type="submit" className="icon-btn" title="Delete project" aria-label="Delete project">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="3 6 5 6 21 6"></polyline>
                        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                        <path d="M10 11v6" />
                        <path d="M14 11v6" />
                        <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                      </svg>
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="empty">No projects yet — create one above.</p>
      )}

      {projects.length > 0 && (
        <script
          dangerouslySetInnerHTML={{
            __html:
              "document.querySelectorAll('.delete-form').forEach(function(f){f.addEventListener('submit', function(e){ if(!confirm('Delete this project and all its runs and reports? This cannot be undone.')) e.preventDefault(); }); });",
          }}
        />
      )}
    </div>
  );
}
