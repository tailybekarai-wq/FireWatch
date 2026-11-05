# Схема базы данных

PostgreSQL (Neon) с расширением PostGIS. Все времена хранятся в `timestamptz` (UTC). Схема версионируется миграциями Alembic.

## 1. ER-обзор

```
data_sources 1──* ingestion_runs 1──* source_fetches 1──* rejected_records
      │                                     │
      │                                     └──* detections (first/last_fetch_id)
      └──────────────────────────────────────────* detections *──1 regions
                                                     │
                                                     ├──* detection_history
                                                     ├──* ml_predictions *──1 ml_model_versions
                                                     ├──*1 hotspot_clusters   (cluster_id)
                                                     └──   weather_observations (cell_id + час)
burned_area_assessments *──1 hotspot_clusters   (опционально, Sentinel-2)
```

## 2. Таблицы

### 2.1. `data_sources`
Справочник источников. Заполняется миграцией: это не данные наблюдений, а описание реальных источников.
| Колонка | Тип | Описание |
|---|---|---|
| id | smallserial PK | |
| code | text UNIQUE | `FIRMS_VIIRS_NOAA20_NRT`, `FIRMS_VIIRS_NOAA21_NRT`, `FIRMS_MODIS_NRT`, `OPEN_METEO_ARCHIVE`, `OPEN_METEO_FORECAST`, `CDSE_SENTINEL2` |
| name | text | Человекочитаемое название |
| provider | text | NASA LANCE/FIRMS, Open-Meteo, ESA/Copernicus |
| data_type | text | `active_fire`, `weather`, `imagery_index` |
| api_product | text | Значение SOURCE в FIRMS (`VIIRS_NOAA20_NRT`) |
| official_url | text | Официальная страница |
| docs_url | text | Документация |
| license | text | Условия использования и атрибуция |
| enabled | boolean | Участвует в pipeline |
| deprecated_at | timestamptz NULL | Дата прекращения (SNPP: 2026-11-02 13:00 UTC) |

### 2.2. `ingestion_runs`
| Колонка | Тип | Описание |
|---|---|---|
| id | bigserial PK | |
| started_at, finished_at | timestamptz | |
| trigger | text | `schedule`, `manual`, `backfill` |
| status | text | `running`, `success`, `partial`, `failed` |
| git_sha | text | Версия кода pipeline |
| github_run_id | text | Ссылка на запуск workflow |
| stats | jsonb | Сводные счётчики |
| error | text NULL | |

### 2.3. `source_fetches`
Один HTTP-запрос к источнику в рамках запуска.
| Колонка | Тип | Описание |
|---|---|---|
| id | bigserial PK | |
| run_id | bigint FK → ingestion_runs | |
| source_id | smallint FK → data_sources | |
| request_url_redacted | text | URL **без** MAP_KEY |
| params | jsonb | bbox, day_range, date |
| requested_at, responded_at | timestamptz | |
| http_status | int | |
| bytes | int | |
| body_sha256 | text | Хэш ответа: доказательство происхождения. Одинаковый хэш позволяет пропустить повторный разбор |
| rows_received, rows_inserted, rows_updated, rows_unchanged, rows_rejected | int | |
| status | text | `ok`, `http_error`, `timeout`, `parse_error`, `schema_changed` |
| error | text NULL | |

### 2.4. `rejected_records`
| Колонка | Тип | Описание |
|---|---|---|
| id | bigserial PK | |
| fetch_id | bigint FK | |
| raw | jsonb | Исходная строка |
| reason | text | Ошибка валидации |
| created_at | timestamptz | |
Хранится 30 дней.

