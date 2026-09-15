import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import db from "../../../../../lib/db";

export async function GET(request, { params }) {
  const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(Number(params.id));
  if (!run || !run.xlsx_path || !fs.existsSync(run.xlsx_path)) {
    return new NextResponse("Report not ready yet.", { status: 404 });
  }
  const buffer = fs.readFileSync(run.xlsx_path);
  return new NextResponse(buffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${path.basename(run.xlsx_path)}"`,
    },
  });
}
