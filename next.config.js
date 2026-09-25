/** @type {import('next').NextConfig} */
const nextConfig = {
  // better-sqlite3 and playwright are native/Node-only modules — keep them
  // out of the client bundle and don't let Next try to trace/bundle them.
  serverExternalPackages: ["better-sqlite3", "playwright"],
};

module.exports = nextConfig;