### 2.5. `detections` (основная)
| Колонка | Тип | Описание |
|---|---|---|
| id | bigserial PK | |
| dedup_key | text UNIQUE | `sha1(source_code, satellite, observed_at, round(lat,4), round(lon,4))`. Не включает `version`, поэтому смена URT → NRT обновляет существующую запись ⚠ проверить на реальных данных, не смещаются ли координаты между версиями |
| source_id | smallint FK | |
| first_fetch_id, last_fetch_id | bigint FK → source_fetches | Происхождение |
| satellite | text | Как в FIRMS: `N20`, `N21`, `N` (Suomi NPP), `Terra`, `Aqua` (подтверждено по реальным выгрузкам 2026-11-03) |
| instrument | text | `VIIRS`, `MODIS` |
| observed_at | timestamptz | Из `acq_date` и `acq_time` (UTC) |
| geom | geometry(Point, 4326) | Центр пикселя |
| latitude, longitude | double precision | Исходные значения без округления |
| bright_main_k | real | VIIRS `bright_ti4` / MODIS `brightness` |
| bright_aux_k | real | VIIRS `bright_ti5` / MODIS `bright_t31` |
| frp_mw | real | Fire Radiative Power, МВт |
| confidence_raw | text | Как в источнике: `l`/`n`/`h` или `0–100` |
| confidence_level | text | Нормализованно: `low`/`nominal`/`high`. VIIRS: `l`/`n`/`h`. MODIS (0–100): < 30 → low, 30–79 → nominal, ≥ 80 → high (FIRMS FAQ) |
| scan_km, track_km | real | Размер пикселя |
| daynight | char(1) | `D`/`N` |
| product_version | text | Например `2.0NRT` |
| processing_level | text | `URT`, `RT`, `NRT`, `SP` |
| fire_type | smallint NULL | Только из SP (0–3) |
| region_id | int FK NULL → regions | |
| cluster_id | bigint FK NULL → hotspot_clusters | |
| weather_cell_id | text NULL | Ячейка 0,25° |
| ingested_at | timestamptz | Первое получение системой |
| updated_at | timestamptz | |
| processing_status | text | `ingested` → `enriched` → `scored` / `score_skipped` |
| is_confirmed | boolean DEFAULT false | Зарезервировано |
| confirmation_source | text NULL | Обязателен при `is_confirmed = true` |

**Ограничения:** `CHECK (latitude BETWEEN -90 AND 90)`, `CHECK (longitude BETWEEN -180 AND 180)`, `CHECK (frp_mw IS NULL OR frp_mw >= 0)`, `CHECK (NOT is_confirmed OR confirmation_source IS NOT NULL)`.

**Индексы:**
```sql
CREATE INDEX ix_det_geom        ON detections USING gist (geom);
CREATE INDEX ix_det_observed    ON detections (observed_at DESC);
CREATE INDEX ix_det_src_time    ON detections (source_id, observed_at DESC);
CREATE INDEX ix_det_region_time ON detections (region_id, observed_at DESC);
CREATE INDEX ix_det_cluster     ON detections (cluster_id);
```
Если таблица вырастет более чем до ~1 млн строк, рассматривается партиционирование по месяцам `observed_at`. В MVP партиционирование не нужно.

### 2.6. `detection_history`
Аудит изменений (смена версии URT/RT → NRT, исправления значений).
| Колонка | Тип |
|---|---|
| id | bigserial PK |
| detection_id | bigint FK |
| fetch_id | bigint FK |
| changed_at | timestamptz |
| changes | jsonb (`{field: [old, new]}`) |

### 2.7. `regions`
| Колонка | Тип | Описание |
|---|---|---|
| id | serial PK | |
| level | smallint | 0 (страна), 1 (регион), 2 (район) |
| code | text | Код из набора границ |
| name | text | |
| name_ru | text NULL | |
| parent_id | int NULL | |
| geom | geometry(MultiPolygon, 4326) | Упрощённая (`ST_SimplifyPreserveTopology`) для экономии места |
| source | text | Набор границ и его версия |
Индекс GiST по `geom`.

