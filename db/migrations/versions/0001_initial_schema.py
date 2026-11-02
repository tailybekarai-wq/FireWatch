"""Initial schema: PostGIS, provenance, detections, regions, weather, ML, views, roles.

Mirrors docs/DATABASE_SCHEMA.md. Allowed string values in CHECK constraints match
firewatch_shared.enums. The only rows inserted are descriptions of real external
data sources (data_sources); no observation data is ever seeded.

Revision ID: 0001
Revises:
Create Date: 2026-11-03
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


TABLES = """
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE data_sources (
    id            smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code          text NOT NULL UNIQUE,
    name          text NOT NULL,
    provider      text NOT NULL,
    data_type     text NOT NULL
                  CHECK (data_type IN ('active_fire', 'weather', 'imagery_index', 'boundaries')),
    api_product   text,
    official_url  text NOT NULL,
    docs_url      text,
    license       text NOT NULL,
    description   text,
    enabled       boolean NOT NULL DEFAULT false,
    deprecated_at timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN data_sources.enabled IS 'Fetched by the scheduled ingestion pipeline';

CREATE TABLE ingestion_runs (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    started_at    timestamptz NOT NULL DEFAULT now(),
    finished_at   timestamptz,
    trigger       text NOT NULL CHECK (trigger IN ('schedule', 'manual', 'backfill')),
    status        text NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running', 'success', 'partial', 'failed')),
    git_sha       text,
    github_run_id text,
    stats         jsonb NOT NULL DEFAULT '{}'::jsonb,
    error         text,
    CHECK (finished_at IS NULL OR finished_at >= started_at)
);
CREATE INDEX ix_runs_started ON ingestion_runs (started_at DESC);

CREATE TABLE source_fetches (
    id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    run_id               bigint NOT NULL REFERENCES ingestion_runs (id),
    source_id            smallint NOT NULL REFERENCES data_sources (id),
    request_url_redacted text NOT NULL,
    params               jsonb NOT NULL DEFAULT '{}'::jsonb,
    requested_at         timestamptz NOT NULL,
    responded_at         timestamptz,
    http_status          integer,
    bytes                integer CHECK (bytes >= 0),
    body_sha256          text CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
    rows_received        integer NOT NULL DEFAULT 0 CHECK (rows_received >= 0),
    rows_inserted        integer NOT NULL DEFAULT 0 CHECK (rows_inserted >= 0),
    rows_updated         integer NOT NULL DEFAULT 0 CHECK (rows_updated >= 0),
    rows_unchanged       integer NOT NULL DEFAULT 0 CHECK (rows_unchanged >= 0),
    rows_rejected        integer NOT NULL DEFAULT 0 CHECK (rows_rejected >= 0),
    status               text NOT NULL
                         CHECK (status IN ('ok', 'http_error', 'timeout', 'parse_error',
                                           'schema_changed')),
    error                text,
    CHECK (request_url_redacted !~* 'MAP_KEY=|/api/area/csv/[0-9a-f]{32}/')
);
COMMENT ON CONSTRAINT source_fetches_request_url_redacted_check ON source_fetches
    IS 'The FIRMS MAP_KEY must be removed from stored URLs';
CREATE INDEX ix_fetches_source_time ON source_fetches (source_id, requested_at DESC);
CREATE INDEX ix_fetches_run ON source_fetches (run_id);

CREATE TABLE rejected_records (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    fetch_id   bigint NOT NULL REFERENCES source_fetches (id) ON DELETE CASCADE,
    raw        jsonb NOT NULL,
    reason     text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_rejected_created ON rejected_records (created_at);

CREATE TABLE regions (
    id             integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    level          smallint NOT NULL CHECK (level IN (0, 1, 2)),
    code           text NOT NULL,
    name           text NOT NULL,
    name_kk        text,
    name_ru        text,
    name_en        text,
    parent_id      integer REFERENCES regions (id),
    osm_relation_id bigint,
    geom           geometry(MultiPolygon, 4326) NOT NULL CHECK (ST_IsValid(geom)),
    source         text NOT NULL,
    source_version text NOT NULL,
    loaded_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (level, code)
);
CREATE INDEX ix_regions_geom ON regions USING gist (geom);

CREATE TABLE hotspot_clusters (
    id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    first_observed_at timestamptz NOT NULL,
    last_observed_at  timestamptz NOT NULL,
    detection_count   integer NOT NULL CHECK (detection_count > 0),
    total_frp_mw      real CHECK (total_frp_mw >= 0),
    max_frp_mw        real CHECK (max_frp_mw >= 0),
    centroid          geometry(Point, 4326) NOT NULL,
    hull              geometry(Polygon, 4326),
    region_id         integer REFERENCES regions (id),
    status            text NOT NULL CHECK (status IN ('active', 'inactive')),
    algorithm         text NOT NULL,
    updated_at        timestamptz NOT NULL DEFAULT now(),
    CHECK (last_observed_at >= first_observed_at)
);
CREATE INDEX ix_clusters_centroid ON hotspot_clusters USING gist (centroid);
CREATE INDEX ix_clusters_status_time ON hotspot_clusters (status, last_observed_at DESC);

CREATE TABLE detections (
    id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    dedup_key           text NOT NULL UNIQUE,
    source_id           smallint NOT NULL REFERENCES data_sources (id),
    first_fetch_id      bigint NOT NULL REFERENCES source_fetches (id),
    last_fetch_id       bigint NOT NULL REFERENCES source_fetches (id),
    satellite           text NOT NULL,
    instrument          text NOT NULL CHECK (instrument IN ('VIIRS', 'MODIS')),
    observed_at         timestamptz NOT NULL,
    latitude            double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
    longitude           double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
    geom                geometry(Point, 4326)
                        GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(longitude, latitude), 4326))
                        STORED,
    bright_main_k       real CHECK (bright_main_k > 0),
    bright_aux_k        real CHECK (bright_aux_k > 0),
    frp_mw              real CHECK (frp_mw >= 0),
    confidence_raw      text NOT NULL,
    confidence_level    text NOT NULL CHECK (confidence_level IN ('low', 'nominal', 'high')),
    scan_km             real CHECK (scan_km > 0),
    track_km            real CHECK (track_km > 0),
    daynight            char(1) NOT NULL CHECK (daynight IN ('D', 'N')),
    product_version     text NOT NULL,
    processing_level    text NOT NULL CHECK (processing_level IN ('URT', 'RT', 'NRT', 'SP')),
    fire_type           smallint CHECK (fire_type BETWEEN 0 AND 3),
    region_id           integer REFERENCES regions (id),
    cluster_id          bigint REFERENCES hotspot_clusters (id),
    weather_cell_id     text,
    ingested_at         timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    processing_status   text NOT NULL DEFAULT 'ingested'
                        CHECK (processing_status IN ('ingested', 'enriched', 'scored',
                                                     'score_skipped')),
    is_confirmed        boolean NOT NULL DEFAULT false,
    confirmation_source text,
    CHECK (NOT is_confirmed OR confirmation_source IS NOT NULL)
);
CREATE INDEX ix_det_geom ON detections USING gist (geom);
CREATE INDEX ix_det_observed ON detections (observed_at DESC);
CREATE INDEX ix_det_src_time ON detections (source_id, observed_at DESC);
CREATE INDEX ix_det_region_time ON detections (region_id, observed_at DESC);
CREATE INDEX ix_det_cluster ON detections (cluster_id);
CREATE INDEX ix_det_processing ON detections (processing_status)
    WHERE processing_status <> 'scored';

