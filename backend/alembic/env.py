import asyncio
import os
import ssl
import sys
from logging.config import fileConfig
from pathlib import Path

# Ensure the backend/ directory is on sys.path so `app` is importable
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from alembic import context
from sqlalchemy import pool
from sqlalchemy.ext.asyncio import create_async_engine

from app.config import get_settings
from app.database import Base
from app.models.document import Document  # noqa: F401 — ensure model is registered

config = context.config
settings = get_settings()

# Safety check: prevent accidental migrations against the shared DB
# from a local machine unless explicitly confirmed.
if "neon.tech" in settings.database_url and not os.getenv("MARKDROP_ALLOW_MIGRATE"):
    print(
        "\n⚠️  You are about to run migrations against a Neon database.\n"
        "   Set MARKDROP_ALLOW_MIGRATE=1 to confirm and proceed.\n"
    )
    sys.exit(1)

# asyncpg doesn't accept sslmode= in the URL — strip it and pass via connect_args.
_db_url = settings.database_url.replace("?sslmode=require", "").replace("&sslmode=require", "")
_connect_args = {"ssl": ssl.create_default_context()} if "neon.tech" in settings.database_url else {}

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    context.configure(url=_db_url, target_metadata=target_metadata, literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection):
    context.configure(connection=connection, target_metadata=target_metadata)
    with context.begin_transaction():
        context.run_migrations()


async def run_async_migrations() -> None:
    connectable = create_async_engine(_db_url, poolclass=pool.NullPool, connect_args=_connect_args)
    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)
    await connectable.dispose()


def run_migrations_online() -> None:
    asyncio.run(run_async_migrations())


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
