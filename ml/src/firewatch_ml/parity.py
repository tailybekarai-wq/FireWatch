"""Check that SQL scoring features equal the training features on real database rows.

Usage::

    python -m firewatch_ml.parity --sample 300

Draws random recent VIIRS detections, computes their features with
``firewatch_pipeline.score.feature_frame`` (SQL, as in production) and with
``firewatch_ml.features.build`` (KD-tree, as in training) from the same database rows,
and reports every difference. Exit code 1 if any feature differs.
"""

from __future__ import annotations

import argparse
import os
import sys

import numpy as np
import pandas as pd
import psycopg

from firewatch_ml import features
from firewatch_pipeline.run import REPO_ROOT, log
from firewatch_pipeline.score import DETAIL_COLUMNS, feature_frame
from firewatch_shared.envfile import load_env_files, repo_env_files

TOLERANCE = 1e-6
NUMERIC = ("latitude", "longitude", "bright_main_k", "bright_aux_k", "frp_mw")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="SQL vs Python feature parity")
    parser.add_argument("--sample", type=int, default=300)
    parser.add_argument("--days", type=int, default=120)
    args = parser.parse_args(argv)
    load_env_files(repo_env_files(REPO_ROOT))
    url = os.environ.get("DATABASE_URL_UNPOOLED") or os.environ["DATABASE_URL"]
    cols = ", ".join(DETAIL_COLUMNS)
    with psycopg.connect(url) as conn:
        ids = [
            int(r[0])
            for r in conn.execute(
                """SELECT id FROM detections
                   WHERE instrument = 'VIIRS' AND observed_at >= now() - make_interval(days => %s)
                   ORDER BY random() LIMIT %s""",
                (args.days, args.sample),
            )
        ]
        sql = feature_frame(conn, ids)
        cur = conn.execute(
            f"SELECT id, {cols} FROM detections WHERE id = ANY(%s)",  # noqa: S608
            (ids,),
        )
        targets = pd.DataFrame(cur.fetchall(), columns=["id", *DETAIL_COLUMNS]).set_index("id")
        cur = conn.execute(
            f"""SELECT {cols} FROM detections
                WHERE satellite = %s AND observed_at >= %s AND observed_at < %s
                ORDER BY observed_at""",  # noqa: S608
            (
                features.CONTEXT_SATELLITE,
                targets["observed_at"].min() - features.MAX_LOOKBACK,
                targets["observed_at"].max(),
            ),
        )
        context = pd.DataFrame(cur.fetchall(), columns=list(DETAIL_COLUMNS))
    for frame in (targets, context):
        frame["observed_at"] = pd.to_datetime(frame["observed_at"], utc=True)
        for c in NUMERIC:
            frame[c] = frame[c].astype(float)
    py = features.build(targets, context).loc[sql.index]
    diff = (sql - py).abs()
    bad = diff > TOLERANCE * np.maximum(1.0, py.abs())
    summary = {c: int(bad[c].sum()) for c in features.FEATURES if bad[c].any()}
    log(
        "ml_parity",
        rows=len(sql),
        context=len(context),
        mismatched_rows=int(bad.any(axis=1).sum()),
        by_feature=summary,
        max_abs_diff=float(diff.to_numpy().max()) if len(diff) else 0.0,
    )
    return 1 if summary else 0


if __name__ == "__main__":
    sys.exit(main())
