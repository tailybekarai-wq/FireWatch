// Read-only data access for server components and route handlers. Every function marks
// itself request-time with connection(): numbers always come from the live database.
import { connection } from "next/server";
import { query } from "./db";

export type SourceStatus = {
  code: string; name: string; provider: string; data_type: string; description: string | null;
  official_url: string; docs_url: string | null; license: string; enabled: boolean;
  deprecated_at: string | null; last_success_at: string | null; last_attempt_at: string | null;
  last_status: string | null; last_error_at: string | null; last_error: string | null;
  records_last_24h: number | null; records_total: number | null;
};

export async function getSources(): Promise<SourceStatus[]> {
  await connection();
  return query<SourceStatus>(
    `SELECT code, name, provider, data_type, description, official_url, docs_url, license, enabled,
            deprecated_at, last_success_at, last_attempt_at, last_status, last_error_at, last_error,
            records_last_24h::int, records_total::int
     FROM v_source_status ORDER BY enabled DESC, data_type, code`,
  );
}

export type Freshness = {
  lastSuccess: string | null; stale: boolean; lastRun: string | null; lastRunStatus: string | null; online: number; total: number;
};

export async function getFreshness(): Promise<Freshness> {
  await connection();
  // FIRMS NRT latency is up to ~3 h, so older data is flagged as stale (computed by the DB clock).
  const [row] = await query<{ last_success: string | null; stale: boolean; online: number; total: number }>(
    `SELECT max(last_success_at) FILTER (WHERE data_type = 'active_fire') AS last_success,
            coalesce(max(last_success_at) FILTER (WHERE data_type = 'active_fire') < now() - interval '3 hours', true) AS stale,
            count(*) FILTER (WHERE enabled AND last_status = 'ok')::int AS online,
            count(*) FILTER (WHERE enabled)::int AS total
     FROM v_source_status`,
  );
  const [run] = await query<{ finished_at: string | null; status: string | null }>(
    `SELECT finished_at, status FROM ingestion_runs WHERE trigger <> 'backfill'
     ORDER BY started_at DESC LIMIT 1`,
  );
  return { lastSuccess: row?.last_success ?? null, stale: row?.stale ?? true, lastRun: run?.finished_at ?? null,
    lastRunStatus: run?.status ?? null, online: row?.online ?? 0, total: row?.total ?? 0 };
}

export type Summary = {
  last24h: number; prev24h: number; period: number; total: number;
  bySatellite: { satellite: string; n: number }[];
  topRegions: { id: number; name: string; n: number }[];
  model: { name: string; version: string } | null;
};

export async function getSummary(days: number): Promise<Summary> {
  await connection();
  const [counts] = await query<{ last24h: number; prev24h: number }>(
    `SELECT count(*) FILTER (WHERE observed_at >= now() - interval '24 hours')::int AS last24h,
            count(*) FILTER (WHERE observed_at < now() - interval '24 hours')::int AS prev24h
     FROM detections WHERE observed_at >= now() - interval '48 hours'`,
  );
  const [agg] = await query<{ period: number; total: number }>(
    `SELECT coalesce(sum(detections) FILTER (WHERE day > current_date - $1::int), 0)::int AS period,
            coalesce(sum(detections), 0)::int AS total
     FROM mv_daily_stats`, [days],
  );
  const bySatellite = await query<{ satellite: string; n: number }>(
    `SELECT satellite, sum(detections)::int AS n FROM mv_daily_stats
     WHERE day > current_date - $1::int GROUP BY satellite ORDER BY n DESC`, [days],
  );
  const topRegions = await query<{ id: number; name: string; n: number }>(
    `SELECT r.id, coalesce(r.name_ru, r.name) AS name, sum(m.detections)::int AS n
     FROM mv_daily_stats m JOIN regions r ON r.id = m.region_id
     WHERE m.day > current_date - $1::int GROUP BY r.id, r.name_ru, r.name ORDER BY n DESC`, [days],
  );
  const [model] = await query<{ name: string; version: string }>(
    `SELECT name, version FROM ml_model_versions WHERE status = 'active' LIMIT 1`,
  );
  return { last24h: counts.last24h, prev24h: counts.prev24h, period: agg.period, total: agg.total,
    bySatellite, topRegions, model: model ?? null };
}

