/**
 * Database layer. Uses better-sqlite3 — a real SQLite file on disk, no
 * separate database server to install or run. Everything here is
 * synchronous, which keeps the calling code simple (no await needed for
 * plain reads/writes).
 */
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const DATA_DIR = path.join(process.cwd(), "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "qa_tool.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    extra_paths TEXT DEFAULT '',
    sitemap_url TEXT DEFAULT '',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'queued',
    started_at TEXT NOT NULL,
    finished_at TEXT,
    error TEXT,
    xlsx_path TEXT,
    pdf_path TEXT
  );

  CREATE TABLE IF NOT EXISTS findings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    page_url TEXT NOT NULL,
    page_title TEXT DEFAULT '',
    category TEXT NOT NULL,
    check_name TEXT NOT NULL,
    status TEXT NOT NULL,
    result TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    screenshot_path TEXT DEFAULT ''
  );
`);

// Simple migration: if this is an existing database from before the
// screenshot feature was added, the findings table won't have the column
// yet. CREATE TABLE IF NOT EXISTS above doesn't add columns to a table
// that already exists, so check for it explicitly and add it if missing.
const findingsColumns = db.prepare("PRAGMA table_info(findings)").all().map((c) => c.name);
if (!findingsColumns.includes("screenshot_path")) {
  db.exec("ALTER TABLE findings ADD COLUMN screenshot_path TEXT DEFAULT ''");
}

// Same idea for projects created before sitemap-based page discovery.
const projectColumns = db.prepare("PRAGMA table_info(projects)").all().map((c) => c.name);
if (!projectColumns.includes("sitemap_url")) {
  db.exec("ALTER TABLE projects ADD COLUMN sitemap_url TEXT DEFAULT ''");
}

module.exports = db;
