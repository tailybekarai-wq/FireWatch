// Server-side Postgres access (Neon, pooled URL). Read-only queries only; never import
// from client components — DATABASE_URL has no NEXT_PUBLIC_ prefix and stays on the server.
import path from "node:path";
import { loadEnvConfig } from "@next/env";
import { attachDatabasePool } from "@vercel/functions";
import { Pool, type QueryResultRow } from "pg";

const globalForPool = globalThis as unknown as { fwPool?: Pool };

function pool(): Pool {
  if (!globalForPool.fwPool) {
    // Local dev: the URL lives in the repo-root .env.local (written by `neon env pull`).
    // On Vercel it is a project environment variable, so nothing is loaded from disk.
    if (!process.env.DATABASE_URL) loadEnvConfig(path.resolve(process.cwd(), ".."));
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not configured");
    const p = new Pool({ connectionString, max: 5, idleTimeoutMillis: 10_000 });
    attachDatabasePool(p);
    globalForPool.fwPool = p;
  }
  return globalForPool.fwPool;
}

export async function query<T extends QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await pool().query<T>(text, params);
  return result.rows;
}
