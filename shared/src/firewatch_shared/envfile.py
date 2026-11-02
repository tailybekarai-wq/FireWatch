"""Minimal loader for local ``.env``-style files (``KEY=value`` per line).

Used by local CLIs and Alembic so developers don't have to export variables by
hand. Values already present in the process environment always win, so CI and
hosting secrets are never overridden by a stray local file.
"""

from __future__ import annotations

import os
from collections.abc import Iterable, MutableMapping
from pathlib import Path


def parse_env_text(text: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[len("export ") :]
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if key:
            values[key] = value
    return values


def load_env_files(
    paths: Iterable[Path], environ: MutableMapping[str, str] | None = None
) -> list[Path]:
    """Load the given files in order without overriding existing variables.

    Returns the files that existed and were read.
    """
    target = os.environ if environ is None else environ
    loaded: list[Path] = []
    for path in paths:
        if not path.is_file():
            continue
        for key, value in parse_env_text(path.read_text(encoding="utf-8")).items():
            target.setdefault(key, value)
        loaded.append(path)
    return loaded


def repo_env_files(repo_root: Path) -> list[Path]:
    """Local env files in priority order (``.env.local`` is written by ``neon env pull``)."""
    return [repo_root / ".env.local", repo_root / ".env"]
