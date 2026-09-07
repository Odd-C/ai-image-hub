from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from starlette.middleware.sessions import SessionMiddleware

from image_hub.config import settings
from image_hub.db import init_database
from image_hub.web import router
from image_hub.worker import generation_worker


@asynccontextmanager
async def lifespan(_: FastAPI):
    settings.ensure_directories()
    init_database()
    if settings.worker_enabled:
        generation_worker.start()
    try:
        yield
    finally:
        if settings.worker_enabled:
            generation_worker.stop()


app = FastAPI(title="AI Image Hub", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    SessionMiddleware,
    secret_key=settings.session_secret,
    same_site="lax",
    https_only=settings.env == "production",
    max_age=60 * 60 * 12,
)
app.mount("/static", StaticFiles(directory=settings.static_dir), name="static")
app.include_router(router)