CREATE TABLE detection_history (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    detection_id bigint NOT NULL REFERENCES detections (id) ON DELETE CASCADE,
    fetch_id     bigint NOT NULL REFERENCES source_fetches (id),
    changed_at   timestamptz NOT NULL DEFAULT now(),
    changes      jsonb NOT NULL
);
CREATE INDEX ix_history_detection ON detection_history (detection_id, changed_at);

CREATE TABLE weather_observations (
    id                       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source_id                smallint NOT NULL REFERENCES data_sources (id),
    cell_id                  text NOT NULL,
    cell_center              geometry(Point, 4326) NOT NULL,
    valid_at                 timestamptz NOT NULL,
    temperature_2m_c         real,
    relative_humidity_2m_pct real CHECK (relative_humidity_2m_pct BETWEEN 0 AND 100),
    wind_speed_10m_kmh       real CHECK (wind_speed_10m_kmh >= 0),
    wind_direction_10m_deg   real CHECK (wind_direction_10m_deg BETWEEN 0 AND 360),
    precipitation_mm         real CHECK (precipitation_mm >= 0),
    vpd_kpa                  real CHECK (vpd_kpa >= 0),
    soil_moisture_0_7_m3m3   real CHECK (soil_moisture_0_7_m3m3 >= 0),
    model                    text NOT NULL,
    fetched_at               timestamptz NOT NULL DEFAULT now(),
    UNIQUE (source_id, cell_id, valid_at, model)
);
CREATE INDEX ix_weather_cell_time ON weather_observations (cell_id, valid_at);

