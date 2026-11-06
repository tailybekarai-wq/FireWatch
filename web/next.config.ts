import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  // Read caches for lib/data.ts. Data changes at most every ~30 min (ingest schedule),
  // so a page never needs a fresh database round trip per request.
  cacheLife: {
    // operational data: background refresh every minute, regenerated after 10 min idle
    live: { stale: 30, revalidate: 60, expire: 600 },
    // reference data (region list, model versions, monthly totals)
    slow: { stale: 300, revalidate: 900, expire: 3600 },
  },
  turbopack: {
    // The repo root also has a package-lock.json (Neon CLI config deps);
    // pin the workspace root to web/ so Turbopack doesn't infer the repo root.
    root: path.resolve(__dirname),
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
