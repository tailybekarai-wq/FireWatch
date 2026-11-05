# План деплоя (бесплатные тарифы)

Условия проверены **2026-11-02**. Бесплатные тарифы часто меняются, поэтому перед деплоем каждый пункт с ⚠ перепроверяется по ссылкам из §5.

## 1. Сравнение сервисов

| Компонент | Выбор | Альтернативы | Ключевые ограничения бесплатного тарифа |
|---|---|---|---|
| Git и CI | **GitHub** (публичный репозиторий) | — | Actions: стандартные runner'ы бесплатны для публичных репозиториев. `schedule` не чаще раза в 5 минут, возможны задержки под нагрузкой, **отключается после 60 дней без активности** в репозитории |
| Frontend | **Vercel Hobby** | Cloudflare Pages, Netlify | **Только некоммерческое использование.** 100 ГБ Fast Data Transfer, 1 млн вызовов функций, 4 CPU-часа Active CPU, функции до 300 с, 100 деплоев в сутки. Cron только раз в сутки (±59 мин) |
| Backend API | **Render Free Web Service** | Vercel Python Functions (оценивается на этапе 5), Koyeb ⚠, Fly.io ⚠ (бесплатных тарифов может не быть) | 750 instance-часов в месяц на workspace. **Засыпает через 15 минут** без входящего трафика, холодный старт около 1 минуты. На Free нет cron jobs и background workers |
| База данных | **Neon Free** | Supabase Free (пауза через неделю неактивности), Render Postgres Free (**удаляется через 30 дней**) | 0,5 ГБ на проект, 100 CU-часов в месяц на проект, autoscale до 2 CU, scale-to-zero через 5 минут, 5 ГБ исходящего трафика в месяц, PostGIS поддерживается |
| Планировщик сбора данных | **GitHub Actions** (`schedule`) | Vercel Cron (не подходит: раз в сутки) | См. строку GitHub |
| Хранение артефактов модели | **GitHub Releases** | Cloudflare R2 Free ⚠, Supabase Storage | Артефакт LightGBM весит единицы МБ. Объектное хранилище в MVP не нужно |
| Бэкап БД | **GitHub Actions** artifact (еженедельный `pg_dump`) | Neon restore | Срок хранения артефактов настраивается ⚠ проверить максимум для публичных репозиториев |
| Мониторинг | `/health` и внешний бесплатный пинг ⚠ выбрать | GitHub Actions уведомления о падениях | — |

**Почему не всё на Vercel:** Vercel подходит для frontend и лёгких serverless-функций, но там нет частого cron на Hobby, а пакеты для геообработки и ML (geopandas, lightgbm) упираются в лимиты размера функций. Поэтому сбор данных и скоринг вынесены в GitHub Actions, а API сделан лёгким.

## 1a. Работа полностью онлайн

Все рабочие компоненты выполняются в облаке на бесплатных тарифах, компьютер разработчика для работы системы не нужен:

| Что | Где выполняется | Бесплатно? |
|---|---|---|
| Сайт (frontend) | Vercel Hobby | Да, только некоммерческое использование |
| API | Render Free | Да, засыпает после 15 минут простоя |
| База данных | Neon Free | Да, 0,5 ГБ |
| Сбор данных каждые 30 минут и ML-скоринг | GitHub Actions | Да: стандартные runner'ы бесплатны и без лимита минут для **публичных** репозиториев |
| Обучение модели | GitHub Actions (ручной запуск `train.yml`), runner 4 vCPU и 16 ГБ RAM | Да, для публичного репозитория |
| Хранение модели | GitHub Releases | Да |
| Бэкапы | GitHub Actions | Да |

**Условие:** репозиторий должен быть **публичным**. Для приватного репозитория минуты Actions лимитированы, и сбор каждые 30 минут может их исчерпать.

Локальный компьютер нужен только **для разработки** (писать код, запускать тесты). Загрузку истории и обучение тоже можно запускать в Actions.

## 1b. Учётные записи: что, зачем и когда

Все регистрации бесплатные. Ключи и пароли вводит **владелец проекта**, и только в настройки секретов сервисов (GitHub Secrets, Render Env, Vercel Env). В чат и в код они не передаются.

