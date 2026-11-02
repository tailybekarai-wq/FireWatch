# Спецификация REST API

- Базовый путь: `/api/v1`. Формат JSON (GeoJSON для геоданных). Времена в ISO 8601, UTC (`2026-11-02T13:00:00Z`).
- Только чтение (GET) и публичный доступ. Rate limit: 300 запросов в минуту на IP, для `/stats/*` и `/detections` 60 в минуту. При превышении возвращается `429` с `Retry-After`.
- CORS: домен frontend и `http://localhost:3000`.
- OpenAPI-схема `/api/v1/openapi.json` генерируется FastAPI. По ней генерируются TS-типы для frontend.

## 1. Общие соглашения

### 1.1. Блок `meta` (в каждом ответе)
```json
"meta": {
  "generated_at": "…Z",
  "freshness": [
    {"source_code": "FIRMS_VIIRS_NOAA20_NRT", "last_success_at": "…Z", "last_attempt_at": "…Z", "last_status": "ok", "stale": false}
  ],
  "model": {"active": true, "name": "…", "version": "…"} | {"active": false},
  "attribution": ["NASA FIRMS (LANCE)", "Open-Meteo (CC BY 4.0)"]
}
```
`stale = true`, если с последнего успешного обновления прошло больше 3 часов.

### 1.2. Общие параметры фильтрации
| Параметр | Тип | По умолчанию | Ограничения |
|---|---|---|---|
| `from`, `to` | datetime | последние 24 часа | `to − from` ≤ 366 дней |
| `bbox` | `w,s,e,n` | территория проекта | −180…180, −90…90, w < e |
| `sources` | csv enum | все активные | `FIRMS_VIIRS_NOAA20_NRT, FIRMS_VIIRS_NOAA21_NRT, FIRMS_MODIS_NRT, …` |
| `satellite` | csv | — | `N20, N21, Terra, Aqua` ⚠ коды по реальной выгрузке |
| `region_id` | int[] | — | |
| `risk` | csv enum | — | `low, moderate, high, very_high, unscored` |
| `confidence` | csv enum | — | `low, nominal, high` |
| `daynight` | `D`/`N` | — | |
| `min_frp` | float | — | ≥ 0 |

### 1.3. Ошибки
```json
{"error": {"code": "invalid_parameter", "message": "bbox: west must be < east", "details": {...}}, "meta": {...}}
```
| HTTP | code |
|---|---|
| 400 | `invalid_parameter` |
| 404 | `not_found` |
| 429 | `rate_limited` |
| 503 | `database_unavailable` (frontend показывает состояние ошибки, данные не подставляются) |

## 2. Эндпоинты

### `GET /health`
`{"status": "ok"|"degraded", "database": "ok"|"error", "last_ingestion_run": {...}, "version": "git sha"}`. Используется мониторингом и frontend (баннер «сервер просыпается»).

### `GET /detections`
Точки для карты.
- Параметры: общие фильтры плюс `limit` (≤ 5 000, по умолчанию 2 000), `cursor` для постраничного вывода.
- Ответ: `FeatureCollection`, у каждого Feature есть `properties`:
```json
{"id": 123, "observed_at": "…", "source_code": "…", "satellite": "N20", "instrument": "VIIRS",
 "frp_mw": 12.4, "confidence_level": "nominal", "confidence_raw": "n", "daynight": "D",
 "risk_level": "high" | null, "probability": 0.83 | null, "region_name": "…", "cluster_id": 77}
```
- Если в фильтре больше `limit` записей, возвращается `"truncated": true, "total": N` и рекомендация запросить `/detections/grid`.

### `GET /detections/grid`
Агрегаты для мелкого масштаба. Параметр `cell_deg` ∈ {0.05, 0.1, 0.25, 0.5, 1.0}. Ответ: `FeatureCollection` из полигонов ячеек со свойствами `count, sum_frp_mw, max_risk_level`.

### `GET /detections/{id}`
Полная запись:
- все поля `detections` (координаты с исходной точностью, scan/track, яркостные температуры, версия продукта, processing_level);
- `provenance`: источник (название, official_url, docs_url, лицензия), `first_fetched_at`, `last_fetched_at`, `ingestion_run_id`, `request_url_redacted`, `body_sha256`;
- `region`, `cluster` (сводка);
- `weather` (ближайший час, ячейка, модель, источник) или `null` с причиной;
- `prediction`: probability, risk_level, model name/version, top_contributions, scored_at, или `null` с пометкой `"model_inactive"`;
- `history`: изменения версии записи;
- `external_links`: ссылка на просмотр в FIRMS Fire Map (по координатам и дате ⚠ формат URL уточнить), ссылка на документацию продукта.

### `GET /detections/{id}/neighbors`
Обнаружения в радиусе `radius_km` (≤ 25, по умолчанию 5) и окне `hours` (≤ 168, по умолчанию 48). GeoJSON.

