"""The LangGraph workflow shared by both features: generate → check → (one retry) → done.

The graph owns the part that is not a single call: normalising what the model wrote,
validating it with Pydantic, and asking once more with the reason when it is unusable.
"""

from typing import Any, TypedDict

from langgraph.graph import END, START, StateGraph
from pydantic import BaseModel, ValidationError

from .providers import Provider, ProviderFailure, Request
from .schemas import (
    LINE_MAX,
    STEP_MAX,
    STEPS_MAX,
    WINS_MAX,
    FirstStepRequest,
    FirstStepResult,
    WeeklyReflectionResult,
)

MAX_ATTEMPTS = 2


class State(TypedDict, total=False):
    request: Request
    raw: dict[str, object] | None
    feedback: str | None
    attempts: int
    result: BaseModel | None


def _clip(value: object, limit: int) -> str:
    text = " ".join(str(value).split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _lines(value: object, limit: int, count: int) -> list[str]:
    if not isinstance(value, list):
        return []
    return [_clip(item, limit) for item in value if str(item).strip()][:count]


def normalise(request: Request, raw: dict[str, object]) -> dict[str, object]:
    """Trims whitespace and clips lengths, so a slight overshoot is not a failure."""
    if isinstance(request, FirstStepRequest):
        return {
            "firstStep": _clip(raw.get("firstStep", ""), STEP_MAX),
            "steps": _lines(raw.get("steps"), STEP_MAX, STEPS_MAX),
            "encouragement": _clip(raw.get("encouragement", ""), LINE_MAX),
        }
    return {
        "headline": _clip(raw.get("headline", ""), LINE_MAX),
        "wins": _lines(raw.get("wins"), LINE_MAX, WINS_MAX),
        "patterns": _lines(raw.get("patterns"), LINE_MAX, WINS_MAX),
        "suggestion": _clip(raw.get("suggestion", ""), LINE_MAX),
    }


def build_graph(provider: Provider) -> Any:
    def generate(state: State) -> State:
        attempts = state.get("attempts", 0) + 1
        raw = provider.complete(state["request"], state.get("feedback"))
        return {"raw": raw, "attempts": attempts}

    def check(state: State) -> State:
        request = state["request"]
        model: type[BaseModel] = (
            FirstStepResult if isinstance(request, FirstStepRequest) else WeeklyReflectionResult
        )
        try:
            result = model.model_validate(normalise(request, state.get("raw") or {}))
        except ValidationError as error:
            fields = ", ".join(".".join(map(str, issue["loc"])) for issue in error.errors())
            return {"result": None, "feedback": f"These fields were missing or empty: {fields}."}
        return {"result": result, "feedback": None}

    def route(state: State) -> str:
        if state.get("result") is not None or state.get("attempts", 0) >= MAX_ATTEMPTS:
            return END
        return "generate"

    graph = StateGraph(State)
    graph.add_node("generate", generate)
    graph.add_node("check", check)
    graph.add_edge(START, "generate")
    graph.add_edge("generate", "check")
    graph.add_conditional_edges("check", route, ["generate", END])
    return graph.compile()


def run(provider: Provider, request: Request) -> BaseModel:
    """Runs the workflow; raises ProviderFailure when no usable answer came back."""
    final = build_graph(provider).invoke({"request": request, "attempts": 0})
    result = final.get("result")
    if result is None:
        raise ProviderFailure("invalid_output", final.get("feedback") or "No usable answer.")
    return result
