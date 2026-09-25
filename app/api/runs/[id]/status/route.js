import { NextResponse } from "next/server";
import db from "../../../../../lib/db";

export async function GET(request, { params }) {
  const run = db.prepare("SELECT id, status, error FROM runs WHERE id = ?").get(Number((await params).id));
  if (!run) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(run);
}
