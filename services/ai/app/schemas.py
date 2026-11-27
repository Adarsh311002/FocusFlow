"""Request and result shapes. They mirror packages/contracts/src/http/ai.ts (camelCase JSON).

Inputs are bounded so a request can never carry bulk data; results are normalised (trimmed
and clipped) before they are validated, because a model may overshoot a length a little.
"""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

STEP_MAX = 140
STEPS_MAX = 5
LINE_MAX = 220
WINS_MAX = 3


class Camel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


# ---- Help me start ---------------------------------------------------------------------


class StepIn(Camel):
    title: str = Field(min_length=1, max_length=200)
    done: bool


class CheckInIn(Camel):
    outcome: Literal["done", "progress", "stuck"]
    note: str | None = Field(default=None, max_length=280)


class TaskIn(Camel):
    title: str = Field(min_length=1, max_length=200)
    goal: str | None = Field(default=None, max_length=120)
    estimated_sessions: int | None = Field(default=None, ge=1, le=20)
    sessions_spent: int = Field(ge=0)
    steps: list[StepIn] = Field(default_factory=list, max_length=30)


class FirstStepRequest(Camel):
    task: TaskIn
    recent_check_ins: list[CheckInIn] = Field(default_factory=list, max_length=5)


class FirstStepResult(Camel):
    first_step: str = Field(min_length=1, max_length=STEP_MAX)
    steps: list[str] = Field(min_length=1, max_length=STEPS_MAX)
    encouragement: str = Field(min_length=1, max_length=LINE_MAX)


# ---- Weekly reflection -------------------------------------------------------------------


class DayIn(Camel):
    date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    focused_seconds: int = Field(ge=0)
    completed_sessions: int = Field(ge=0)


class TotalsIn(Camel):
    focused_seconds: int = Field(ge=0)
    completed_sessions: int = Field(ge=0)
    intentions_done: int = Field(ge=0)
    stuck: int = Field(ge=0)


class PriorityIn(Camel):
    title: str = Field(min_length=1, max_length=200)
    done: bool


class TopTaskIn(Camel):
    title: str = Field(min_length=1, max_length=200)
    focused_seconds: int = Field(ge=0)


class WeeklyReflectionRequest(Camel):
    week_start: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    days: list[DayIn] = Field(min_length=7, max_length=7)
    totals: TotalsIn
    daily_goal_seconds: int = Field(ge=0)
    current_streak: int = Field(ge=0)
    notes: list[str] = Field(default_factory=list, max_length=20)
    priorities: list[PriorityIn] = Field(default_factory=list, max_length=3)
    top_tasks: list[TopTaskIn] = Field(default_factory=list, max_length=5)
    # Local hours (0-23) with the best rated depth, best first.
    deepest_hours: list[int] = Field(default_factory=list, max_length=3)


class WeeklyReflectionResult(Camel):
    headline: str = Field(min_length=1, max_length=LINE_MAX)
    wins: list[str] = Field(max_length=WINS_MAX)
    patterns: list[str] = Field(max_length=WINS_MAX)
    suggestion: str = Field(min_length=1, max_length=LINE_MAX)


# ---- Envelope -----------------------------------------------------------------------------


class Envelope(Camel):
    """What every endpoint answers: the result and whether a model or the mock wrote it."""

    source: Literal["model", "mock"]
    result: dict[str, object]


class ErrorBody(Camel):
    code: Literal["declined", "invalid_output", "unavailable", "provider_error", "unauthorized"]
    message: str
