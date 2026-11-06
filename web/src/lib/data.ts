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
  probability: number | null; risk_level: string | null; cluster_id: number | null;
};

const ROW_COLUMNS = `id, observed_at, latitude, longitude, satellite, instrument, frp_mw, confidence_level,
  confidence_raw, daynight, region_name_ru AS region_name, source_code, ingested_at, probability, risk_level, cluster_id`;

export async function getRecent(limit: number): Promise<DetectionRow[]> {
  await connection();
  return query<DetectionRow>(
    `SELECT ${ROW_COLUMNS} FROM v_detections_public ORDER BY observed_at DESC, id DESC LIMIT $1`, [limit],
  );
}

export type DetectionFilter = {
  days: number; satellite?: string; confidence?: string; region?: number; risk?: RiskFilter; page: number; size: number;
};

export const RISK_FILTERS = {
  high_plus: "Высокий и критический",
  very_high: "Критический",
  high: "Высокий",
  moderate: "Повышенный",
  low: "Низкий",
  unscored: "Без ML-оценки",
} as const;
export type RiskFilter = keyof typeof RISK_FILTERS;

function filterSql(f: DetectionFilter): { where: string; params: unknown[] } {
  const params: unknown[] = [f.days];
  const parts = ["observed_at >= now() - $1::int * interval '1 day'"];
  if (f.satellite) { params.push(f.satellite); parts.push(`satellite = $${params.length}`); }
  if (f.confidence) { params.push(f.confidence); parts.push(`confidence_level = $${params.length}`); }
  if (f.region) { params.push(f.region); parts.push(`region_id = $${params.length}`); }
  if (f.risk === "high_plus") parts.push("risk_level IN ('high', 'very_high')");
  else if (f.risk === "unscored") parts.push("risk_level IS NULL");
  else if (f.risk) { params.push(f.risk); parts.push(`risk_level = $${params.length}`); }
  return { where: parts.join(" AND "), params };
}

export async function getDetections(f: DetectionFilter): Promise<{ rows: DetectionRow[]; total: number }> {
  await connection();
  const { where, params } = filterSql(f);
  const [{ total }] = await query<{ total: number }>(
    // risk lives in the public view (active model); the plain table is cheaper otherwise
    `SELECT count(*)::int AS total FROM ${f.risk ? "v_detections_public" : "detections"} WHERE ${where}`, params,
  );
  const rows = await query<DetectionRow>(
    `SELECT ${ROW_COLUMNS} FROM v_detections_public WHERE ${where}
     ORDER BY observed_at DESC, id DESC LIMIT ${f.size} OFFSET ${(f.page - 1) * f.size}`, params,
  );
  return { rows, total };
}

export const EXPORT_LIMIT = 50_000;

/** Rows for CSV export: the table filters, or all members of a hotspot, or one record. */
export async function getExportRows(
  f: Omit<DetectionFilter, "page" | "size"> | { cluster: number } | { id: number },
): Promise<(DetectionRow & { model_version: string | null; product_version: string })[]> {
  await connection();
  const cols = `${ROW_COLUMNS}, model_version, product_version`;
  if ("cluster" in f) {
    return query(`SELECT ${cols} FROM v_detections_public WHERE cluster_id = $1 ORDER BY observed_at, id`, [f.cluster]);
  }
  if ("id" in f) return query(`SELECT ${cols} FROM v_detections_public WHERE id = $1`, [f.id]);
  const { where, params } = filterSql({ ...f, page: 1, size: 0 });
  return query(
    `SELECT ${cols} FROM v_detections_public WHERE ${where} ORDER BY observed_at DESC, id DESC LIMIT ${EXPORT_LIMIT}`, params,
  );
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
  neighbors: number; fresh: boolean;
};