CREATE TABLE ml_model_versions (
    id                serial PRIMARY KEY,
    name              text NOT NULL,
    version           text NOT NULL UNIQUE,
    algorithm         text NOT NULL,
    params            jsonb NOT NULL DEFAULT '{}'::jsonb,
    features          jsonb NOT NULL,
    training_data     jsonb NOT NULL,
    validation_scheme text NOT NULL,
    metrics           jsonb NOT NULL,
    thresholds        jsonb NOT NULL,
    limitations       text NOT NULL,
    artifact_url      text NOT NULL,
    artifact_sha256   text NOT NULL CHECK (artifact_sha256 ~ '^[0-9a-f]{64}$'),
    git_sha           text NOT NULL,
    trained_at        timestamptz NOT NULL,
    status            text NOT NULL CHECK (status IN ('candidate', 'active', 'retired', 'rejected')),
    created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_model_single_active ON ml_model_versions ((true)) WHERE status = 'active';

CREATE TABLE ml_predictions (
    detection_id      bigint NOT NULL REFERENCES detections (id) ON DELETE CASCADE,
    model_version_id  integer NOT NULL REFERENCES ml_model_versions (id),
    probability       real NOT NULL CHECK (probability BETWEEN 0 AND 1),
    risk_level        text NOT NULL CHECK (risk_level IN ('low', 'moderate', 'high', 'very_high')),
    features          jsonb NOT NULL,
    top_contributions jsonb,
    scored_at         timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (detection_id, model_version_id)
);
CREATE INDEX ix_pred_model ON ml_predictions (model_version_id);

CREATE TABLE burned_area_assessments (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    cluster_id      bigint NOT NULL REFERENCES hotspot_clusters (id),
    source_id       smallint NOT NULL REFERENCES data_sources (id),
    pre_date        date,
    post_date       date,
    scene_ids       text[],
    mean_dnbr       real,
    burned_area_ha  real CHECK (burned_area_ha >= 0),
    cloud_cover_pct real CHECK (cloud_cover_pct BETWEEN 0 AND 100),
    status          text NOT NULL CHECK (status IN ('ok', 'cloudy', 'no_scene', 'failed')),
    computed_at     timestamptz NOT NULL DEFAULT now(),
    CHECK (pre_date IS NULL OR post_date IS NULL OR pre_date < post_date)
);
CREATE INDEX ix_bai_cluster ON burned_area_assessments (cluster_id);
"""

VIEWS = """
CREATE VIEW v_detections_public AS
SELECT d.id, d.observed_at, d.latitude, d.longitude, d.geom,
       s.code AS source_code, s.name AS source_name, s.official_url AS source_url,
       d.satellite, d.instrument, d.frp_mw, d.bright_main_k, d.bright_aux_k,
       d.confidence_raw, d.confidence_level, d.scan_km, d.track_km, d.daynight,
       d.product_version, d.processing_level, d.fire_type,
       d.region_id, r.name AS region_name, r.name_kk AS region_name_kk,
       r.name_ru AS region_name_ru, d.cluster_id,
       d.ingested_at, d.updated_at, d.processing_status,
       d.is_confirmed, d.confirmation_source,
       p.probability, p.risk_level, mv.name AS model_name, mv.version AS model_version
FROM detections d
JOIN data_sources s ON s.id = d.source_id
LEFT JOIN regions r ON r.id = d.region_id
LEFT JOIN ml_model_versions mv ON mv.status = 'active'
LEFT JOIN ml_predictions p ON p.detection_id = d.id AND p.model_version_id = mv.id;

CREATE VIEW v_source_status AS
SELECT s.id, s.code, s.name, s.provider, s.data_type, s.api_product, s.official_url,
       s.docs_url, s.license, s.description, s.enabled, s.deprecated_at,
       ok.last_success_at, att.last_attempt_at, att.last_status,
       err.last_error_at, err.last_error,
       CASE s.data_type
           WHEN 'active_fire' THEN (SELECT count(*) FROM detections d
                                    WHERE d.source_id = s.id
                                      AND d.ingested_at >= now() - interval '24 hours')
           WHEN 'weather' THEN (SELECT count(*) FROM weather_observations w
                                WHERE w.source_id = s.id
                                  AND w.fetched_at >= now() - interval '24 hours')
       END AS records_last_24h,
       CASE s.data_type
           WHEN 'active_fire' THEN (SELECT count(*) FROM detections d WHERE d.source_id = s.id)
           WHEN 'weather' THEN (SELECT count(*) FROM weather_observations w
                                WHERE w.source_id = s.id)
       END AS records_total
FROM data_sources s
LEFT JOIN LATERAL (
    SELECT max(f.responded_at) AS last_success_at
    FROM source_fetches f WHERE f.source_id = s.id AND f.status = 'ok'
) ok ON true
LEFT JOIN LATERAL (
    SELECT f.requested_at AS last_attempt_at, f.status AS last_status
    FROM source_fetches f WHERE f.source_id = s.id
    ORDER BY f.requested_at DESC LIMIT 1
) att ON true
LEFT JOIN LATERAL (
    SELECT f.requested_at AS last_error_at, f.error AS last_error
    FROM source_fetches f WHERE f.source_id = s.id AND f.status <> 'ok'
    ORDER BY f.requested_at DESC LIMIT 1
) err ON true;

CREATE MATERIALIZED VIEW mv_daily_stats AS
SELECT (d.observed_at AT TIME ZONE 'UTC')::date AS day,
       d.region_id, d.source_id, d.satellite, d.daynight,
       coalesce(p.risk_level, 'unscored') AS risk_level,
       count(*)::integer AS detections,
       sum(d.frp_mw)::double precision AS sum_frp_mw,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY d.frp_mw) AS median_frp_mw,
       max(d.frp_mw)::double precision AS max_frp_mw
