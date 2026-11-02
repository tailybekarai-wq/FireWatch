# Архитектура системы

## 1. Обзор

Система разделена на четыре независимо разворачиваемых компонента. Их связывает одна база данных.

```
                    ┌──────────────────────────────────────────────┐
                    │  GitHub Actions (cron, каждые ~30 минут)    │
  NASA FIRMS ──────▶│  pipeline/ : fetch → validate → normalize   │
  Open-Meteo ──────▶│  → dedup → upsert → region join → weather   │
                    │  → cluster → ML scoring → run log           │
                    └───────────────────┬──────────────────────────┘
                                        │ SQL (TLS)
                                        ▼
                    ┌──────────────────────────────────────────────┐
                    │  Neon PostgreSQL + PostGIS (Free)            │
                    └───────────────────┬──────────────────────────┘
                                        │ SQL (read-only роль)
                                        ▼
                    ┌──────────────────────────────────────────────┐
                    │  api/ : FastAPI (Render Free Web Service)    │
                    │  REST /api/v1, GeoJSON, агрегаты, кэш        │
                    └───────────────────┬──────────────────────────┘
                                        │ HTTPS JSON
                                        ▼
                    ┌──────────────────────────────────────────────┐
                    │  web/ : Next.js (Vercel Hobby)               │
                    │  MapLibre GL, Recharts, shadcn/ui            │
                    └──────────────────────────────────────────────┘

  ml/ : обучение офлайн (локально или вручную запускаемый workflow)
        → артефакт модели (GitHub Release) + запись в ml_model_versions
```

Ключевое решение: **тяжёлая обработка (сбор данных и ML-скоринг) не выполняется в веб-сервере.** Она идёт в GitHub Actions по расписанию. API только читает из БД, поэтому остаётся лёгким и умещается в бесплатный тариф.

## 2. Модули

| Модуль | Ответственность | Технологии |
|---|---|---|
| `pipeline/sources/firms.py` | HTTP-клиент FIRMS, повторные попытки, учёт лимита | httpx, tenacity |
| `pipeline/sources/openmeteo.py` | Погода по ячейкам сетки, кэш | httpx |
| `pipeline/validate.py` | Pydantic-схемы строк CSV, отклонение некорректных | pydantic v2 |
| `pipeline/normalize.py` | Единая модель обнаружения (VIIRS и MODIS), UTC, уровни confidence | pandas |
| `pipeline/load.py` | Upsert с ключом дедупликации, история версий | SQLAlchemy Core, psycopg 3 |
| `pipeline/enrich.py` | Регион (ST_Intersects), кластеризация (ST_ClusterDBSCAN), погода | PostGIS SQL |
| `pipeline/score.py` | Загрузка активной модели, расчёт признаков, запись прогнозов | lightgbm, numpy |
| `pipeline/run.py` | Оркестрация шагов, журнал запуска, код выхода | — |
| `ml/` | Сбор обучающей выборки, обучение, валидация, отчёт, регистрация | pandas, scikit-learn, lightgbm, geopandas, rasterio, earthaccess |
| `api/` | REST, валидация параметров, агрегаты, CORS, rate limit | FastAPI, Pydantic, SQLAlchemy, slowapi |
| `web/` | UI | Next.js (App Router), TypeScript, Tailwind, shadcn/ui, MapLibre GL JS, Recharts, TanStack Query |
| `db/migrations` | Схема | Alembic |

## 3. Решения (ADR)

### ADR-1. Frontend: Next.js + MapLibre GL JS
- **Next.js:** нативный деплой на Vercel, App Router, серверный рендер первого экрана, ISR для статичных страниц (источники, модель).
- **MapLibre GL JS, а не Leaflet:** WebGL-рендеринг тысяч точек без потери FPS, встроенная кластеризация GeoJSON-источника, векторные подложки, стилизация по свойствам (data-driven styling). Leaflet проще, но на 10⁴ точек работает заметно хуже. Лицензия MapLibre BSD-3.
- **Подложка:** бесплатные векторные тайлы без ключа (кандидат: OpenFreeMap ⚠ проверить условия) с атрибуцией © OpenStreetMap. Запасной вариант: MapTiler Free (нужен ключ).
- **Recharts** закрывает потребности (линии, столбцы, области). **shadcn/ui** даёт доступные компоненты на Radix.

