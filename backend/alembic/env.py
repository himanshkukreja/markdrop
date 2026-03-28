import asyncio
import os
import sys
from logging.config import fileConfig

from alembic import context
from sqlalchemy import pool
from sqlalchemy.ext.asyncio import async_engine_from_config

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

# Override sqlalchemy.url from env
config.set_main_option("sqlalchemy.url", settings.database_url)

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    url = config.get_main_option("sqlalchemy.url")
    context.configure(url=url, target_metadata=target_metadata, literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection):
    context.configure(connection=connection, target_metadata=target_metadata)
    with context.begin_transaction():
        context.run_migrations()


async def run_async_migrations() -> None:
    connectable = async_engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)
    await connectable.dispose()


def run_migrations_online() -> None:
    asyncio.run(run_async_migrations())


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
