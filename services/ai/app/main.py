"""The internal HTTP API the Node worker calls. Never exposed publicly (overview.md)."""

import hmac
from typing import Annotated

import structlog
from fastapi import Depends, FastAPI, Header, Request
from fastapi.responses import JSONResponse

from .config import Settings, get_settings
from .providers import Provider, ProviderFailure, create_provider
from .schemas import Envelope, ErrorBody, FirstStepRequest, WeeklyReflectionRequest
from .workflows import run

log = structlog.get_logger()

# unavailable → the caller may retry; every other failure is final for that job.
STATUS = {
    "declined": 422,
    "invalid_output": 422,
    "provider_error": 502,
    "unavailable": 503,
    "unauthorized": 401,
}


class Unauthorized(Exception):
    pass


def create_app(settings: Settings | None = None, provider: Provider | None = None) -> FastAPI:
    app = FastAPI(title="Focus Flow AI", docs_url=None, redoc_url=None, openapi_url=None)
    app.state.settings = settings or get_settings()
    app.state.provider = provider or create_provider(app.state.settings)

    def authorised(x_internal_token: Annotated[str | None, Header()] = None) -> None:
        expected = app.state.settings.ai_internal_token
        if x_internal_token is None or not hmac.compare_digest(x_internal_token, expected):
            raise Unauthorized()

    @app.exception_handler(Unauthorized)
    async def on_unauthorized(_request: Request, _error: Unauthorized) -> JSONResponse:
        body = ErrorBody(code="unauthorized", message="Missing or wrong internal token.")
        return JSONResponse(status_code=401, content=body.model_dump(by_alias=True))

    @app.exception_handler(ProviderFailure)
    async def on_failure(_request: Request, error: ProviderFailure) -> JSONResponse:
        log.warning("ai_request_failed", code=error.code, reason=error.message)
        body = ErrorBody(code=error.code, message=error.message)
        return JSONResponse(status_code=STATUS[error.code], content=body.model_dump(by_alias=True))

    @app.get("/healthz")
    def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/readyz")
    def readyz() -> dict[str, str]:
        return {"status": "ok", "provider": app.state.provider.source}

    # Plain `def`: the SDK call blocks, so FastAPI runs these in its thread pool.
    @app.post("/v1/first-step", dependencies=[Depends(authorised)])
    def first_step(body: FirstStepRequest) -> dict[str, object]:
        result = run(app.state.provider, body)
        log.info("ai_first_step", source=app.state.provider.source)
        return Envelope(
            source=app.state.provider.source, result=result.model_dump(by_alias=True)
        ).model_dump(by_alias=True)

    @app.post("/v1/weekly-reflection", dependencies=[Depends(authorised)])
    def weekly_reflection(body: WeeklyReflectionRequest) -> dict[str, object]:
        result = run(app.state.provider, body)
        log.info("ai_weekly_reflection", source=app.state.provider.source)
        return Envelope(
            source=app.state.provider.source, result=result.model_dump(by_alias=True)
        ).model_dump(by_alias=True)

    return app
