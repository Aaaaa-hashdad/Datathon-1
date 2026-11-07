"""Settings, read from environment variables or backend/.env.

Leave the Supabase values empty to run fully local (SQLite + ./uploads).
"""

import os
import secrets
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

BACKEND_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BACKEND_DIR / ".env")


@dataclass
class Settings:
    # Supabase Postgres connection string (Project Settings -> Database -> Connection string).
    # Empty = local SQLite file.
    database_url: str = field(default_factory=lambda: os.getenv("DATABASE_URL", ""))
    # Supabase Storage. Both empty = store videos in backend/uploads.
    supabase_url: str = field(default_factory=lambda: os.getenv("SUPABASE_URL", "").rstrip("/"))
    supabase_service_key: str = field(default_factory=lambda: os.getenv("SUPABASE_SERVICE_ROLE_KEY", ""))
    storage_bucket: str = field(default_factory=lambda: os.getenv("SUPABASE_BUCKET", "recordings"))
    upload_dir: Path = field(default_factory=lambda: Path(os.getenv("UPLOAD_DIR", BACKEND_DIR / "uploads")))
    # Signs short-lived video links. A random one per run is fine for local use.
    secret_key: str = field(default_factory=lambda: os.getenv("SECRET_KEY") or secrets.token_urlsafe(32))
    # Port where run.py serves the phone camera page over HTTPS (phones only allow
    # camera access on HTTPS). 0 = send the phone to the same address as the PC.
    phone_https_port: int = field(default_factory=lambda: int(os.getenv("PHONE_HTTPS_PORT", "0")))

    @property
    def uses_supabase_storage(self) -> bool:
        return bool(self.supabase_url and self.supabase_service_key)
