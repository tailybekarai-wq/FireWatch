"""Register a trained version in ``ml_model_versions`` from its generated metadata.

Usage::

    python -m firewatch_ml.register [--version 1.0.0]

Only values computed by ``firewatch_ml.train`` are written. The status comes from the
gate: ``active`` (the previous active version becomes ``retired``) or ``rejected``.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from typing import Any

import psycopg

from firewatch_ml.train import MODELS_DIR, VERSION
from firewatch_pipeline.run import REPO_ROOT, log
from firewatch_shared.envfile import load_env_files, repo_env_files

LIMITATIONS = (
    "Оценка вероятности того, что VIIRS-обнаружение связано с гарью, картированной MCD64A1 "
    "(500 м). Не подтверждает пожар. Без погодных признаков. Обучена на VIIRS NOAA-20 "
    "(Казахстан, 2019-2022); применяется к VIIRS NOAA-20 и NOAA-21, MODIS не оценивается. "
    "Мелкие пожары, не оставляющие гари размером с пиксель 500 м, занижаются."
)
VALIDATION = (
    "Временное разделение: train 2019-2022, validation 2023 (ранняя остановка, isotonic-"
    "калибровка, пороги), test 2024-2025 (один раз). Подбор гиперпараметров: GroupKFold k=5 "
    "по ячейкам 1x1 градус внутри train. 95% ДИ: бутстрап по очагам, 1000 повторов."
)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Register a trained FireWatch model")
    parser.add_argument("--version", default=VERSION)
    args = parser.parse_args(argv)
    folder = MODELS_DIR / args.version
    meta: dict[str, Any] = json.loads((folder / "metadata.json").read_text(encoding="utf-8"))
    spec: dict[str, Any] = json.loads((folder / "feature_spec.json").read_text(encoding="utf-8"))
    sha = hashlib.sha256((REPO_ROOT / meta["artifact"]["path"]).read_bytes()).hexdigest()
    if sha != meta["artifact"]["sha256"]:
        log("register_failed", error="artifact SHA-256 differs from metadata")
        return 1

    load_env_files(repo_env_files(REPO_ROOT))
    url = os.environ.get("DATABASE_URL_UNPOOLED") or os.environ.get("DATABASE_URL")
    if not url:
        log("config_error", missing=["DATABASE_URL"])
        return 2
    metrics = {
        key: meta[key]
        for key in (
            "test",
            "test_ci95",
            "validation_pr_auc",
            "slices",
            "levels",
            "importance",
            "calibration_table",
            "gate",
            "splits",
        )
    }
    params = {**meta["params"], "calibration": meta["calibration"]}
    with psycopg.connect(url, autocommit=True) as conn, conn.transaction():
        exists = conn.execute(
            "SELECT 1 FROM ml_model_versions WHERE version = %s", (meta["version"],)
        ).fetchone()
        if exists:
            log("register_skipped", version=meta["version"], reason="already registered")
            return 0
        if meta["status"] == "active":
            conn.execute("UPDATE ml_model_versions SET status = 'retired' WHERE status = 'active'")
        row = conn.execute(
            """INSERT INTO ml_model_versions (name, version, algorithm, params, features,
                   training_data, validation_scheme, metrics, thresholds, limitations,
                   artifact_url, artifact_sha256, git_sha, trained_at, status)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
               RETURNING id""",
            (
                meta["name"],
                meta["version"],
                meta["algorithm"],
                json.dumps(params),
                json.dumps(spec["features"]),
                json.dumps(meta["dataset"]),
                VALIDATION,
                json.dumps(metrics),
                json.dumps(meta["thresholds"]),
                LIMITATIONS,
                meta["artifact"]["path"],
                sha,
                meta["git_sha"],
                meta["trained_at"],
                meta["status"],
            ),
        ).fetchone()
    log("registered", id=row[0] if row else None, version=meta["version"], status=meta["status"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