### ADR-2. Backend: FastAPI (Python)
Python нужен для ML и геообработки, поэтому один язык во всём backend. FastAPI даёт OpenAPI-схему автоматически, которая затем используется для генерации TS-типов frontend через `openapi-typescript`. **В API не устанавливаются** geopandas, rasterio и lightgbm: вся геометрия считается в PostGIS, ML-прогнозы уже лежат в БД. Это уменьшает размер образа и время холодного старта.

**Необходимые библиотеки по компонентам** (минимум, без «на всякий случай»):
- api: fastapi, uvicorn, pydantic, sqlalchemy, psycopg[binary], slowapi, structlog
- pipeline: httpx, tenacity, pydantic, pandas, sqlalchemy, psycopg, lightgbm (только скоринг), structlog
- ml: + scikit-learn, geopandas, rasterio, earthaccess, matplotlib (отчёты). XGBoost только для сравнительного эксперимента.

### ADR-3. База: PostgreSQL + PostGIS на Neon Free
| Критерий | Neon Free | Supabase Free | Render Postgres Free |
|---|---|---|---|
| Объём | 0,5 ГБ на проект | 500 МБ | 1 ГБ |
| PostGIS | Да (`CREATE EXTENSION postgis`) | Да | Да |
| Срок жизни | Без ограничения | **Пауза после 1 недели неактивности** | **Удаляется через 30 дней** |
| Compute | 100 CU-часов в месяц на проект, scale-to-zero через 5 минут | — | — |
| Бэкапы | Восстановление на момент в пределах 6 часов | Нет автобэкапов | Нет |

**Выбор: Neon.** Render отпадает из-за удаления через 30 дней. Supabase требует активности, а пауза во время защиты недопустима. Риск Neon: лимит 100 CU-часов. Оценка: 48 запусков pipeline в сутки по ~1–2 минуты, каждый держит compute ещё 5 минут до засыпания. Это до ~5 часов активности в сутки при 0,25 CU, то есть **~35–45 CU-часов в месяц** плюс запросы API. Укладываемся, но мониторим (RISKS R-6). Резервный вариант: интервал 60 минут.

### ADR-4. Планировщик: GitHub Actions
- Vercel Hobby позволяет cron **только раз в сутки** с точностью ±59 минут. Для оперативной системы это не подходит.
- На Render Free нет cron jobs и background workers (бесплатно доступны только web services).
- GitHub Actions: `schedule` с минимальным интервалом 5 минут, стандартные runner'ы бесплатны для публичных репозиториев. Минусы: возможны задержки под нагрузкой, и **автоотключение расписания после 60 дней без активности в репозитории** (см. RISKS R-4).
- Интервал: `*/30 * * * *`. Для NRT с задержкой до 3 часов чаще смысла нет.

### ADR-5. API-хостинг: Render Free Web Service
- Бесплатно (750 часов в месяц на workspace), нативный Python, деплой из GitHub.
- Ограничение: **засыпает через 15 минут без запросов, холодный старт около 1 минуты.** Для демонстрации это смягчается так:
  1. frontend показывает понятное состояние «Сервер просыпается…», а не ошибку;
  2. перед защитой сервер «будится» вручную;
  3. статичные страницы (источники, модель) кэшируются ISR на Vercel.
- Альтернатива, проверяемая на этапе 5: FastAPI как Vercel Python Function (Hobby: до 300 с, 4 CPU-часа в месяц, 1 млн вызовов). Холодного старта в минуту нет, но лимиты меньше. Решение принимается по факту замеров.

### ADR-6. ML вне веб-запроса
Скоринг выполняется в pipeline сразу после загрузки. API отдаёт готовую вероятность и версию модели. Обучение выполняется офлайн (локально или через ручной workflow), артефакт (`model.txt` LightGBM и `metadata.json`) публикуется как GitHub Release, запись о версии и метриках пишет скрипт оценки.