FROM detections d
LEFT JOIN ml_model_versions mv ON mv.status = 'active'
LEFT JOIN ml_predictions p ON p.detection_id = d.id AND p.model_version_id = mv.id
GROUP BY 1, 2, 3, 4, 5, 6
WITH DATA;
CREATE UNIQUE INDEX ux_mv_daily_stats
    ON mv_daily_stats (day, region_id, source_id, satellite, daynight, risk_level)
    NULLS NOT DISTINCT;
CREATE INDEX ix_mv_daily_day ON mv_daily_stats (day);

-- REFRESH requires ownership, so the writer role refreshes through this function.
CREATE FUNCTION refresh_daily_stats() RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$ REFRESH MATERIALIZED VIEW CONCURRENTLY mv_daily_stats $$;
"""

# Group roles without LOGIN: login users for the pipeline/API are created later
# (stage 4/5) and granted membership, so no password ever lives in a migration.
ROLES = """
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'firewatch_read') THEN
        CREATE ROLE firewatch_read NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'firewatch_write') THEN
        CREATE ROLE firewatch_write NOLOGIN;
    END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO firewatch_read, firewatch_write;

-- Explicit lists, so PostGIS (spatial_ref_sys) and Alembic tables get no grants.
GRANT SELECT ON data_sources, ingestion_runs, source_fetches, regions, hotspot_clusters,
    detections, detection_history, weather_observations, ml_model_versions, ml_predictions,
    burned_area_assessments, v_detections_public, v_source_status, mv_daily_stats
    TO firewatch_read;
