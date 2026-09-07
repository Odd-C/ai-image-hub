import re

from fastapi.testclient import TestClient

from image_hub.app import app
from image_hub.db import SessionLocal
from image_hub.models import Generation, User
from image_hub.providers import ModelProfile


def login(client: TestClient) -> str:
    page = client.get("/login")
    token = re.search(r'name="csrf" value="([^"]+)"', page.text).group(1)
    response = client.post(
        "/login", data={"username": "admin", "password": "test-password", "csrf": token},
        follow_redirects=False,
    )
    assert response.status_code == 303
    return token


def test_health_and_login_protection():
    with TestClient(app) as client:
        assert client.get("/health").json()["status"] == "ok"
        assert client.get("/", follow_redirects=False).status_code == 303
        assert client.get("/api/generations").status_code == 401
        login(client)
        assert "生成新图像" in client.get("/").text


def test_prompt_history_and_three_state_marking(monkeypatch):
    profile = ModelProfile(
        id="api:test-image", label="Test Image", provider="api",
        upstream_model="test-image", enabled=True,
    )
    monkeypatch.setattr("image_hub.web.get_profile", lambda _: profile)
    with TestClient(app) as client:
        token = login(client)
        response = client.post(
            "/api/generations",
            data={"prompt": "原始提示词，不要改写", "profile_id": profile.id,
                  "ratio": "1:1", "quality": "standard",
                  "idempotency_key": "1234567890abcdef"},
            headers={"X-CSRF-Token": token},
        )
        assert response.status_code == 202
        generation_id = response.json()["id"]
        with SessionLocal() as session:
            generation = session.get(Generation, generation_id)
            assert generation.original_prompt == "原始提示词，不要改写"
            generation.status = "succeeded"
            session.commit()
        history = client.get("/api/generations").json()["items"]
        assert history[0]["prompt"] == "原始提示词，不要改写"
        for sentiment in ("satisfied", "adopted", "dissatisfied"):
            marked = client.post(
                f"/api/generations/{generation_id}/sentiment",
                json={"sentiment": sentiment},
                headers={"X-CSRF-Token": token},
            )
            assert marked.status_code == 200
            assert marked.json()["sentiment"] == sentiment


def test_users_are_isolated():
    with TestClient(app) as client:
        login(client)
        with SessionLocal() as session:
            admin = session.query(User).filter_by(username="admin").one()
            foreign = User(
                username="other", display_name="Other", password_hash=admin.password_hash
            )
            session.add(foreign)
            session.flush()
            generation = Generation(
                user_id=foreign.id, idempotency_key="foreign-idempotent", original_prompt="不可见提示词", provider="api",
                model_id="x", model_label="x", status="succeeded",
            )
            session.add(generation)
            session.commit()
            foreign_id = generation.id
        items = client.get("/api/generations").json()["items"]
        assert all(item["id"] != foreign_id for item in items)


def test_mutations_require_csrf(monkeypatch):
    profile = ModelProfile(
        id="api:test-image", label="Test Image", provider="api",
        upstream_model="test-image", enabled=True,
    )
    monkeypatch.setattr("image_hub.web.get_profile", lambda _: profile)
    with TestClient(app) as client:
        login(client)
        response = client.post(
            "/api/generations",
            data={"prompt": "不能跨站提交", "profile_id": profile.id, "ratio": "1:1",
                  "quality": "standard", "idempotency_key": "abcdef1234567890"},
        )
        assert response.status_code == 403


def test_generation_submission_is_idempotent(monkeypatch):
    profile = ModelProfile(
        id="api:test-image", label="Test Image", provider="api",
        upstream_model="test-image", enabled=True,
    )
    monkeypatch.setattr("image_hub.web.get_profile", lambda _: profile)
    with TestClient(app) as client:
        token = login(client)
        payload = {"prompt": "只应创建一条", "profile_id": profile.id, "ratio": "1:1",
                   "quality": "standard", "idempotency_key": "same-key-12345678"}
        first = client.post("/api/generations", data=payload, headers={"X-CSRF-Token": token})
        second = client.post("/api/generations", data=payload, headers={"X-CSRF-Token": token})
        assert first.status_code == second.status_code == 202
        assert first.json()["id"] == second.json()["id"]
