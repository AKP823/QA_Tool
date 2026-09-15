/** @type {import('next').NextConfig} */
const nextConfig = {
  // better-sqlite3 and playwright are native/Node-only modules — keep them
  // out of the client bundle and don't let Next try to trace/bundle them.
  // (Next 15+ renamed this to the top-level `serverExternalPackages` — this
  // key works on Next 14.x, which is what's pinned in package.json.)
  experimental: {
    serverComponentsExternalPackages: ["better-sqlite3", "playwright"],
  },
};

module.exports = nextConfig;
