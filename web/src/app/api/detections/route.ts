// Map points for real detections. Filters are validated and bound as parameters.
// Compact format (about 4x smaller than GeoJSON): `rows` are arrays in the order of `cols`
// and the client rebuilds GeoJSON. Coordinates are rounded to 1e-4° (~10 m), well below
// the 375 m VIIRS pixel; time is Unix seconds; region is the regions.id.
import { cacheLife } from "next/cache";
import { NextResponse, type NextRequest } from "next/server";
import { query } from "@/lib/db";

const MAX_POINTS = 20_000;
const SATELLITES = new Set(["N20", "N21", "N", "Terra", "Aqua"]);
const CONFIDENCE = new Set(["low", "nominal", "high"]);
const RISK = new Set(["very_high", "high", "moderate", "low", "unscored"]);
const COLS = ["id", "lon", "lat", "s", "c", "f", "t", "rg", "p", "k", "cl"];

type Filter = { days: number; sats: string[]; conf: string[]; risk: string[]; region: number };

async function points(f: Filter): Promise<unknown[][]> {
  "use cache";
  cacheLife("live");
  const params: unknown[] = [f.days];
  const where = ["d.observed_at >= now() - $1::int * interval '1 day'"];
  if (f.sats.length) { params.push(f.sats); where.push(`d.satellite = ANY($${params.length})`); }
  if (f.conf.length) { params.push(f.conf); where.push(`d.confidence_level = ANY($${params.length})`); }
  if (f.region) { params.push(f.region); where.push(`d.region_id = $${params.length}`); }
  if (f.risk.length) {
    params.push(f.risk.filter((r) => r !== "unscored"));
    where.push(`(d.risk_level = ANY($${params.length})${f.risk.includes("unscored") ? " OR d.risk_level IS NULL" : ""})`);
  }
  // p/k: active-model probability and level ('none' when not scored); cl: potential hotspot
  // one aggregated JSON value: the driver parses a single string instead of 20 000 rows
  const [row] = await query<{ rows: unknown[][] | null }>(
    `SELECT json_agg(json_build_array(d.id, round(d.longitude::numeric, 4), round(d.latitude::numeric, 4), d.satellite,
              d.confidence_level, round(d.frp_mw::numeric, 1), extract(epoch FROM d.observed_at)::bigint,
              d.region_id, round(d.probability::numeric, 3), coalesce(d.risk_level, 'none'), d.cluster_id)
              ORDER BY d.observed_at DESC) AS rows
     FROM (SELECT * FROM v_detections_public d
           WHERE ${where.join(" AND ")}
           ORDER BY d.observed_at DESC LIMIT ${MAX_POINTS + 1}) d`,
    params,
  );
  return row?.rows ?? [];
}

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  // sorted, so equivalent filters share one cache entry
  const list = (k: string, allowed: Set<string>) => (sp.get(k) ?? "").split(",").filter((v) => allowed.has(v)).sort();
  const region = Number(sp.get("region"));
  const f: Filter = {
    days: Math.min(Math.max(Number(sp.get("days") ?? 1) || 1, 1), 366),
    sats: list("sat", SATELLITES),
    conf: list("conf", CONFIDENCE),
    risk: list("risk", RISK),
    region: Number.isInteger(region) && region > 0 ? region : 0,
  };
  try {
    const rows = await points(f);
    const truncated = rows.length > MAX_POINTS;
    const kept = rows.slice(0, MAX_POINTS);
    return NextResponse.json(
      { cols: COLS, rows: kept, meta: { count: kept.length, truncated, days: f.days } },
      { headers: { "Cache-Control": "public, max-age=60" } },
    );
  } catch (error) {
    console.error("GET /api/detections failed", error);
    return NextResponse.json({ error: "database_unavailable" }, { status: 503 });
  }
}
