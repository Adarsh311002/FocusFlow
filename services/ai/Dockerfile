# Focus Flow AI service (Python, uv). Built and run by infra/compose.yaml for local work;
# `docker build --target test services/ai` runs the lint and the tests.

FROM python:3.13-slim AS base
COPY --from=ghcr.io/astral-sh/uv:0.9 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy PYTHONUNBUFFERED=1
WORKDIR /srv
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev
COPY app ./app

FROM base AS test
RUN uv sync --frozen
COPY tests ./tests
RUN uv run ruff check app tests && uv run pytest -q

FROM base AS runtime
RUN useradd --system --uid 10001 ai
USER ai
EXPOSE 8000
CMD ["/srv/.venv/bin/uvicorn", "app.main:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000"]
