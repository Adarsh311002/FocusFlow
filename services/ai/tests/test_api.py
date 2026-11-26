from typing import Literal

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.providers import MockProvider, ProviderFailure, Request
from app.workflows import normalise

TOKEN = "test-internal-token-123456"


def settings() -> Settings:
    return Settings(ai_internal_token=TOKEN, ai_provider="mock")


def client(provider=None) -> TestClient:
    return TestClient(create_app(settings(), provider))


FIRST_STEP = {
    "task": {
        "title": "Write the quarterly report",
        "goal": "Ship Q4",
        "estimatedSessions": 3,
        "sessionsSpent": 1,
        "steps": [{"title": "Collect numbers", "done": True}, {"title": "Draft", "done": False}],
    },
    "recentCheckIns": [{"outcome": "stuck", "note": "Did not know where to begin"}],
}

WEEK = {
    "weekStart": "2026-11-16",
    "days": [
        {"date": f"2026-11-{16 + i}", "focusedSeconds": s, "completedSessions": c}
        for i, (s, c) in enumerate(
            [(3000, 2), (0, 0), (7200, 3), (1500, 1), (0, 0), (0, 0), (0, 0)]
        )
    ],
    "totals": {"focusedSeconds": 11700, "completedSessions": 6, "intentionsDone": 2, "stuck": 1},
    "dailyGoalSeconds": 7200,
    "currentStreak": 0,
    "notes": ["Good flow in the morning"],
    "priorities": [{"title": "Launch page", "done": True}],
    "topTasks": [{"title": "Launch page", "focusedSeconds": 6000}],
    "deepestHours": [9],
}


def test_health_needs_no_token() -> None:
    assert client().get("/healthz").json() == {"status": "ok"}


def test_refuses_without_the_internal_token() -> None:
    response = client().post("/v1/first-step", json=FIRST_STEP)
    assert response.status_code == 401
    assert response.json()["code"] == "unauthorized"


def test_mock_first_step_builds_on_open_steps() -> None:
    response = client().post("/v1/first-step", json=FIRST_STEP, headers={"X-Internal-Token": TOKEN})
    assert response.status_code == 200
    body = response.json()
    assert body["source"] == "mock"
    assert "Draft" in body["result"]["firstStep"]
    assert 1 <= len(body["result"]["steps"]) <= 5
    assert "stuck" in body["result"]["encouragement"]


def test_mock_weekly_reflection_is_grounded_in_the_numbers() -> None:
    response = client().post(
        "/v1/weekly-reflection", json=WEEK, headers={"X-Internal-Token": TOKEN}
    )
    assert response.status_code == 200
    result = response.json()["result"]
    assert "3 h 15 min" in result["headline"]
    assert any("2 intentions" in win for win in result["wins"])
    assert len(result["wins"]) <= 3


def test_rejects_unknown_fields() -> None:
    response = client().post(
        "/v1/first-step", json={**FIRST_STEP, "extra": 1}, headers={"X-Internal-Token": TOKEN}
    )
    assert response.status_code == 422


class Flaky:
    """Answers badly first, well second: the workflow retries once with feedback."""

    source: Literal["model", "mock"] = "model"

    def __init__(self) -> None:
        self.feedback: list[str | None] = []

    def complete(self, request: Request, feedback: str | None = None) -> dict[str, object]:
        self.feedback.append(feedback)
        if len(self.feedback) == 1:
            return {"firstStep": "", "steps": [], "encouragement": ""}
        return MockProvider().complete(request)


def test_retries_an_unusable_answer_once_with_the_reason() -> None:
    provider = Flaky()
    response = client(provider).post(
        "/v1/first-step", json=FIRST_STEP, headers={"X-Internal-Token": TOKEN}
    )
    assert response.status_code == 200
    assert response.json()["source"] == "model"
    assert provider.feedback[0] is None
    assert provider.feedback[1] is not None and "firstStep" in provider.feedback[1]


class Declining:
    source: Literal["model", "mock"] = "model"

    def complete(self, request: Request, feedback: str | None = None) -> dict[str, object]:
        raise ProviderFailure("declined", "No.")


class Down:
    source: Literal["model", "mock"] = "model"

    def complete(self, request: Request, feedback: str | None = None) -> dict[str, object]:
        raise ProviderFailure("unavailable", "Down.")


@pytest.mark.parametrize(
    ("provider", "status", "code"), [(Declining(), 422, "declined"), (Down(), 503, "unavailable")]
)
def test_maps_provider_failures(provider, status: int, code: str) -> None:
    response = client(provider).post(
        "/v1/first-step", json=FIRST_STEP, headers={"X-Internal-Token": TOKEN}
    )
    assert response.status_code == status
    assert response.json()["code"] == code


def test_normalise_clips_overlong_lines() -> None:
    from app.schemas import FirstStepRequest

    request = FirstStepRequest.model_validate(FIRST_STEP)
    out = normalise(request, {"firstStep": "x " * 200, "steps": ["a"] * 9, "encouragement": "ok"})
    assert len(str(out["firstStep"])) <= 140
    assert len(out["steps"]) == 5  # type: ignore[arg-type]
