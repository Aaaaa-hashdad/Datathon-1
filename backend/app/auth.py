"""Password hashing and login sessions (standard library only).

Passwords are hashed with scrypt and a random salt. A login creates a random
token; only its SHA-256 is stored, so a leaked database can't be used to log in.
"""

import hashlib
import hmac
import secrets
from datetime import timedelta

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import LoginSession, User, utcnow

SESSION_LIFETIME = timedelta(days=30)
_SCRYPT = {"n": 2**14, "r": 8, "p": 1, "dklen": 32}

bearer = HTTPBearer(auto_error=False)


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, **_SCRYPT)
    return f"scrypt${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, salt_hex, digest_hex = stored.split("$")
    except ValueError:
        return False
    if scheme != "scrypt":
        return False
    digest = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt_hex), **_SCRYPT)
    return hmac.compare_digest(digest.hex(), digest_hex)


# Used when a username doesn't exist, so a failed login takes about as long
# either way and doesn't reveal which usernames are registered.
_DUMMY_HASH = hash_password(secrets.token_hex(8))


def check_login(db: Session, username: str, password: str) -> User | None:
    user = db.scalar(select(User).where(User.username == username))
    if user is None:
        verify_password(password, _DUMMY_HASH)
        return None
    return user if verify_password(password, user.password_hash) else None


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def start_session(db: Session, user: User) -> str:
    token = secrets.token_urlsafe(32)
    now = utcnow()
    db.add(LoginSession(token_hash=_token_hash(token), user_id=user.id,
                        created_at=now, expires_at=now + SESSION_LIFETIME))
    db.commit()
    return token


def end_session(db: Session, token: str) -> None:
    session = db.get(LoginSession, _token_hash(token))
    if session is not None:
        db.delete(session)
        db.commit()


def user_for_token(db: Session, token: str) -> User | None:
    session = db.get(LoginSession, _token_hash(token))
    if session is None:
        return None
    if session.expires_at <= utcnow():
        db.delete(session)
        db.commit()
        return None
    return session.user


def make_auth_dependencies(get_db):
    """Build FastAPI dependencies bound to this app's database session."""

    def optional_user(
        creds: HTTPAuthorizationCredentials | None = Depends(bearer),
        db: Session = Depends(get_db),
    ) -> User | None:
        if creds is None:
            return None
        return user_for_token(db, creds.credentials)

    def current_user(
        creds: HTTPAuthorizationCredentials | None = Depends(bearer),
        db: Session = Depends(get_db),
    ) -> User:
        user = user_for_token(db, creds.credentials) if creds else None
        if user is None:
            raise HTTPException(
                status.HTTP_401_UNAUTHORIZED,
                "not logged in",
                headers={"WWW-Authenticate": "Bearer"},
            )
        return user

    return optional_user, current_user
