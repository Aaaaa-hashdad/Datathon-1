"""Database tables: users, scanned sets, and the reps inside each set."""

from datetime import datetime, timezone

from sqlalchemy import JSON, Boolean, DateTime, Float, ForeignKey, Index, Integer, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def utcnow() -> datetime:
    # Stored as naive UTC so SQLite comparisons are consistent.
    return datetime.now(timezone.utc).replace(tzinfo=None)


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    username: Mapped[str] = mapped_column(String(32), unique=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(String(200), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)

    sets: Mapped[list["ScanSet"]] = relationship(back_populates="user")


class LoginSession(Base):
    """A logged-in device. Only the SHA-256 of the token is stored."""

    __tablename__ = "login_sessions"

    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)

    user: Mapped[User] = relationship()


class PairCode(Base):
    """Short-lived code shown on the PC and typed into the phone to link it."""

    __tablename__ = "pair_codes"

    code: Mapped[str] = mapped_column(String(16), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)


class Device(Base):
    """A phone linked to a user's account. It can only upload recordings."""

    __tablename__ = "devices"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(60), nullable=False)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    user: Mapped[User] = relationship()


class Recording(Base):
    """A video recorded on a linked phone and synced to the PC."""

    __tablename__ = "recordings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False, index=True)
    device_id: Mapped[int | None] = mapped_column(ForeignKey("devices.id", ondelete="SET NULL"), nullable=True)
    exercise: Mapped[str] = mapped_column(String(32), nullable=False)
    stored_name: Mapped[str] = mapped_column(String(80), nullable=False)
    content_type: Mapped[str] = mapped_column(String(80), nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    # "uploaded" now; the pose-analysis step will move it to "analyzed".
    status: Mapped[str] = mapped_column(String(20), default="uploaded", nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)

    device: Mapped[Device | None] = relationship()


class ScanSet(Base):
    """One recorded set, as analysed by the phone's pose pipeline."""

    __tablename__ = "scan_sets"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    exercise: Mapped[str] = mapped_column(String(32), nullable=False)
    weight_lb: Mapped[float] = mapped_column(Float, nullable=False)
    rep_count: Mapped[int] = mapped_column(Integer, nullable=False)
    form_score: Mapped[float] = mapped_column(Float, nullable=False)
    qualified: Mapped[bool] = mapped_column(Boolean, nullable=False)
    points: Mapped[int] = mapped_column(Integer, nullable=False)
    recorded_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)

    user: Mapped[User] = relationship(back_populates="sets")
    reps: Mapped[list["Rep"]] = relationship(
        back_populates="scan_set", cascade="all, delete-orphan", order_by="Rep.index"
    )

    __table_args__ = (
        Index("ix_sets_exercise_qualified_time", "exercise", "qualified", "recorded_at"),
        Index("ix_sets_user", "user_id"),
    )


class Rep(Base):
    __tablename__ = "reps"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    set_id: Mapped[int] = mapped_column(ForeignKey("scan_sets.id"), nullable=False)
    index: Mapped[int] = mapped_column(Integer, nullable=False)
    form_score: Mapped[float] = mapped_column(Float, nullable=False)
    # Joint angles in degrees measured at the key position, e.g. {"elbow_tuck": 62}.
    angles: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)

    scan_set: Mapped[ScanSet] = relationship(back_populates="reps")