GRANT SELECT ON data_sources, regions, ml_model_versions, v_detections_public,
    v_source_status, mv_daily_stats
    TO firewatch_write;
GRANT SELECT, INSERT, UPDATE, DELETE ON ingestion_runs, source_fetches, rejected_records,
    regions, hotspot_clusters, detections, detection_history, weather_observations,
    ml_predictions, burned_area_assessments
    TO firewatch_write;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO firewatch_write;
REVOKE ALL ON FUNCTION refresh_daily_stats() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION refresh_daily_stats() TO firewatch_write;
"""

SOURCES = """
INSERT INTO data_sources
    (code, name, provider, data_type, api_product, official_url, docs_url, license,
     description, enabled, deprecated_at)
VALUES
    ('FIRMS_VIIRS_NOAA20_NRT', 'VIIRS 375 m NOAA-20 (NRT)', 'NASA LANCE / FIRMS', 'active_fire',
     'VIIRS_NOAA20_NRT', 'https://firms.modaps.eosdis.nasa.gov/',
     'https://firms.modaps.eosdis.nasa.gov/api/area/',
     'NASA open data; cite "NASA FIRMS" (LANCE disclaimer applies)',
     'Active fire / thermal anomaly detections, published within ~3 h of overpass.', true, NULL),
    ('FIRMS_VIIRS_NOAA21_NRT', 'VIIRS 375 m NOAA-21 (NRT)', 'NASA LANCE / FIRMS', 'active_fire',
     'VIIRS_NOAA21_NRT', 'https://firms.modaps.eosdis.nasa.gov/',
     'https://firms.modaps.eosdis.nasa.gov/api/area/',
     'NASA open data; cite "NASA FIRMS" (LANCE disclaimer applies)',
     'Active fire / thermal anomaly detections, published within ~3 h of overpass.', true, NULL),
    ('FIRMS_MODIS_NRT', 'MODIS 1 km Terra/Aqua (NRT)', 'NASA LANCE / FIRMS', 'active_fire',
     'MODIS_NRT', 'https://firms.modaps.eosdis.nasa.gov/',
     'https://firms.modaps.eosdis.nasa.gov/api/area/',
     'NASA open data; cite "NASA FIRMS" (LANCE disclaimer applies)',
     'Supplementary source; Terra and Aqua MODIS missions end in 2027.', true, NULL),
    ('FIRMS_VIIRS_SNPP_NRT', 'VIIRS 375 m Suomi NPP (NRT)', 'NASA LANCE / FIRMS', 'active_fire',
     'VIIRS_SNPP_NRT', 'https://firms.modaps.eosdis.nasa.gov/',
     'https://www.earthdata.nasa.gov/news/blog/transitioning-from-suomi-npp-viirs-omps-what-firms-users-need-know',
     'NASA open data; cite "NASA FIRMS" (LANCE disclaimer applies)',
     'New Suomi NPP fire data production ceased 2026-11-02 13:00 UTC.', false,
     '2026-11-02 13:00:00+00'),
    ('FIRMS_VIIRS_NOAA20_SP', 'VIIRS 375 m NOAA-20 (standard)', 'NASA LANCE / FIRMS', 'active_fire',
     'VIIRS_NOAA20_SP', 'https://firms.modaps.eosdis.nasa.gov/',
     'https://firms.modaps.eosdis.nasa.gov/api/area/',
     'NASA open data; cite "NASA FIRMS"',
     'Science-quality archive (2-3 month lag); used for history and ML training.', false, NULL),
    ('FIRMS_VIIRS_NOAA21_SP', 'VIIRS 375 m NOAA-21 (standard)', 'NASA LANCE / FIRMS', 'active_fire',
     'VIIRS_NOAA21_SP', 'https://firms.modaps.eosdis.nasa.gov/',
     'https://firms.modaps.eosdis.nasa.gov/api/area/',
     'NASA open data; cite "NASA FIRMS"',
     'Science-quality archive (2-3 month lag); used for history and ML training.', false, NULL),
    ('FIRMS_VIIRS_SNPP_SP', 'VIIRS 375 m Suomi NPP (standard)', 'NASA LANCE / FIRMS', 'active_fire',
     'VIIRS_SNPP_SP', 'https://firms.modaps.eosdis.nasa.gov/',
     'https://firms.modaps.eosdis.nasa.gov/api/area/',
     'NASA open data; cite "NASA FIRMS"',
     'Science-quality archive until 2026-11-02; used for history and ML training.', false, NULL),
    ('FIRMS_MODIS_SP', 'MODIS 1 km Terra/Aqua (standard)', 'NASA LANCE / FIRMS', 'active_fire',
     'MODIS_SP', 'https://firms.modaps.eosdis.nasa.gov/',
     'https://firms.modaps.eosdis.nasa.gov/api/area/',
     'NASA open data; cite "NASA FIRMS"',
     'Science-quality archive; used for history.', false, NULL),
    ('OPEN_METEO_ARCHIVE', 'Open-Meteo Historical Weather (ERA5)', 'Open-Meteo', 'weather',
     NULL, 'https://open-meteo.com/', 'https://open-meteo.com/en/docs/historical-weather-api',
     'CC BY 4.0; free tier for non-commercial use only',
     'Hourly reanalysis weather (~5 day delay); a fire-danger factor, not evidence of fire.',
     true, NULL),
    ('OPEN_METEO_FORECAST', 'Open-Meteo Forecast (recent hours)', 'Open-Meteo', 'weather',
     NULL, 'https://open-meteo.com/', 'https://open-meteo.com/en/docs',
     'CC BY 4.0; free tier for non-commercial use only',
     'Recent-hours weather for fresh detections; a fire-danger factor, not evidence of fire.',
     true, NULL),
    ('CDSE_SENTINEL2', 'Sentinel-2 L2A (dNBR on demand)', 'ESA Copernicus Data Space Ecosystem',
     'imagery_index', NULL, 'https://dataspace.copernicus.eu/',
     'https://documentation.dataspace.copernicus.eu/',
     'Copernicus Sentinel data terms (free, full and open)',
     'Optional post-fire burn severity (dNBR); not a real-time detection source.', false, NULL),
    ('OSM_BOUNDARIES', 'OpenStreetMap administrative boundaries', 'OpenStreetMap contributors',
     'boundaries', NULL, 'https://www.openstreetmap.org/',
     'https://wiki.openstreetmap.org/wiki/Overpass_API',
     'ODbL 1.0; (c) OpenStreetMap contributors',
     'Kazakhstan country and region boundaries, loaded once via the Overpass API.', false, NULL);