export type Point = { t: string; n: number; frp: number };

/** Hourly series for <= 3 days, daily otherwise; empty buckets are real zeros. */
export async function getTimeline(days: number): Promise<{ unit: "hour" | "day"; points: Point[] }> {
  await connection();
  if (days <= 3) {
    const points = await query<Point>(
      `SELECT g AS t, count(d.id)::int AS n, coalesce(sum(d.frp_mw), 0)::float8 AS frp
       FROM generate_series(date_trunc('hour', now()) - ($1::int * 24 - 1) * interval '1 hour',
                            date_trunc('hour', now()), interval '1 hour') g
       LEFT JOIN detections d ON d.observed_at >= g AND d.observed_at < g + interval '1 hour'
       GROUP BY g ORDER BY g`, [days],
    );
    return { unit: "hour", points };
  }
  const points = await query<Point>(
    `SELECT g::date AS t, coalesce(sum(m.detections), 0)::int AS n, coalesce(sum(m.sum_frp_mw), 0)::float8 AS frp
     FROM generate_series(current_date - ($1::int - 1), current_date, interval '1 day') g
     LEFT JOIN mv_daily_stats m ON m.day = g::date
     GROUP BY g ORDER BY g`, [days],
  );
  return { unit: "day", points };
}

export type DetectionRow = {
  id: number; observed_at: string; latitude: number; longitude: number; satellite: string;
  instrument: string; frp_mw: number | null; confidence_level: string; confidence_raw: string;
  daynight: string; region_name: string | null; source_code: string; ingested_at: string;
  probability: number | null; risk_level: string | null;
};

const ROW_COLUMNS = `id, observed_at, latitude, longitude, satellite, instrument, frp_mw, confidence_level,
  confidence_raw, daynight, region_name_ru AS region_name, source_code, ingested_at, probability, risk_level`;

export async function getRecent(limit: number): Promise<DetectionRow[]> {
  await connection();
  return query<DetectionRow>(
    `SELECT ${ROW_COLUMNS} FROM v_detections_public ORDER BY observed_at DESC, id DESC LIMIT $1`, [limit],
  );
}

export type DetectionFilter = {
  days: number; satellite?: string; confidence?: string; region?: number; page: number; size: number;
};

function filterSql(f: DetectionFilter): { where: string; params: unknown[] } {
  const params: unknown[] = [f.days];
  const parts = ["observed_at >= now() - $1::int * interval '1 day'"];
  if (f.satellite) { params.push(f.satellite); parts.push(`satellite = $${params.length}`); }
  if (f.confidence) { params.push(f.confidence); parts.push(`confidence_level = $${params.length}`); }
  if (f.region) { params.push(f.region); parts.push(`region_id = $${params.length}`); }
  return { where: parts.join(" AND "), params };
}

export async function getDetections(f: DetectionFilter): Promise<{ rows: DetectionRow[]; total: number }> {
  await connection();
  const { where, params } = filterSql(f);
  const [{ total }] = await query<{ total: number }>(
    `SELECT count(*)::int AS total FROM detections WHERE ${where}`, params,
  );
  const rows = await query<DetectionRow>(
    `SELECT ${ROW_COLUMNS} FROM v_detections_public WHERE ${where}
     ORDER BY observed_at DESC, id DESC LIMIT ${f.size} OFFSET ${(f.page - 1) * f.size}`, params,
  );
  return { rows, total };
}

export type DetectionDetail = DetectionRow & {
  bright_main_k: number | null; bright_aux_k: number | null; scan_km: number | null; track_km: number | null;
  product_version: string; processing_level: string; fire_type: number | null; updated_at: string;
  source_name: string; source_url: string; docs_url: string | null; region_id: number | null;
  request_url_redacted: string; requested_at: string; body_sha256: string | null; run_id: number;
  model_name: string | null; model_version: string | null;
  weather: { valid_at: string; temperature_2m_c: number | null; relative_humidity_2m_pct: number | null;
    wind_speed_10m_kmh: number | null; wind_direction_10m_deg: number | null; precipitation_mm: number | null;
    vpd_kpa: number | null; model: string; source: string } | null;
  neighbors: number;
};

