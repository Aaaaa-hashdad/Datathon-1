"""Settings, read from environment variables or backend/.env.

Leave DATABASE_URL empty to run fully local (SQLite).
"""

import os
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
    # Port where run.py serves the phone camera page over HTTPS (phones only allow
    # camera access on HTTPS). 0 = send the phone to the same address as the PC.
    phone_https_port: int = field(default_factory=lambda: int(os.getenv("PHONE_HTTPS_PORT", "0")))

    # The team's UI folder (ui/ from the front-end branch), served unchanged at /ui/.
    ui_dir: Path = field(default_factory=lambda: Path(os.getenv("UI_DIR", BACKEND_DIR.parent / "ui")))
