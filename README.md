# FireWatch

Информационная система раннего обнаружения лесных пожаров на основе спутниковых данных с применением методов машинного обучения. Территория: **Республика Казахстан**.

> **Статус:** этап 1 из 10, каркас репозитория. Функциональности пока нет. План: [docs/DEVELOPMENT_ROADMAP.md](docs/DEVELOPMENT_ROADMAP.md).

## Принцип

Система показывает **только реальные спутниковые наблюдения** (NASA FIRMS: VIIRS NOAA-20, NOAA-21, MODIS). Фиктивные данные в рабочей базе и интерфейсе запрещены. Каждое обнаружение — это термическая аномалия, а не подтверждённый пожар.

## Структура

| Каталог | Назначение | Развёртывание |
|---|---|---|
| `web/` | Интерфейс (Next.js, TypeScript, Tailwind) | Vercel |
| `api/` | REST API только для чтения (FastAPI) | Render |
| `pipeline/` | Сбор, проверка, сохранение и ML-оценка данных | GitHub Actions (cron) |
| `ml/` | Обучение и оценка модели | GitHub Actions (ручной запуск) |
| `shared/` | Общие схемы и константы Python | — |
| `docs/` | Проектная документация | — |

Архитектура: [docs/SYSTEM_ARCHITECTURE.md](docs/SYSTEM_ARCHITECTURE.md).

## Локальная разработка

Требуется Python ≥ 3.12, Node.js 24 LTS, Git.

```bash
python -m venv .venv
```

Windows: `.venv\Scripts\activate`, Linux/macOS: `source .venv/bin/activate`.

```bash
pip install -r requirements-dev.txt
```

```bash
pre-commit install
```

```bash
pytest
```

Frontend:

```bash
cd web && npm install && npm run dev
```

Переменные окружения описаны в [.env.example](.env.example). Настоящие значения хранятся только в `.env` (он в `.gitignore`) и в секретах GitHub, Render и Vercel.

## Источники данных и атрибуция

- **NASA FIRMS** (LANCE): активные пожары и термические аномалии VIIRS и MODIS. Обязательна ссылка «NASA FIRMS».
- **Open-Meteo**: погодные данные, CC BY 4.0, некоммерческое использование.
- **OpenStreetMap**: административные границы и подложка карты, © участники OpenStreetMap, ODbL 1.0.
- **NASA LP DAAC, MCD64A1**: карты гарей для обучения модели.

Подробно: [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md).

## Лицензия

Код распространяется по лицензии MIT ([LICENSE](LICENSE)). Данные остаются под лицензиями своих поставщиков.