export async function getDetection(id: number): Promise<DetectionDetail | null> {
  await connection();
  const [row] = await query<DetectionDetail>(
    `SELECT ${ROW_COLUMNS.split(",").map((c) => `v.${c.trim()}`).join(", ")},
            v.bright_main_k, v.bright_aux_k, v.scan_km, v.track_km, v.product_version,
            v.processing_level, v.fire_type, v.updated_at, v.source_name, v.source_url, v.region_id,
            v.model_name, v.model_version, s.docs_url,
            f.request_url_redacted, f.requested_at, f.body_sha256, f.run_id,
            (SELECT to_jsonb(w) FROM (
                SELECT wo.valid_at, wo.temperature_2m_c, wo.relative_humidity_2m_pct, wo.wind_speed_10m_kmh,
                       wo.wind_direction_10m_deg, wo.precipitation_mm, wo.vpd_kpa, wo.model, ds.name AS source
                FROM weather_observations wo JOIN data_sources ds ON ds.id = wo.source_id
                WHERE wo.cell_id = d.weather_cell_id AND wo.valid_at = date_trunc('hour', d.observed_at)
                LIMIT 1) w) AS weather,
            (SELECT count(*)::int FROM detections n
             WHERE n.id <> d.id AND ST_DWithin(n.geom::geography, d.geom::geography, 5000)
               AND n.observed_at BETWEEN d.observed_at - interval '48 hours'
                                     AND d.observed_at + interval '48 hours') AS neighbors
     FROM v_detections_public v
     JOIN detections d ON d.id = v.id
     JOIN source_fetches f ON f.id = d.first_fetch_id
     JOIN data_sources s ON s.id = d.source_id
     WHERE v.id = $1`, [id],
  );
  return row ?? null;
}

export async function getRegions(): Promise<{ id: number; name: string }[]> {
  await connection();
  return query(`SELECT id, coalesce(name_ru, name) AS name FROM regions WHERE level = 1 ORDER BY 2`);
}

export async function getMonthly(): Promise<{ year: number; month: number; n: number }[]> {
  await connection();
  return query(
    `SELECT extract(year FROM day)::int AS year, extract(month FROM day)::int AS month, sum(detections)::int AS n
     FROM mv_daily_stats GROUP BY 1, 2 ORDER BY 1, 2`,
  );
}

export async function getFrpHistogram(days: number): Promise<{ bucket: string; n: number }[]> {
  await connection();
  return query(
    `SELECT b.label AS bucket, count(d.id)::int AS n
     FROM (VALUES (1, '< 5', 0, 5), (2, '5–10', 5, 10), (3, '10–25', 10, 25), (4, '25–50', 25, 50),
                  (5, '50–100', 50, 100), (6, '100–500', 100, 500), (7, '≥ 500', 500, 1e9))
          AS b(ord, label, lo, hi)
     LEFT JOIN detections d ON d.frp_mw >= b.lo AND d.frp_mw < b.hi
                           AND d.observed_at >= now() - $1::int * interval '1 day'
     GROUP BY b.ord, b.label ORDER BY b.ord`, [days],
  );
}

export type ModelVersion = {
  name: string; version: string; algorithm: string; status: string; trained_at: string;
  metrics: Record<string, unknown>; features: unknown; limitations: string; artifact_url: string;
};

export async function getModels(): Promise<ModelVersion[]> {
  await connection();
  return query<ModelVersion>(
    `SELECT name, version, algorithm, status, trained_at, metrics, features, limitations, artifact_url
     FROM ml_model_versions ORDER BY trained_at DESC`,
  );
}

export async function getRecentRuns(limit: number) {
  await connection();
  return query<{ id: number; trigger: string; status: string; started_at: string; finished_at: string | null; error: string | null }>(
    `SELECT id, trigger, status, started_at, finished_at, error FROM ingestion_runs
     ORDER BY started_at DESC LIMIT $1`, [limit],
  );
}
