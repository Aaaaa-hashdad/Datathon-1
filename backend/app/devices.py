"""Linking a phone as the live camera.

Flow: the PC shows a QR code (phone address + one-time code) -> the phone scans
it, opens /phone and links automatically -> the phone gets its own device token
and streams its camera live to the PC. No video is stored.
"""

import hashlib
import secrets
import socket
from datetime import timedelta

from fastapi import Depends, Header, HTTPException, status
from sqlalchemy import delete
from sqlalchemy.orm import Session

from .models import Device, PairCode, User, utcnow

PAIR_CODE_LIFETIME = timedelta(minutes=10)
# No 0/O or 1/I/L so codes are easy to read off a screen. 31^6 ≈ 887 million.
_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
CODE_LENGTH = 6


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def new_pair_code(db: Session, user: User) -> PairCode:
    now = utcnow()
    # Clear this user's old codes and anything expired.
    db.execute(delete(PairCode).where((PairCode.user_id == user.id) | (PairCode.expires_at <= now)))
    code = "".join(secrets.choice(_CODE_ALPHABET) for _ in range(CODE_LENGTH))
    pair = PairCode(code=code, user_id=user.id, expires_at=now + PAIR_CODE_LIFETIME)
    db.add(pair)
    db.commit()
    return pair


def redeem_pair_code(db: Session, code: str, device_name: str) -> tuple[str, User]:
    """Single use: the code is deleted whether or not it had expired."""
    pair = db.get(PairCode, code.strip().upper())
    if pair is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "That code didn't work. Check it on your PC.")
    expired = pair.expires_at <= utcnow()
    user_id = pair.user_id
    db.delete(pair)
    if expired:
        db.commit()
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "That code expired. Get a new one on your PC.")

    token = secrets.token_urlsafe(32)
    device = Device(user_id=user_id, name=device_name.strip() or "Phone", token_hash=_hash(token))
    db.add(device)
    db.commit()
    return token, db.get(User, user_id)


def make_device_dependency(get_db):
    def current_device(
        x_device_token: str | None = Header(default=None),
        db: Session = Depends(get_db),
    ) -> Device:
        device = None
        if x_device_token:
            device = db.query(Device).filter(Device.token_hash == _hash(x_device_token)).one_or_none()
        if device is None:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "This phone isn't linked. Pair it again from your PC.")
        device.last_seen_at = utcnow()
        db.commit()
        return device

    return current_device


def qr_svg_data_uri(text: str) -> str:
    """A QR code for `text` as an SVG data URI (generated locally, works offline)."""
    import segno

    return segno.make(text, error="m").svg_data_uri(scale=8, border=2, dark="#500000", light="#ffffff")


def lan_address() -> str:
    """Best guess at this PC's address on the local network (no traffic is sent)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()
