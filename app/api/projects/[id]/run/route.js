import { NextResponse } from "next/server";
import db from "../../../../../lib/db";
import { executeRun } from "../../../../../lib/runs";

export async function POST(request, { params }) {
  const projectId = Number(params.id);
  const result = db
    .prepare("INSERT INTO runs (project_id, status, started_at) VALUES (?, 'queued', ?)")
    .run(projectId, new Date().toISOString());
  const runId = result.lastInsertRowid;

  // Fire-and-forget: don't await this. The response returns immediately so
  // the button click feels instant; the run keeps executing in the
  // background on this same long-lived Node process (this is `next dev` /
  // `next start`, not a serverless function that gets frozen after the
  // response — so this is safe here).
  executeRun(runId).catch((e) => console.error("Run failed:", e));

  return NextResponse.redirect(new URL(`/projects/${projectId}`, request.url), 303);
}
