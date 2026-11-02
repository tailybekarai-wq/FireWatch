"""Alembic environment: raw-SQL migrations against Neon Postgres + PostGIS."""

from __future__ import annotations

import os
from logging.config import fileConfig
from pathlib import Path

from alembic import context
from sqlalchemy import create_engine, pool

from firewatch_shared.envfile import load_env_files, repo_env_files

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

REPO_ROOT = Path(__file__).resolve().parents[2]
# Migrations need a direct connection: PgBouncer (the -pooler host) does not keep
# session state between transactions.
URL_VARIABLES = ("DATABASE_URL_OWNER", "DATABASE_URL_UNPOOLED")


def resolve_url() -> str:
    load_env_files(repo_env_files(REPO_ROOT))
    for name in URL_VARIABLES:
        url = os.environ.get(name)
        if url:
            break
    else:
        raise RuntimeError(f"Set one of {', '.join(URL_VARIABLES)} to run migrations")
    host = url.split("@", 1)[-1].split("/", 1)[0]
    if "-pooler" in host:
        raise RuntimeError(f"{name} points to a pooled host; migrations need the direct URL")
    if url.startswith("postgresql://"):
        url = "postgresql+psycopg://" + url[len("postgresql://") :]
    elif url.startswith("postgres://"):
        url = "postgresql+psycopg://" + url[len("postgres://") :]
    return url


def run_migrations_offline() -> None:
    context.configure(url=resolve_url(), literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    engine = create_engine(resolve_url(), poolclass=pool.NullPool)
    with engine.connect() as connection:
        context.configure(connection=connection, transaction_per_migration=True)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