### `GET /clusters`, `GET /clusters/{id}`
Потенциальные очаги: центроид, оболочка, число обнаружений, суммарный и максимальный FRP, первое и последнее наблюдение, статус. Для `{id}` дополнительно список обнаружений и (опционально) `burned_area_assessment`.

### `GET /stats/summary`
Для дашборда (из `mv_daily_stats` и `detections`):
```json
{"period": {"from": "…", "to": "…"},
 "detections_total": 0, "detections_last_24h": 0,
 "active_clusters": 0, "sum_frp_mw": 0,
 "by_source": [{"source_code": "…", "count": 0}],
 "by_satellite": [{"satellite": "N20", "count": 0}],
 "by_risk": [{"risk_level": "high", "count": 0}] | null,
 "top_regions": [{"region_id": 1, "name": "…", "count": 0}]}
```
`by_risk = null`, если активной модели нет.

### `GET /stats/timeseries`
`interval` ∈ {`hour`, `day`, `week`, `month`}, `group_by` ∈ {`none`, `source`, `satellite`, `risk`, `region`}, `metric` ∈ {`count`, `sum_frp`, `median_frp`}. Ответ: `[{"t": "…", "group": "…", "value": 0}]`. Пустые интервалы возвращаются с `value = 0` только если источник **работал** в этот интервал. Интервалы, когда источник не отвечал, помечаются `"gap": true`. Так отсутствие данных не превращается в «ноль пожаров».

### `GET /stats/by-region`
`level` ∈ {1, 2}. Ответ: регион, count, sum_frp, доля от общего. Опционально `include_geometry=true` для хороплета (упрощённая геометрия).

### `GET /stats/by-satellite`
Ответ: count, median_frp и доля ночных обнаружений по каждому спутнику.

### `GET /stats/frp`
Гистограмма FRP (логарифмические корзины) и временной ряд медианы и суммы.

### `GET /stats/compare`
Параметры `a_from, a_to, b_from, b_to` плюс общие фильтры. Ответ: метрики A и B, абсолютная и относительная разница, ряды для наложения.

### `GET /stats/monthly`
Матрица `год × месяц → count` по доступной истории (сезонность).

### `GET /stats/weather`
Распределения погодных переменных в точках обнаружений за период (квантили, гистограммы), разбивка по `risk_level`, если модель активна. Дисклеймер в `meta.notes`: «погода является фактором опасности, а не доказательством пожара».

### `GET /regions`
Список регионов (id, name, level, parent_id, bbox). `?geometry=true` возвращает упрощённые полигоны.

### `GET /sources`
По каждому источнику: code, name, provider, data_type, описание, official_url, docs_url, license, enabled, deprecated_at, `status` (`ok`/`degraded`/`down`/`disabled`), last_success_at, last_error (время и текст), records_last_24h, records_total.

### `GET /sources/{code}/runs`
Последние N (≤ 100) fetch-записей: время, http_status, rows_*, status, error.

### `GET /model`
Активная модель или `{"active": false, "reason": "…", "latest_candidate": {...} | null}`. Поля: name, version, algorithm, params, features (описание), training_data, validation_scheme, metrics (как в БД), thresholds, limitations, artifact_url, trained_at, status.

### `GET /model/versions`
История всех версий, включая `rejected`, с метриками.

### `GET /model/drift`
Распределение вероятностей за последние 7 и 30 дней (гистограмма), доля по уровням риска.

### `GET /export/detections.csv`
Те же фильтры, что у `/detections`, лимит 50 000 строк. Первая строка-комментарий содержит атрибуцию и время выгрузки. Rate limit 10 в минуту.

## 3. Соответствие страниц UI и API

| Страница / компонент | Эндпоинты |
|---|---|
| Дашборд: KPI | `/stats/summary` |
| Дашборд: динамика | `/stats/timeseries?interval=day` |
| Дашборд: свежесть | `meta.freshness`, `/sources` |
| Карта: точки и сетка | `/detections`, `/detections/grid` |
| Карта: фильтр регионов | `/regions` |
| Карта: popup | `/detections` (properties), по клику `/detections/{id}` |
| Детальная страница | `/detections/{id}`, `/detections/{id}/neighbors`, `/clusters/{id}` |
| Аналитика | `/stats/timeseries`, `/stats/by-region`, `/stats/by-satellite`, `/stats/frp`, `/stats/compare`, `/stats/monthly`, `/stats/weather` |
| Источники | `/sources`, `/sources/{code}/runs` |
| Модель | `/model`, `/model/versions`, `/model/drift` |
| Экспорт | `/export/detections.csv` |
| Баннер статуса | `/health` |

## 4. Кэширование

- `/stats/*`, `/regions`, `/sources`, `/model`: `Cache-Control: public, max-age=300, stale-while-revalidate=600`. ETag = id последнего успешного запуска.
- `/detections*`: `max-age=60`.
- `/health`: `no-store`.
