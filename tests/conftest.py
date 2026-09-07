import os
from pathlib import Path

TEST_ROOT = Path(__file__).parent / ".runtime"
os.environ["IMAGE_HUB_DATABASE_URL"] = f"sqlite:///{TEST_ROOT / 'test.db'}"
os.environ["IMAGE_HUB_STORAGE_ROOT"] = str(TEST_ROOT / "storage")
os.environ["IMAGE_HUB_SESSION_SECRET"] = "test-session-secret"
os.environ["IMAGE_HUB_BOOTSTRAP_ADMIN_USERNAME"] = "admin"
os.environ["IMAGE_HUB_BOOTSTRAP_ADMIN_PASSWORD"] = "test-password"
os.environ["IMAGE_HUB_WORKER_ENABLED"] = "false"


def pytest_sessionstart(session):
    TEST_ROOT.mkdir(parents=True, exist_ok=True)
    database = TEST_ROOT / "test.db"
    if database.exists():
        database.unlink()
