FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app
RUN pip install --no-cache-dir uv
COPY pyproject.toml uv.lock ./
COPY src ./src
RUN uv sync --frozen --no-dev
ENV PATH="/app/.venv/bin:$PATH"
EXPOSE 5190
CMD ["uvicorn", "image_hub.app:app", "--host", "0.0.0.0", "--port", "5190"]
