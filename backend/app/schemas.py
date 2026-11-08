"""Request and response shapes for the API."""

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from .scoring import Exercise


GENDERS = ("male", "female", "nonbinary", "other", "prefer_not_to_say")
Gender = Literal["male", "female", "nonbinary", "other", "prefer_not_to_say"]


def _check_birth_date(value: date | None) -> date | None:
    if value is None:
        return value
    today = date.today()
    age = today.year - value.year - ((today.month, today.day) < (value.month, value.day))
    if value > today:
        raise ValueError("Date of birth can't be in the future.")
    if age < 13:
        raise ValueError("You need to be at least 13 to use RevGym.")
    if age > 100:
        raise ValueError("Please check your date of birth.")
    return value


def _check_grad_year(value: int | None) -> int | None:
    if value is not None and not 1950 <= value <= date.today().year + 8:
        raise ValueError("Please check your graduation year.")
    return value


class Credentials(BaseModel):
    username: str = Field(min_length=2, max_length=32, pattern=r"^[A-Za-z0-9_.]+$")
    password: str = Field(min_length=8, max_length=128)


class SignUpIn(Credentials):
    """Sign up: login details plus the profile. The profile fields are required here."""

    grad_year: int
    major: str = Field(min_length=2, max_length=80)
    weight_lb: float = Field(ge=50, le=700)
    height_in: float = Field(ge=36, le=96)          # 3 ft to 8 ft
    gender: Gender
    birth_date: date

    _grad = field_validator("grad_year")(_check_grad_year)
    _born = field_validator("birth_date")(_check_birth_date)
    _major = field_validator("major")(lambda v: v.strip())


class UserOut(BaseModel):
    """Your own account, including the private profile fields (only ever sent to you)."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    username: str
    created_at: datetime
    grad_year: int | None = None
    major: str | None = None
    weight_lb: float | None = None
    height_in: float | None = None
    gender: str | None = None
    birth_date: date | None = None
    display_name: str | None = None
    home_gym: str | None = None
    weekly_goal: int | None = None


class ProfileIn(BaseModel):
    """Change any profile field later. Leave out the ones you're not changing."""

    grad_year: int | None = None
    major: str | None = Field(default=None, min_length=2, max_length=80)
    weight_lb: float | None = Field(default=None, ge=50, le=700)
    height_in: float | None = Field(default=None, ge=36, le=96)
    gender: Gender | None = None
    birth_date: date | None = None
    display_name: str | None = Field(default=None, max_length=60)
    home_gym: Literal["rec", "polo", "other"] | None = None
    weekly_goal: int | None = Field(default=None, ge=1, le=7)

    _grad = field_validator("grad_year")(_check_grad_year)
    _born = field_validator("birth_date")(_check_birth_date)


class AuthOut(BaseModel):
    token: str
    user: UserOut


class PairCodeOut(BaseModel):
    code: str
    expires_at: datetime
    # Address the QR code opens on the phone (same Wi-Fi as the PC). Includes the code.
    phone_url: str
    # The QR code as an SVG data URI, ready for <img src>.
    qr_svg: str


class LiveOfferIn(BaseModel):
    sdp: str = Field(min_length=10, max_length=20000)


class LiveAnswerIn(BaseModel):
    offer_id: int
    sdp: str = Field(min_length=10, max_length=20000)


class PhoneStateIn(BaseModel):
    camera: bool = False


class PairIn(BaseModel):
    code: str = Field(min_length=4, max_length=16)
    device_name: str = Field(default="Phone", min_length=1, max_length=60)


class PairOut(BaseModel):
    device_token: str
    username: str


class DeviceOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    created_at: datetime
    last_seen_at: datetime | None
    # Live camera status (phone page open and checking in).
    online: bool = False
    camera: bool = False


class RepIn(BaseModel):
    form_score: float = Field(ge=0, le=100)
    # Joint angles in degrees from the pose pipeline, e.g. {"elbow_tuck": 62.5}.
    angles: dict[str, float] = Field(default_factory=dict)


class ScanIn(BaseModel):
    """What the phone sends after analysing a recorded set (for the logged-in user)."""

    exercise: Exercise
    weight_lb: float = Field(ge=0, le=2000)
    reps: list[RepIn] = Field(min_length=1, max_length=100)
    recorded_at: datetime | None = None


class RepOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    index: int
    form_score: float
    angles: dict[str, float]


class ScanOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    user_id: int
    exercise: Exercise
    weight_lb: float
    rep_count: int
    form_score: float
    qualified: bool
    points: int
    recorded_at: datetime
    reps: list[RepOut]


class LeaderboardEntry(BaseModel):
    rank: int
    user_id: int
    username: str
    # all-lifts board: total points. Per-lift board: best set's weight.
    value: float
    weight_lb: float | None = None
    reps: int | None = None
    form_score: float | None = None


class MyStanding(BaseModel):
    entry: LeaderboardEntry
    next_up: LeaderboardEntry | None = None
    # How much `value` must grow to tie the person directly above.
    gap_to_next: float | None = None


class LeaderboardOut(BaseModel):
    exercise: Literal["all"] | Exercise
    period: Literal["week", "all_time"]
    metric: Literal["points", "weight_lb"]
    total_ranked: int
    entries: list[LeaderboardEntry]
    me: MyStanding | None = None
