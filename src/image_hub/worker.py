import socket
import threading
import uuid
from datetime import timedelta

from sqlalchemy import select, update

from image_hub.config import settings
from image_hub.db import SessionLocal
from image_hub.models import Generation, utcnow
from image_hub.providers import execute_generation


class GenerationWorker:
    def __init__(self) -> None:
        self.worker_id = f"{socket.gethostname()}:{uuid.uuid4().hex[:8]}"
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self.reconcile_stale()
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="image-hub-worker", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()
        if self._thread:
            self._thread.join(timeout=5)

    def wake(self) -> None:
        self._wake.set()

    def _run(self) -> None:
        while not self._stop.is_set():
            generation_id = self.claim_next()
            if generation_id:
                execute_generation(generation_id)
                continue
            self._wake.wait(settings.worker_poll_seconds)
            self._wake.clear()

    def claim_next(self) -> str | None:
        now = utcnow()
        with SessionLocal() as session:
            candidate = session.scalar(
                select(Generation.id).where(Generation.status == "queued").order_by(Generation.created_at).limit(1)
            )
            if not candidate:
                return None
            result = session.execute(
                update(Generation).where(Generation.id == candidate, Generation.status == "queued").values(
                    status="running", started_at=now, attempt_count=Generation.attempt_count + 1,
                    lease_owner=self.worker_id,
                    lease_expires_at=now + timedelta(minutes=settings.worker_stale_minutes),
                )
            )
            session.commit()
            return candidate if result.rowcount == 1 else None

    def reconcile_stale(self) -> int:
        now = utcnow()
        with SessionLocal() as session:
            stale = session.scalars(
                select(Generation).where(
                    Generation.status == "running", Generation.lease_expires_at.is_not(None),
                    Generation.lease_expires_at < now,
                )
            ).all()
            for generation in stale:
                generation.status = "recovery_required"
                generation.error_message = "执行进程中断；为避免重复扣费，任务没有自动重提。"
                generation.lease_owner = ""
                generation.lease_expires_at = None
            session.commit()
            return len(stale)


generation_worker = GenerationWorker()
