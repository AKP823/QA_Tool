import { NextResponse } from "next/server";
import db from "../../../lib/db";

export async function POST(request) {
  const form = await request.formData();
  const name = (form.get("name") || "").toString().trim();
  const baseUrl = (form.get("base_url") || "").toString().trim();
  const extraPaths = (form.get("extra_paths") || "").toString().trim();
  const sitemapUrl = (form.get("sitemap_url") || "").toString().trim();

  const result = db
    .prepare("INSERT INTO projects (name, base_url, extra_paths, sitemap_url, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(name, baseUrl, extraPaths, sitemapUrl, new Date().toISOString());

  return NextResponse.redirect(new URL(`/projects/${result.lastInsertRowid}`, request.url), 303);
}