"""


def upgrade() -> None:
    op.execute(TABLES)
    op.execute(VIEWS)
    op.execute(SOURCES)
    op.execute(ROLES)


def downgrade() -> None:
    # Neon's database owner is not a superuser, so DROP OWNED BY <other role> is not
    # allowed. Dropping the objects removes their grants; then only the schema grant
    # remains before the roles can be dropped.
    op.execute(
        """
        DROP FUNCTION IF EXISTS refresh_daily_stats();
        DROP MATERIALIZED VIEW IF EXISTS mv_daily_stats;
        DROP VIEW IF EXISTS v_source_status;
        DROP VIEW IF EXISTS v_detections_public;
        DROP TABLE IF EXISTS burned_area_assessments, ml_predictions, ml_model_versions,
            weather_observations, detection_history, detections, hotspot_clusters, regions,
            rejected_records, source_fetches, ingestion_runs, data_sources;
        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'firewatch_read') THEN
                EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM firewatch_read';
                EXECUTE 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM firewatch_read';
                EXECUTE 'REVOKE ALL ON SCHEMA public FROM firewatch_read';
                EXECUTE 'DROP ROLE firewatch_read';
            END IF;
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'firewatch_write') THEN
                EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM firewatch_write';
                EXECUTE 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM firewatch_write';
                EXECUTE 'REVOKE ALL ON SCHEMA public FROM firewatch_write';
                EXECUTE 'DROP ROLE firewatch_write';
            END IF;
        END
        $$;
        """
    )
