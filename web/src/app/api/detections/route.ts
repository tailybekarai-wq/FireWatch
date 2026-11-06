// GeoJSON of real detections for the map. Filters are validated and bound as parameters.
import { NextResponse, type NextRequest } from "next/server";
import { query } from "@/lib/db";

const MAX_POINTS = 20_000;
const SATELLITES = new Set(["N20", "N21", "N", "Terra", "Aqua"]);
const CONFIDENCE = new Set(["low", "nominal", "high"]);
const RISK = new Set(["very_high", "high", "moderate", "low", "unscored"]);

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const days = Math.min(Math.max(Number(sp.get("days") ?? 1) || 1, 1), 366);
  const params: unknown[] = [days];
  const where = ["d.observed_at >= now() - $1::int * interval '1 day'"];
  const sats = (sp.get("sat") ?? "").split(",").filter((s) => SATELLITES.has(s));
  if (sats.length) { params.push(sats); where.push(`d.satellite = ANY($${params.length})`); }
  const conf = (sp.get("conf") ?? "").split(",").filter((c) => CONFIDENCE.has(c));
  if (conf.length) { params.push(conf); where.push(`d.confidence_level = ANY($${params.length})`); }
  const region = Number(sp.get("region"));
  if (Number.isInteger(region) && region > 0) { params.push(region); where.push(`d.region_id = $${params.length}`); }
  const risk = (sp.get("risk") ?? "").split(",").filter((r) => RISK.has(r));
  if (risk.length) {
    params.push(risk.filter((r) => r !== "unscored"));
    where.push(`(d.risk_level = ANY($${params.length})${risk.includes("unscored") ? " OR d.risk_level IS NULL" : ""})`);
  }

  try {
    const rows = await query<{ id: number; lon: number; lat: number; s: string; c: string; f: number | null; t: string;
      r: string | null; p: number | null; k: string | null; cl: number | null }>(
      `SELECT d.id, d.longitude AS lon, d.latitude AS lat, d.satellite AS s, d.confidence_level AS c,
              d.frp_mw AS f, d.observed_at AS t, d.region_name_ru AS r,
              d.probability AS p, d.risk_level AS k, d.cluster_id AS cl
       FROM v_detections_public d
       WHERE ${where.join(" AND ")}
       ORDER BY d.observed_at DESC LIMIT ${MAX_POINTS + 1}`,
      params,
    );
    const truncated = rows.length > MAX_POINTS;
    const features = rows.slice(0, MAX_POINTS).map((p) => ({
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [p.lon, p.lat] },
      // p/k: active-model probability and level (absent when not scored); cl: potential hotspot
      properties: { id: p.id, s: p.s, c: p.c, f: p.f, t: p.t, r: p.r, p: p.p, k: p.k ?? "none", cl: p.cl },
    }));
    return NextResponse.json(
      { type: "FeatureCollection", features, meta: { count: features.length, truncated, days } },
      { headers: { "Cache-Control": "public, max-age=60" } },
    );
  } catch (error) {
    console.error("GET /api/detections failed", error);
    return NextResponse.json({ error: "database_unavailable" }, { status: 503 });
  }
}
