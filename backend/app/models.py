"""Database tables: users, scanned sets, and the reps inside each set."""

from datetime import date, datetime, timezone

from sqlalchemy import JSON, Boolean, Date, DateTime, Float, ForeignKey, Index, Integer, String
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
    # Profile, collected at sign-up (optional for accounts made before it existed).
    grad_year: Mapped[int | None] = mapped_column(Integer, nullable=True)         # e.g. 2027 -> "Class of '27"
    major: Mapped[str | None] = mapped_column(String(80), nullable=True)
    weight_lb: Mapped[float | None] = mapped_column(Float, nullable=True)         # body weight
    height_in: Mapped[float | None] = mapped_column(Float, nullable=True)         # total inches (5 ft 10 in = 70)
    gender: Mapped[str | None] = mapped_column(String(24), nullable=True)
    birth_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    # Shown in the team's UI; can be set later with PATCH /me/profile.
    display_name: Mapped[str | None] = mapped_column(String(60), nullable=True)
    home_gym: Mapped[str | None] = mapped_column(String(16), nullable=True)       # rec / polo / other
    weekly_goal: Mapped[int | None] = mapped_column(Integer, nullable=True)

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
    """A phone linked to a user's account. It's only the live camera; no video is stored."""

    __tablename__ = "devices"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(60), nullable=False)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    user: Mapped[User] = relationship()


class ScanSet(Base):
    """One set, as measured by the computer-vision scan (sent to POST /scans)."""

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
    # Joint angles in degrees measured at the key position, e.g. {"knee_angle_min": 92}.
    angles: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)

    scan_set: Mapped[ScanSet] = relationship(back_populates="reps")


class WorkoutResult(Base):
    """Phone Cam's analysis of a recording, which can contain several exercises."""

    __tablename__ = "workout_results"

    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), primary_key=True)
    source: Mapped[str] = mapped_column(String(100), primary_key=True)
    recorded_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)
    exercises: Mapped[list[dict]] = mapped_column(JSON, nullable=False)


class GuestCounter(Base):
    """How many times "Guest Log In" has been used. Judge N is the N-th press; reset sets it back to 0."""

    __tablename__ = "guest_counter"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
