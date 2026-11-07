"""Database engine: Supabase Postgres when DATABASE_URL is set, else a local SQLite file."""

from pathlib import Path

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import DeclarativeBase, sessionmaker
from sqlalchemy.pool import StaticPool

# backend/revgym.db, no matter which folder the server is started from.
LOCAL_SQLITE_URL = f"sqlite:///{(Path(__file__).resolve().parent.parent / 'revgym.db').as_posix()}"


class Base(DeclarativeBase):
    pass


def normalize_url(url: str) -> str:
    """Supabase shows postgres:// or postgresql:// URLs; SQLAlchemy needs the psycopg driver named."""
    for prefix in ("postgres://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+psycopg://" + url[len(prefix):]
    return url


def make_engine(database_url: str | None = None):
    url = normalize_url(database_url or LOCAL_SQLITE_URL)
    if url.startswith("sqlite"):
        kwargs = {"connect_args": {"check_same_thread": False}}
        if url in ("sqlite://", "sqlite:///:memory:"):
            # One shared connection so every session sees the same in-memory DB.
            kwargs["poolclass"] = StaticPool
        return create_engine(url, **kwargs)
    # Supabase's pooler (port 6543) doesn't support prepared statements; turn them off.
    return create_engine(url, pool_pre_ping=True, connect_args={"prepare_threshold": None})


def secure_supabase_tables(engine) -> None:
    """Supabase exposes public tables through its REST API using the public anon key.

    Turning on row level security with no policies blocks that path completely.
    This server connects as the database owner, which isn't affected.
    """
    if engine.dialect.name != "postgresql":
        return
    tables = [t for t in Base.metadata.tables if t in set(inspect(engine).get_table_names(schema="public"))]
    with engine.begin() as conn:
        for table in tables:
            conn.execute(text(f'ALTER TABLE public."{table}" ENABLE ROW LEVEL SECURITY'))


def make_session_factory(engine):
    return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