export async function getDetection(id: number): Promise<DetectionDetail | null> {
  await connection();
  const [row] = await query<DetectionDetail>(
    `SELECT ${ROW_COLUMNS.split(",").map((c) => `v.${c.trim()}`).join(", ")},
            v.bright_main_k, v.bright_aux_k, v.scan_km, v.track_km, v.product_version,
            v.processing_level, v.fire_type, v.updated_at, v.source_name, v.source_url, v.region_id,
            v.model_name, v.model_version, s.docs_url, (d.observed_at >= now() - interval '3 hours') AS fresh,
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

export type Focus = { id: number; lat: number; lon: number; days: number };

/** A detection to centre the map on, with the smallest map period that still contains it. */
export async function getFocus(id: number): Promise<Focus | null> {
  await connection();
  const [row] = await query<Focus>(
    `SELECT id, latitude AS lat, longitude AS lon,
            least(366, greatest(1, ceil(extract(epoch FROM now() - observed_at) / 86400)))::int AS days
     FROM detections WHERE id = $1`, [id],
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

export type ActiveModel = {
  id: number; name: string; version: string; algorithm: string; status: string; trained_at: string;
  features: string[]; thresholds: Record<string, number | null>; limitations: string;
  validation_scheme: string; artifact_url: string; artifact_sha256: string; git_sha: string;
  metrics: {
    test: Record<string, { pr_auc: number; roc_auc: number; brier: number }>;
    test_ci95: Record<string, [number, number]>;
    validation_pr_auc: Record<string, number>;
    levels: Record<string, { threshold: number | null; test_n: number; test_precision: number | null; val_n: number; val_precision: number | null }>;
    importance: Record<string, number>;
    splits: { sizes: Record<string, number>; positive_share: Record<string, number> };
    slices: Record<string, { n: number; positive_share: number; lightgbm: number; baseline0: number }>;
    gate: Record<string, boolean>;
  };
};

/** The model whose scores are shown, with the metrics computed by its evaluation run. */
export async function getActiveModel(): Promise<ActiveModel | null> {
  await connection();
  const [row] = await query<ActiveModel>(
    `SELECT id, name, version, algorithm, status, trained_at, features, thresholds, limitations,
            validation_scheme, artifact_url, artifact_sha256, git_sha, metrics
     FROM ml_model_versions WHERE status = 'active' LIMIT 1`,
  );
  return row ?? null;
}

export type Prediction = {
  probability: number; risk_level: string; scored_at: string; version: string;
  features: Record<string, number>;
  top_contributions: { feature: string; value: number; contribution: number }[] | null;
};

export async function getPrediction(id: number): Promise<Prediction | null> {
  await connection();
  const [row] = await query<Prediction>(
    `SELECT p.probability, p.risk_level, p.scored_at, mv.version, p.features, p.top_contributions
     FROM ml_predictions p JOIN ml_model_versions mv ON mv.id = p.model_version_id AND mv.status = 'active'
     WHERE p.detection_id = $1`, [id],
  );
  return row ?? null;
}

export async function getHistory(id: number): Promise<{ changed_at: string; changes: Record<string, [unknown, unknown]> }[]> {
  await connection();
  return query(
    `SELECT changed_at, changes FROM detection_history WHERE detection_id = $1 ORDER BY changed_at`, [id],
  );
}

export type Neighbour = {
  id: number; dist_km: number; dt_min: number; satellite: string; frp_mw: number | null;
  cluster_id: number | null; risk_level: string | null; latitude: number; longitude: number;
};

/** Detections within radiusM and ±48 h of a detection (distance on the sphere). */
export async function getNeighbours(id: number, radiusM = 2000): Promise<Neighbour[]> {
  await connection();
  return query<Neighbour>(
    `SELECT v.id, round((ST_Distance(v.geom::geography, d.geom::geography, false) / 1000)::numeric, 2)::float8 AS dist_km,
            round(extract(epoch FROM v.observed_at - d.observed_at) / 60)::int AS dt_min,
            v.satellite, v.frp_mw, v.cluster_id, v.risk_level, v.latitude, v.longitude
     FROM detections d
     JOIN v_detections_public v ON v.id <> d.id
      AND v.geom && ST_Expand(d.geom, 0.05)
      AND ST_DWithin(v.geom::geography, d.geom::geography, $2, false)
      AND v.observed_at BETWEEN d.observed_at - interval '48 hours' AND d.observed_at + interval '48 hours'
     WHERE d.id = $1
     ORDER BY abs(extract(epoch FROM v.observed_at - d.observed_at)), dist_km LIMIT 50`, [id, radiusM],
  );
}

export type Hotspot = {
  id: number; first_observed_at: string; last_observed_at: string; detection_count: number;
  total_frp_mw: number | null; max_frp_mw: number | null; status: string; algorithm: string;
  region_name: string | null; lat: number; lon: number; hull: GeoJSON.Polygon | null;
  satellites: string[]; max_risk: string | null; scored: number;
  weather: { temperature_2m_c: number | null; relative_humidity_2m_pct: number | null;
    wind_speed_10m_kmh: number | null; wind_direction_10m_deg: number | null; valid_at: string } | null;
};

export async function getHotspot(id: number): Promise<Hotspot | null> {
  await connection();
  const [row] = await query<Hotspot>(
    `SELECT h.id, h.first_observed_at, h.last_observed_at, h.detection_count, h.total_frp_mw, h.max_frp_mw,
            h.status, h.algorithm, coalesce(r.name_ru, r.name) AS region_name,
            ST_Y(h.centroid) AS lat, ST_X(h.centroid) AS lon, ST_AsGeoJSON(h.hull, 5)::jsonb AS hull,
            (SELECT array_agg(DISTINCT d.satellite) FROM detections d WHERE d.cluster_id = h.id) AS satellites,
            (SELECT v.risk_level FROM v_detections_public v WHERE v.cluster_id = h.id AND v.risk_level IS NOT NULL
             ORDER BY v.probability DESC LIMIT 1) AS max_risk,
            (SELECT count(*)::int FROM v_detections_public v WHERE v.cluster_id = h.id AND v.probability IS NOT NULL) AS scored,
            (SELECT to_jsonb(w) FROM (
                SELECT wo.temperature_2m_c, wo.relative_humidity_2m_pct, wo.wind_speed_10m_kmh,
                       wo.wind_direction_10m_deg, wo.valid_at
                FROM detections d JOIN weather_observations wo
                  ON wo.cell_id = d.weather_cell_id AND wo.valid_at = date_trunc('hour', d.observed_at)
                WHERE d.cluster_id = h.id ORDER BY d.observed_at DESC LIMIT 1) w) AS weather
     FROM hotspot_clusters h LEFT JOIN regions r ON r.id = h.region_id
     WHERE h.id = $1`, [id],
  );
  return row ?? null;
}

export async function getHotspotDetections(id: number): Promise<DetectionRow[]> {
  await connection();
  return query<DetectionRow>(
    `SELECT ${ROW_COLUMNS} FROM v_detections_public WHERE cluster_id = $1
     ORDER BY observed_at, id LIMIT 2000`, [id],
  );
}

/** Hourly counts and FRP between the first and last detection of a hotspot (max 14 days). */
export async function getHotspotHourly(id: number): Promise<Point[]> {
  await connection();
  return query<Point>(
    `SELECT g AS t, count(d.id)::int AS n, coalesce(sum(d.frp_mw), 0)::float8 AS frp
     FROM hotspot_clusters h
     CROSS JOIN LATERAL generate_series(date_trunc('hour', h.first_observed_at),
         least(date_trunc('hour', h.last_observed_at), date_trunc('hour', h.first_observed_at) + interval '14 days'),
         interval '1 hour') g
     LEFT JOIN detections d ON d.cluster_id = h.id AND d.observed_at >= g AND d.observed_at < g + interval '1 hour'
     WHERE h.id = $1
     GROUP BY g ORDER BY g`, [id],
  );
}

export const REGION_METRICS = {
  count: { label: "Обнаружения", unit: "" },
  frp: { label: "Суммарная FRP", unit: "МВт" },
  med_frp: { label: "Медиана FRP", unit: "МВт" },
  high_risk: { label: "Высокий и критический ML-риск", unit: "" },
} as const;
export type RegionMetric = keyof typeof REGION_METRICS;

export type RegionStat = { id: number; name: string; geometry: GeoJSON.Geometry; value: number; count: number };

/** Regions (simplified boundaries) with one metric over the last N days. */
export async function getRegionStats(days: number, metric: RegionMetric): Promise<RegionStat[]> {
  await connection();
  const expr = {
    count: "count(v.id)",
    frp: "coalesce(sum(v.frp_mw), 0)",
    med_frp: "coalesce(percentile_cont(0.5) WITHIN GROUP (ORDER BY v.frp_mw), 0)",
    high_risk: "count(v.id) FILTER (WHERE v.risk_level IN ('high', 'very_high'))",
  }[metric];
  return query<RegionStat>(
    `SELECT r.id, coalesce(r.name_ru, r.name) AS name,
            ST_AsGeoJSON(ST_SimplifyPreserveTopology(r.geom, 0.01), 3)::jsonb AS geometry,
            (${expr})::float8 AS value, count(v.id)::int AS count
     FROM regions r
     LEFT JOIN v_detections_public v ON v.region_id = r.id AND v.observed_at >= now() - $1::int * interval '1 day'
     WHERE r.level = 1
     GROUP BY r.id, r.name_ru, r.name, r.geom ORDER BY value DESC`, [days],
  );
}

export type Notification = { kind: "risk" | "hotspot" | "source" | "run"; title: string; detail: string; at: string | null; href: string };

/** Notifications derived from the current database state; nothing is stored or invented. */
export async function getNotifications(): Promise<Notification[]> {
  await connection();
  const out: Notification[] = [];
  const [risk] = await query<{ n: number; last: string | null }>(
    `SELECT count(*)::int AS n, max(observed_at) AS last FROM v_detections_public
     WHERE risk_level IN ('high', 'very_high') AND observed_at >= now() - interval '24 hours'`,
  );
  if (risk?.n) {
    out.push({ kind: "risk", title: `${risk.n} обнаружений с высоким ML-риском за 24 ч`,
      detail: "ML-оценка · не подтверждённые пожары", at: risk.last, href: "/detections?days=1&risk=high" });
  }
  const growing = await query<{ id: number; n: number; region: string | null; last: string }>(
    `SELECT h.id, count(d.id)::int AS n, coalesce(r.name_ru, r.name) AS region, max(d.observed_at) AS last
     FROM hotspot_clusters h JOIN detections d ON d.cluster_id = h.id AND d.observed_at >= now() - interval '6 hours'
     LEFT JOIN regions r ON r.id = h.region_id
     WHERE h.status = 'active' GROUP BY h.id, r.name_ru, r.name HAVING count(d.id) >= 3
     ORDER BY n DESC LIMIT 3`,
  );
  for (const g of growing) {
    out.push({ kind: "hotspot", title: `Потенциальный очаг #${g.id} растёт`,
      detail: `${g.n} обнаружений за 6 ч${g.region ? ` · ${g.region}` : ""}`, at: g.last, href: `/hotspots/${g.id}` });
  }
  const late = await query<{ name: string; last_success_at: string | null; last_status: string | null }>(
    `SELECT name, last_success_at, last_status FROM v_source_status
     WHERE enabled AND data_type = 'active_fire'
       AND (last_success_at IS NULL OR last_success_at < now() - interval '3 hours' OR last_status <> 'ok')`,
  );
  for (const s of late) {
    out.push({ kind: "source", title: "Обновление источника задерживается",
      detail: `${s.name}${s.last_status && s.last_status !== "ok" ? ` · последний статус ${s.last_status}` : ""}`,
      at: s.last_success_at, href: "/sources" });
  }
  const [run] = await query<{ id: number; status: string; finished_at: string | null }>(
    `SELECT id, status, finished_at FROM ingestion_runs WHERE trigger <> 'backfill' ORDER BY started_at DESC LIMIT 1`,
  );
  if (run && run.status !== "success") {
    out.push({ kind: "run", title: `Последний сбор: ${run.status}`, detail: `Запуск #${run.id}`, at: run.finished_at, href: "/sources" });
  }
  return out;
}

export async function getRecentRuns(limit: number) {
  await connection();
  return query<{ id: number; trigger: string; status: string; started_at: string; finished_at: string | null; error: string | null }>(
    `SELECT id, trigger, status, started_at, finished_at, error FROM ingestion_runs
     ORDER BY started_at DESC LIMIT $1`, [limit],
  );
}