### ADR-7. Монорепозиторий
```
firewatch/
├── web/                 Next.js
├── api/                 FastAPI
├── pipeline/            сбор данных и скоринг (Python package)
├── ml/                  обучение, оценка, отчёты
├── shared/              общие Pydantic-модели и константы (Python)
├── db/migrations/       Alembic
├── docs/                эта документация
├── .github/workflows/   ingest.yml, ci.yml, train.yml (manual), backup.yml
└── .env.example
```

## 4. Поток данных pipeline (один запуск)

1. Создать запись `ingestion_runs(status='running')`.
2. Для каждого источника из `data_sources` (enabled):
   1. GET FIRMS Area API (bbox территории, `DAY_RANGE=2` для перекрытия с прошлыми запусками).
   2. Сохранить метаданные ответа (HTTP-код, размер, SHA-256 тела, время) в `source_fetches`.
   3. Валидация строк по Pydantic. Отклонённые строки попадают в `rejected_records` с причиной.
   4. Нормализация в единый формат.
   5. Upsert по `dedup_key`. Изменение `version` или значений записывается в `detection_history`.
3. Обогащение: регион для новых записей, кластеры за последние 72 часа, погода для новых ячеек.
4. Скоринг новых и обновлённых записей активной моделью (если она есть).
5. Обновить `ingestion_runs` (счётчики, статус `success` / `partial` / `failed`, ошибка).
6. Ненулевой код выхода при `failed`: GitHub пришлёт уведомление о падении workflow.

Ошибка одного источника не останавливает остальные (статус `partial`).

## 5. Безопасность и надёжность

| Аспект | Решение |
|---|---|
| Секреты | `FIRMS_MAP_KEY`, `DATABASE_URL`, `CDSE_CLIENT_*`, `EARTHDATA_TOKEN` хранятся только в GitHub Secrets, Render Env и Vercel Env. Pre-commit `gitleaks` и `.gitignore` для `.env*` |
| Роли БД | `firewatch_writer` для pipeline, `firewatch_reader` (только SELECT) для API |
| Валидация входа API | Pydantic: bbox в пределах ±180/±90, диапазон дат ≤ 366 дней, `limit` ≤ 5 000, enum для satellite и risk |
| Внешние API | Таймауты (connect 10 с, read 60 с), 3 повтора с экспоненциальной паузой, учёт HTTP 429 и 5xx, структурированные логи |
| Идемпотентность | `UNIQUE(dedup_key)` и `INSERT … ON CONFLICT`. `concurrency: ingest` в workflow исключает параллельные запуски |
| Rate limiting | slowapi, 60 запросов в минуту на IP для тяжёлых агрегатов, 300 для остальных |
| CORS | Разрешён только домен Vercel (prod) и `localhost:3000` (dev) |
| Резервное копирование | Neon (восстановление в пределах 6 часов) плюс еженедельный `pg_dump` через GitHub Actions в артефакт workflow ⚠ уточнить срок хранения артефактов |
| Мониторинг | `/api/v1/health` (БД, свежесть данных), бесплатный внешний пинг-мониторинг ⚠ выбрать сервис, страница «Источники» |
| Недоступность источника | Запуск со статусом `partial`/`failed`. UI показывает «данные устарели, последнее обновление …» по `meta.freshness` |

## 6. Производительность карты

- При масштабе ≥ 6 и числе точек ≤ 5 000 в bbox API отдаёт точки в GeoJSON, и MapLibre кластеризует их на клиенте.
- При меньшем масштабе или большем числе точек отдаются агрегаты по сетке (`ST_SnapToGrid`), которые рисуются как heatmap или ячейки.
- Индексы: GiST по `geom`, B-tree по `observed_at` (см. DATABASE_SCHEMA).
- HTTP-кэш: `Cache-Control: public, max-age=300` для агрегатов, ETag по `last_run_id`.