### 2.8. `hotspot_clusters`
Потенциальные очаги: группы обнаружений.
| Колонка | Тип | Описание |
|---|---|---|
| id | bigserial PK | |
| first_observed_at, last_observed_at | timestamptz | |
| detection_count | int | |
| total_frp_mw, max_frp_mw | real | |
| centroid | geometry(Point,4326) | |
| hull | geometry(Polygon,4326) NULL | Выпуклая оболочка с буфером |
| region_id | int FK | |
| status | text | `active` (было обнаружение за последние 24 часа) / `inactive` |
| algorithm | text | Например `dbscan_eps750m_72h_v1` |
Алгоритм: `ST_ClusterDBSCAN` в метрической проекции, `eps` около 750 м (два пикселя VIIRS), окно 72 часа. Параметры фиксируются в `algorithm` и подбираются на этапе 4 по реальным данным.

### 2.9. `weather_observations`
| Колонка | Тип | Описание |
|---|---|---|
| id | bigserial PK | |
| source_id | smallint FK | Open-Meteo archive или forecast |
| cell_id | text | Ячейка 0,25° |
| cell_center | geometry(Point,4326) | |
| valid_at | timestamptz | Час |
| temperature_2m_c, relative_humidity_2m_pct, wind_speed_10m_kmh, wind_direction_10m_deg, precipitation_mm, vpd_kpa, soil_moisture_0_7_m3m3 | real | |
| model | text | `era5`, `era5_land`, `best_match` |
| fetched_at | timestamptz | |
UNIQUE(source_id, cell_id, valid_at, model). Обнаружение связывается с погодой по `(weather_cell_id, date_trunc('hour', observed_at))`.

### 2.10. `ml_model_versions`
| Колонка | Тип | Описание |
|---|---|---|
| id | serial PK | |
| name | text | Например `firewatch-vegfire-lgbm` |
| version | text UNIQUE | SemVer |
| algorithm | text | Название алгоритма + гиперпараметры в jsonb `params` |
| features | jsonb | Список признаков и описание |
| training_data | jsonb | Источники, периоды, регионы, число примеров, баланс классов, хэш датасета |
| validation_scheme | text | Описание пространственно-временной схемы |
| metrics | jsonb | **Только из скрипта оценки:** PR-AUC, ROC-AUC, precision, recall, F1 при пороге, Brier, бутстрап-интервалы, сравнение с baseline |
| thresholds | jsonb | Границы уровней риска |
| limitations | text | |
| artifact_url | text | GitHub Release |
| artifact_sha256 | text | |
| git_sha | text | |
| trained_at | timestamptz | |
| status | text | `candidate`, `active`, `retired`, `rejected` |
Частичный уникальный индекс: не более одной записи со статусом `active`.

### 2.11. `ml_predictions`
| Колонка | Тип |
|---|---|
| detection_id | bigint FK |
| model_version_id | int FK |
| probability | real (0–1) |
| risk_level | text (`low`, `moderate`, `high`, `very_high`) |
| features | jsonb (снимок признаков для объяснимости) |
| top_contributions | jsonb NULL (SHAP-значения, топ-5) |
| scored_at | timestamptz |
PK (detection_id, model_version_id).

### 2.12. `burned_area_assessments` (опционально)
cluster_id, pre_date, post_date, scene_ids, mean_dnbr, burned_area_ha (по порогу dNBR), cloud_cover_pct, source_id, computed_at, status.

## 3. Представления

- `v_detections_public`: detections + источник + регион + прогноз активной модели. Используется API.
- `mv_daily_stats` (materialized): `(date, region_id, source_id, risk_level) → count, sum_frp, median_frp`. Обновляется в конце каждого запуска pipeline (`REFRESH MATERIALIZED VIEW CONCURRENTLY`). Используется для дашборда и аналитики.
- `v_source_status`: последний успешный fetch, последняя ошибка, записи за 24 часа и всего.

## 4. Типовые геозапросы

