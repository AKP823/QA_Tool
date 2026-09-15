import { NextResponse } from "next/server";
import db from "../../../../../lib/db";
import { removeRunFiles } from "../../../../../lib/runs";

export async function POST(request, { params }) {
  const projectId = Number(params.id);

  const runs = db.prepare("SELECT id FROM runs WHERE project_id = ?").all(projectId);
  for (const r of runs) removeRunFiles(r.id);

  const del = db.transaction((id) => {
    db.prepare("DELETE FROM findings WHERE run_id IN (SELECT id FROM runs WHERE project_id = ?)").run(id);
    db.prepare("DELETE FROM runs WHERE project_id = ?").run(id);
    db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  });
  del(projectId);

  return NextResponse.redirect(new URL("/", request.url), 303);
}
