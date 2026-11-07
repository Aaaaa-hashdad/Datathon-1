"""Where recorded videos live: a private Supabase Storage bucket, or a local folder.

Either way the PC gets a short-lived link it can put straight into a <video> tag.
"""

import hashlib
import hmac
import shutil
import time
from pathlib import Path
from typing import Protocol

import httpx

LINK_LIFETIME_SECONDS = 15 * 60


class VideoStore(Protocol):
    def put(self, name: str, source: Path, content_type: str) -> None: ...
    def play_url(self, name: str) -> str: ...


class LocalStore:
    """Files in a folder, served back through signed /media links."""

    def __init__(self, folder: Path, secret: str):
        self.folder = Path(folder)
        self.secret = secret.encode()

    def put(self, name: str, source: Path, content_type: str) -> None:
        self.folder.mkdir(parents=True, exist_ok=True)
        shutil.move(str(source), self.folder / name)

    def _sig(self, name: str, expires: int) -> str:
        return hmac.new(self.secret, f"{name}:{expires}".encode(), hashlib.sha256).hexdigest()

    def play_url(self, name: str) -> str:
        expires = int(time.time()) + LINK_LIFETIME_SECONDS
        return f"/media/{name}?exp={expires}&sig={self._sig(name, expires)}"

    def open_signed(self, name: str, exp: int, sig: str) -> Path | None:
        """The file for a valid, unexpired link, else None."""
        if exp < time.time() or not hmac.compare_digest(sig, self._sig(name, exp)):
            return None
        path = (self.folder / name).resolve()
        if path.parent != self.folder.resolve() or not path.is_file():
            return None
        return path


class SupabaseStore:
    """A private Supabase Storage bucket, used with the service role key (server side only)."""

    def __init__(self, url: str, service_key: str, bucket: str, client: httpx.Client | None = None):
        self.base = f"{url}/storage/v1"
        self.bucket = bucket
        self.http = client or httpx.Client(timeout=120)
        # New-style secret keys (sb_secret_...) go only in `apikey`; Supabase fills in
        # the rest. Older service_role keys are JWTs and also go in Authorization.
        self.headers = {"apikey": service_key}
        if not service_key.startswith("sb_"):
            self.headers["Authorization"] = f"Bearer {service_key}"

    def ensure_bucket(self) -> None:
        res = self.http.post(f"{self.base}/bucket", headers=self.headers,
                             json={"id": self.bucket, "name": self.bucket, "public": False})
        # 409 / "already exists" is fine.
        if res.status_code >= 400 and "already exists" not in res.text.lower() and res.status_code != 409:
            res.raise_for_status()

    def put(self, name: str, source: Path, content_type: str) -> None:
        with Path(source).open("rb") as fh:
            res = self.http.post(
                f"{self.base}/object/{self.bucket}/{name}",
                headers={**self.headers, "Content-Type": content_type, "x-upsert": "false"},
                content=fh,
            )
        res.raise_for_status()
        Path(source).unlink(missing_ok=True)

    def play_url(self, name: str) -> str:
        res = self.http.post(f"{self.base}/object/sign/{self.bucket}/{name}", headers=self.headers,
                             json={"expiresIn": LINK_LIFETIME_SECONDS})
        res.raise_for_status()
        signed = res.json()["signedURL"]  # e.g. "/object/sign/recordings/abc.mp4?token=..."
        return f"{self.base}{signed}"
