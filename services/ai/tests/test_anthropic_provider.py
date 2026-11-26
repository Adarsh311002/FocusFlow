"""The Claude provider against a fake SDK client: request shape and answer handling."""

import json
from types import SimpleNamespace

import pytest

from app.config import Settings
from app.providers import AnthropicProvider, ProviderFailure
from app.schemas import FirstStepRequest
from tests.test_api import FIRST_STEP


class FakeMessages:
    def __init__(self, response: object) -> None:
        self.response = response
        self.calls: list[dict[str, object]] = []

    def create(self, **kwargs: object) -> object:
        self.calls.append(kwargs)
        return self.response


def provider(response: object, **overrides: object) -> tuple[AnthropicProvider, FakeMessages]:
    messages = FakeMessages(response)
    fake = SimpleNamespace(beta=SimpleNamespace(messages=messages))
    settings = Settings(ai_internal_token="t" * 20, ai_provider="anthropic", **overrides)
    return AnthropicProvider(settings, client=fake), messages  # type: ignore[arg-type]


def answer(payload: object, stop_reason: str = "end_turn") -> object:
    return SimpleNamespace(
        stop_reason=stop_reason,
        content=[
            SimpleNamespace(type="thinking", thinking=""),
            SimpleNamespace(type="text", text=json.dumps(payload)),
        ],
    )


REQUEST = FirstStepRequest.model_validate(FIRST_STEP)


def test_sends_structured_output_effort_and_fallbacks() -> None:
    subject, messages = provider(answer({"firstStep": "a", "steps": ["a"], "encouragement": "b"}))
    assert subject.complete(REQUEST)["firstStep"] == "a"
    call = messages.calls[0]
    assert call["model"] == "claude-opus-5-5"
    assert call["output_config"]["effort"] == "low"  # type: ignore[index]
    assert call["output_config"]["format"]["type"] == "json_schema"  # type: ignore[index]
    assert call["fallbacks"] == "default"
    assert "<data>" in call["messages"][0]["content"]  # type: ignore[index]


def test_fallbacks_can_be_turned_off() -> None:
    subject, messages = provider(
        answer({"firstStep": "a", "steps": ["a"], "encouragement": "b"}), ai_refusal_fallback=False
    )
    subject.complete(REQUEST)
    assert "fallbacks" not in messages.calls[0]


@pytest.mark.parametrize(
    ("response", "code"),
    [
        (answer({}, stop_reason="refusal"), "declined"),
        (answer({}, stop_reason="max_tokens"), "invalid_output"),
        (SimpleNamespace(stop_reason="end_turn", content=[]), "invalid_output"),
    ],
)
def test_turns_unusable_answers_into_failures(response: object, code: str) -> None:
    subject, _ = provider(response)
    with pytest.raises(ProviderFailure) as raised:
        subject.complete(REQUEST)
    assert raised.value.code == code
