"""LLM providers: a deterministic mock (no key, nothing leaves the machine) and Claude.

A provider turns a request into the raw JSON object the model wrote. Checking it is the
workflow's job (workflows.py), so both providers go through the same validation.
"""

import json
from datetime import date
from typing import Literal, Protocol

import anthropic

from .config import Settings
from .prompts import (
    FIRST_STEP_SCHEMA,
    SYSTEM,
    WEEKLY_SCHEMA,
    first_step_prompt,
    weekly_prompt,
)
from .schemas import FirstStepRequest, WeeklyReflectionRequest

Request = FirstStepRequest | WeeklyReflectionRequest


class ProviderFailure(Exception):
    """A failure the caller should see as an error body with this code."""

    def __init__(
        self,
        code: Literal["declined", "unavailable", "provider_error", "invalid_output"],
        message: str,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class Provider(Protocol):
    source: Literal["model", "mock"]

    def complete(self, request: Request, feedback: str | None = None) -> dict[str, object]: ...


# ---- Mock ---------------------------------------------------------------------------------


def _hm(seconds: int) -> str:
    hours, minutes = divmod(seconds // 60, 60)
    if hours == 0:
        return f"{minutes} min"
    return f"{hours} h {minutes} min" if minutes else f"{hours} h"


class MockProvider:
    """Plausible, deterministic answers built from the data alone (local work and tests)."""

    source: Literal["model", "mock"] = "mock"

    def complete(self, request: Request, feedback: str | None = None) -> dict[str, object]:
        if isinstance(request, FirstStepRequest):
            return self._first_step(request)
        return self._weekly(request)

    def _first_step(self, request: FirstStepRequest) -> dict[str, object]:
        task = request.task
        open_steps = [step.title for step in task.steps if not step.done]
        if open_steps:
            first = f"Open what you need for “{open_steps[0]}” and do its first two minutes."
            steps = [first, *open_steps[1:4], "Note where you stopped, so the next start is easy."]
        else:
            first = f"Write one line on what “done” looks like for “{task.title}”."
            steps = [
                first,
                "Gather what you need in one place: files, links, notes.",
                "Do the smallest real piece for 15 minutes, without polishing.",
                "Note what is left as the next step.",
            ]
        stuck = any(check.outcome == "stuck" for check in request.recent_check_ins)
        encouragement = (
            "Last time this got stuck, so the first step is tiny on purpose."
            if stuck
            else "Starting is the hard part. Five minutes is enough to get moving."
        )
        return {"firstStep": first, "steps": steps[:5], "encouragement": encouragement}

    def _weekly(self, request: WeeklyReflectionRequest) -> dict[str, object]:
        totals = request.totals
        active_days = [day for day in request.days if day.focused_seconds > 0]
        if totals.focused_seconds == 0:
            return {
                "headline": "This week was quiet: no focus sessions were recorded.",
                "wins": [],
                "patterns": [],
                "suggestion": "Pick one small task and give it a single 25-minute session.",
            }
        best = max(request.days, key=lambda day: day.focused_seconds)
        wins = [f"You focused {_hm(totals.focused_seconds)} over {len(active_days)} days."]
        if totals.intentions_done:
            wins.append(f"You finished {totals.intentions_done} intentions you set.")
        done_priorities = [p.title for p in request.priorities if p.done]
        if done_priorities:
            wins.append(f"“{done_priorities[0]}”, one of this week's three, is done.")
        weekday = date.fromisoformat(best.date).strftime("%A")
        patterns = [f"Your biggest day was {weekday}, with {_hm(best.focused_seconds)}."]
        if request.deepest_hours:
            patterns.append(f"Your deepest sessions started around {request.deepest_hours[0]}:00.")
        if totals.stuck:
            patterns.append(f"You got stuck {totals.stuck} times; smaller first steps may help.")
        goal_days = sum(
            1
            for day in request.days
            if request.daily_goal_seconds and day.focused_seconds >= request.daily_goal_seconds
        )
        suggestion = (
            f"You met your daily goal on {goal_days} days. Aim for one more next week."
            if goal_days
            else "Try one session at the same time each day next week."
        )
        return {
            "headline": f"A week of {_hm(totals.focused_seconds)} of focus.",
            "wins": wins[:3],
            "patterns": patterns[:3],
            "suggestion": suggestion,
        }


# ---- Claude -------------------------------------------------------------------------------


class AnthropicProvider:
    """Claude through the official SDK, with structured output and refusal fallbacks."""

    source: Literal["model", "mock"] = "model"

    def __init__(self, settings: Settings, client: anthropic.Anthropic | None = None) -> None:
        self._settings = settings
        # Credentials come from the environment (ANTHROPIC_API_KEY); never from a request.
        self._client = client or anthropic.Anthropic(
            timeout=settings.ai_request_timeout_s, max_retries=2
        )

    def complete(self, request: Request, feedback: str | None = None) -> dict[str, object]:
        if isinstance(request, FirstStepRequest):
            prompt, schema = first_step_prompt(request), FIRST_STEP_SCHEMA
        else:
            prompt, schema = weekly_prompt(request), WEEKLY_SCHEMA
        if feedback is not None:
            prompt = f"{prompt}\n\nYour previous answer was not usable: {feedback} Try again."

        extra: dict[str, object] = {}
        if self._settings.ai_refusal_fallback:
            extra = {"betas": ["server-side-fallback-2026-07-01"], "fallbacks": "default"}
        try:
            response = self._client.beta.messages.create(
                model=self._settings.ai_model,
                max_tokens=4000,
                system=SYSTEM,
                messages=[{"role": "user", "content": prompt}],
                output_config={
                    "effort": self._settings.ai_effort,
                    "format": {"type": "json_schema", "schema": schema},
                },
                **extra,  # type: ignore[arg-type]
            )
        except anthropic.RateLimitError as error:
            raise ProviderFailure("unavailable", "The model is busy right now.") from error
        except anthropic.APIStatusError as error:
            if error.status_code >= 500:
                raise ProviderFailure("unavailable", "The model is unavailable.") from error
            raise ProviderFailure(
                "provider_error", f"Model request refused: {error.message}"
            ) from error
        except anthropic.APIConnectionError as error:
            raise ProviderFailure("unavailable", "Could not reach the model.") from error

        if response.stop_reason == "refusal":
            raise ProviderFailure("declined", "The model declined to answer this one.")
        if response.stop_reason == "max_tokens":
            raise ProviderFailure("invalid_output", "The answer was cut off.")
        text = next((block.text for block in response.content if block.type == "text"), None)
        if text is None:
            raise ProviderFailure("invalid_output", "The model gave no answer.")
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError as error:
            raise ProviderFailure("invalid_output", "The answer was not valid JSON.") from error
        if not isinstance(parsed, dict):
            raise ProviderFailure("invalid_output", "The answer was not an object.")
        return parsed


def create_provider(settings: Settings) -> Provider:
    if settings.ai_provider == "anthropic":
        return AnthropicProvider(settings)
    return MockProvider()
