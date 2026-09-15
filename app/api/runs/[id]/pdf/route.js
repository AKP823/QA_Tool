import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import db from "../../../../../lib/db";

export async function GET(request, { params }) {
  const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(Number(params.id));
  if (!run || !run.pdf_path || !fs.existsSync(run.pdf_path)) {
    return new NextResponse("Report not ready yet.", { status: 404 });
  }
  const inline = new URL(request.url).searchParams.get("inline") === "1";
  const buffer = fs.readFileSync(run.pdf_path);
  return new NextResponse(buffer, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${path.basename(run.pdf_path)}"`,
    },
  });
}