```sql
-- Точки в bbox за период
SELECT … FROM v_detections_public
WHERE geom && ST_MakeEnvelope(:w, :s, :e, :n, 4326)
  AND observed_at >= :from AND observed_at < :to
  AND (:sources IS NULL OR source_code = ANY(:sources))
ORDER BY observed_at DESC LIMIT :limit;

-- Агрегат по сетке для мелкого масштаба
SELECT ST_AsGeoJSON(ST_Envelope(ST_SnapToGrid(geom, :cell))) AS cell, count(*), sum(frp_mw)
FROM detections WHERE geom && ST_MakeEnvelope(...) AND observed_at BETWEEN ...
GROUP BY ST_SnapToGrid(geom, :cell);

-- Соседи обнаружения (5 км, ±48 часов)
SELECT … FROM detections d
WHERE ST_DWithin(d.geom::geography, :g::geography, 5000)
  AND d.observed_at BETWEEN :t - interval '48 hours' AND :t + interval '48 hours';

-- Привязка к региону
UPDATE detections d SET region_id = r.id
FROM regions r WHERE d.region_id IS NULL AND r.level = 1 AND ST_Intersects(r.geom, d.geom);
```

## 5. Роли

Реализовано в миграции `db/migrations/versions/0001_initial_schema.py`:

- `firewatch_write` (групповая, NOLOGIN): SELECT, INSERT, UPDATE, DELETE на рабочие таблицы, SELECT на справочники и представления. REFRESH витрины `mv_daily_stats` выполняется через функцию `refresh_daily_stats()` (SECURITY DEFINER), потому что REFRESH требует прав владельца.
- `firewatch_read` (групповая, NOLOGIN): только SELECT на таблицы и представления, кроме `rejected_records`.
- Права выдаются явным списком таблиц. Служебные `spatial_ref_sys` (PostGIS) и `alembic_version` в него не входят.
- Пользователи с LOGIN для pipeline и API создаются на этапах 4–5 и получают членство в этих группах. Пароли в миграциях не хранятся.
- Миграции выполняет владелец БД по **прямому** подключению (`DATABASE_URL_UNPOOLED`, без `-pooler`): локально или через `.github/workflows/migrate.yml`.

Отличия от исходного проекта схемы, внесённые при реализации:
- `detections.geom` — генерируемый столбец из `longitude` и `latitude`, поэтому расхождение координат невозможно.
- `regions` дополнен полями `name_kk`, `name_en` и `osm_relation_id`.
- `source_fetches` не удаляются по сроку: на них ссылаются `detections` (provenance). Объём небольшой, порядка 50 тыс. строк в год.
- `source_fetches.request_url_redacted` защищён CHECK-ограничением от сохранения MAP_KEY.

## 6. Бюджет хранения (Neon Free: 0,5 ГБ)

Оценка строки `detections` вместе с индексами: **~450–600 байт**. 0,5 ГБ минус регионы, погода и служебные таблицы (~100 МБ) дают ≈ **0,7–0,9 млн обнаружений**.

**Фактический объём** (архив SP за 2025 год, см. [findings/firms_schema_check.md](findings/firms_schema_check.md)): внутри границы Казахстана **147 149 обнаружений в год** (NOAA-20 66 тыс., NOAA-21 65 тыс., MODIS 16 тыс.), то есть **~63–84 МБ в год**. Детальная история помещается примерно на 4–5 лет. В bbox попадает в 2,4 раза больше точек, поэтому pipeline хранит только точки внутри страны.

Политика:
1. Территория ограничивается Казахстаном (bbox `46.4,40.5,87.4,55.5`). Глобальное покрытие в бесплатный тариф не помещается.
2. Детальные записи хранятся **N месяцев** (параметр). Более старые остаются только в `mv_daily_stats`.
3. `rejected_records` хранятся 30 дней. `source_fetches` хранятся бессрочно: на них ссылается provenance обнаружений.
4. Обучающий датасет ML хранится **вне БД** (Parquet в GitHub Release или локально).
5. Pipeline проверяет `pg_database_size()` и предупреждает при 80 % лимита.

Реальный объём для выбранной территории считается на этапе 3 по фактической годовой выгрузке FIRMS, и только после этого выбирается N.
