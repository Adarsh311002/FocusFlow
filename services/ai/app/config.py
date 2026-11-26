"""Environment, validated once at startup (like the Node API's Zod config)."""

from functools import lru_cache
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # `mock` needs no key and sends nothing anywhere (docs/architecture/overview.md).
    ai_provider: Literal["mock", "anthropic"] = "mock"
    # The model used when AI_PROVIDER=anthropic.
    ai_model: str = "claude-opus-5-5"
    # Short, structured answers: low effort keeps them quick and cheap.
    ai_effort: Literal["low", "medium", "high"] = "low"
    # On a policy decline, let the API retry the same request on a fallback model.
    ai_refusal_fallback: bool = True
    ai_request_timeout_s: float = Field(default=45.0, ge=5, le=300)
    # Shared with the Node API (AI_INTERNAL_TOKEN there); the service is never public.
    ai_internal_token: str = Field(min_length=16)
    log_level: str = "info"


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