| # | Сервис | Зачем | Что получить | Когда нужен |
|---|---|---|---|---|
| 1 | **GitHub** | Хранение кода, автоматический сбор данных (Actions), обучение модели, хранение модели (Releases), CI | Аккаунт и публичный репозиторий `firewatch` | Этап 1 |
| 2 | **NASA FIRMS** | Основной источник спутниковых обнаружений | `MAP_KEY` (форма с одним e-mail на https://firms.modaps.eosdis.nasa.gov/api/map_key/) | Этап 3 |
| 3 | **Neon** | База данных PostgreSQL и PostGIS | Проект и строка подключения (вход через GitHub) | Этап 2 |
| 4 | **NASA Earthdata Login** | Загрузка карт гарей MCD64A1 для разметки ML | Аккаунт на https://urs.earthdata.nasa.gov и токен | Этап 6 |
| 5 | **Render** | Хостинг API | Аккаунт (вход через GitHub), Web Service | Этап 5 |
| 6 | **Vercel** | Хостинг сайта | Аккаунт (вход через GitHub), проект | Этап 7 |
| 7 | Copernicus Data Space (опционально) | Оценка гарей по снимкам Sentinel-2 | Аккаунт и OAuth-клиент | Этап 8, если делаем dNBR |

**Регистрация не нужна:** Open-Meteo (без ключа), подложка карты OpenFreeMap или OSM (⚠ подтвердить на этапе 7), границы OpenStreetMap.
**Банковская карта:** для перечисленных бесплатных тарифов обычно не требуется ⚠ проверить при регистрации на Render и Neon. Если сервис попросит карту, это фиксируется как риск.

**Локальные инструменты для разработки:** Git, Python 3.12, Node.js LTS, Docker Desktop (локальная тестовая БД PostGIS; можно обойтись тестовой веткой Neon).

## 2. Переменные окружения

| Переменная | Где хранится | Назначение |
|---|---|---|
| `FIRMS_MAP_KEY` | GitHub Secrets | Ключ FIRMS |
| `DATABASE_URL` | GitHub Secrets, `.env.local` | Подключение через пул (`-pooler`): запись данных pipeline |
| `DATABASE_URL_UNPOOLED` | GitHub Secrets, `.env.local` | Прямое подключение: миграции Alembic, загрузка регионов, `pg_dump` |
| `DATABASE_URL_READER` | Render Env | Роль `firewatch_reader` (API) |
| `CORS_ORIGINS` | Render Env | `https://<project>.vercel.app` |
| `AOI_BBOX` | GitHub Variables | Территория `W,S,E,N`: `46.4,40.5,87.4,55.5` (Казахстан) |
| `NEXT_PUBLIC_API_BASE_URL` | Vercel Env | `https://<api>.onrender.com/api/v1` |
| `NEXT_PUBLIC_MAP_STYLE_URL` | Vercel Env | URL стиля подложки |
| `EARTHDATA_TOKEN` | Локально / GitHub Secrets (workflow обучения) | Загрузка MCD64A1 |
| `CDSE_CLIENT_ID`, `CDSE_CLIENT_SECRET` | GitHub Secrets (опционально) | Sentinel Hub |

В репозитории лежит только `.env.example` с именами переменных без значений. Утечки предотвращаются через `gitleaks` в pre-commit и в CI.

## 3. Пошаговая инструкция

### Шаг 1. GitHub-репозиторий
1. Создать публичный репозиторий `firewatch`, ветка `main`.
2. Добавить `LICENSE` (MIT для кода), README с атрибуцией источников, `.gitignore` (Python, Node, `.env*`, `*.parquet`).
3. Защитить `main`: PR и зелёный CI обязательны.
4. Settings → Secrets and variables → Actions: внести переменные из §2.
5. Создать environment `production` с обязательным ручным подтверждением (для миграций).

### Шаг 2. База данных (Neon)
1. Создать проект Neon в регионе, ближайшем к Render API ⚠ подобрать пару регионов (например, Frankfurt и Frankfurt).
2. В SQL Editor выполнить `CREATE EXTENSION IF NOT EXISTS postgis;`.
3. Создать роли `firewatch_writer` и `firewatch_reader` с минимальными правами (скрипт `db/roles.sql`).
4. Применить миграции: `alembic upgrade head` через workflow `migrate.yml` (ручной запуск, environment `production`).
5. Загрузить справочники: `data_sources` (миграцией) и `regions` (скрипт `pipeline/load_regions.py` из выбранного открытого набора границ).
6. Проверка: `SELECT postgis_full_version();`, `SELECT count(*) FROM regions;`.

### Шаг 3. Первичная загрузка истории
1. Workflow `backfill.yml` (ручной запуск): FIRMS SP/архив по AOI за выбранный период, порциями по 5 дней.
2. Проверить объём `pg_database_size()` и скорректировать политику хранения (DATABASE_SCHEMA §6).

### Шаг 4. Frontend (Vercel)
1. Import Project → GitHub `firewatch`, Root Directory `web/`, Framework Next.js.
2. Env: `NEXT_PUBLIC_API_BASE_URL`, `NEXT_PUBLIC_MAP_STYLE_URL`.
3. Production branch `main`, preview-деплои для PR.
4. Проверка: открывается `/`, при недоступном API показывается состояние ошибки или холодного старта (а не пустые нули).

### Шаг 5. Backend API (Render)
1. New → Web Service → репозиторий, Root `api/`, Runtime Python.
2. Build: `pip install -r requirements.txt`. Start: `uvicorn app.main:app --host 0.0.0.0 --port $PORT`.
3. Instance type: Free. Health check path: `/api/v1/health`.
4. Env: `DATABASE_URL_READER`, `CORS_ORIGINS`.
5. Auto-deploy из `main` (только после зелёного CI).
6. Проверка: `curl https://<api>.onrender.com/api/v1/health` возвращает `{"status":"ok"}`.

### Шаг 6. Автоматическое получение данных
`.github/workflows/ingest.yml`:
```yaml
on:
  schedule: [{cron: "*/30 * * * *"}]
  workflow_dispatch: {}
concurrency: {group: ingest, cancel-in-progress: false}
jobs:
  ingest:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@<pinned-sha>
      - uses: actions/setup-python@<pinned-sha>
        with: {python-version: "3.12", cache: pip}
      - run: pip install -r pipeline/requirements.txt
      - run: python -m pipeline.run
        env:
          FIRMS_MAP_KEY: ${{ secrets.FIRMS_MAP_KEY }}
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
          AOI_BBOX: ${{ vars.AOI_BBOX }}
```
(Это иллюстрация конфигурации для плана. Финальный файл создаётся на этапе 4.)

Защита от 60-дневного отключения расписания: регулярные коммиты в ходе разработки. После защиты проекта нужна плановая проверка статуса workflow раз в месяц (см. RISKS R-4).

Также создаются:
- `backup.yml`: еженедельный `pg_dump` в артефакт;
- `ci.yml`: lint, тесты, сборка `web/`, проверка gitleaks;
- `train.yml`: ручной запуск обучения и оценки модели.

### Шаг 7. Проверка работоспособности (smoke-checklist)
1. `ingest.yml` вручную: статус success, в `ingestion_runs` новая запись, в `source_fetches` HTTP 200 по каждому источнику.
2. Выборочно сверить 5 записей из БД с выгрузкой FIRMS (координаты, время, FRP совпадают).
3. `/api/v1/stats/summary` возвращает числа, совпадающие с `SELECT count(*)` за тот же период.
4. На карте в продакшене видны точки. Клик по точке открывает карточку, ссылка на первоисточник работает.
5. Страница `/sources` показывает корректное время последнего обновления.
6. Тест отказа: временно указать неверный `FIRMS_MAP_KEY`. Запуск должен получить статус `failed`/`partial`, UI показать «данные устарели» без подмены. После проверки ключ вернуть.
7. Через 2 часа убедиться, что прошло ≥ 3 запусков по расписанию.

## 4. Ожидаемое поведение на бесплатных тарифах (сообщается пользователю)

- Первая загрузка API после простоя занимает до ~1 минуты (Render Free). UI показывает «Сервер запускается».
- Новые обнаружения появляются в системе с задержкой: публикация NRT в FIRMS (≤ 3 ч после пролёта) плюс до 30 минут расписания плюс возможные задержки GitHub Actions.
- Объём хранимой истории ограничен 0,5 ГБ (Neon Free).

## 5. Ссылки на проверенные условия

- Vercel Hobby: https://vercel.com/docs/plans/hobby
- Vercel Cron: https://vercel.com/docs/cron-jobs/usage-and-pricing
- Render Free: https://render.com/docs/free
- Neon тарифы: https://neon.com/docs/introduction/plans, PostGIS: https://neon.com/docs/extensions/postgis
- Supabase тарифы: https://supabase.com/pricing
- GitHub Actions schedule: https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows
