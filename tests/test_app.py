import json
import re
from concurrent.futures import ThreadPoolExecutor
from threading import Event, Lock

from fastapi.testclient import TestClient

from image_hub import web as web_module
from image_hub.app import app
from image_hub.config import settings
from image_hub.db import SessionLocal
from image_hub.models import Generation, Project, User
from image_hub.providers import ModelProfile, execute_generation


def login(client: TestClient, username: str = "admin") -> str:
    page = client.get("/login")
    token = re.search(r'name="csrf" value="([^"]+)"', page.text).group(1)
    response = client.post(
        "/login",
        data={"username": username, "password": "test-password", "csrf": token},
        follow_redirects=False,
    )
    assert response.status_code == 303
    return token


def create_project(client: TestClient, token: str, name: str) -> str:
    response = client.post(
        "/projects", data={"name": name, "csrf": token}, follow_redirects=False
    )
    assert response.status_code == 303
    return response.headers["location"].rsplit("/", 1)[-1]


def install_submission_race_gate(
    monkeypatch, profile: ModelProfile
) -> tuple[Event, Event, Event]:
    first_profile_entered = Event()
    release_first = Event()
    second_lock_attempted = Event()
    attempt_lock = Lock()
    attempt_count = 0
    original_lock = web_module._locked_generation_user

    def observed_lock(request, session):
        nonlocal attempt_count
        with attempt_lock:
            attempt_count += 1
            if attempt_count == 2:
                second_lock_attempted.set()
        return original_lock(request, session)

    def delayed_profile(_):
        if not first_profile_entered.is_set():
            first_profile_entered.set()
            assert release_first.wait(5)
        return profile

    monkeypatch.setattr(web_module, "_locked_generation_user", observed_lock)
    monkeypatch.setattr(web_module, "get_profile", delayed_profile)
    return first_profile_entered, release_first, second_lock_attempted


def test_health_login_and_project_workspace():
    with TestClient(app) as client:
        assert client.get("/health").json()["status"] == "ok"
        assert client.get("/", follow_redirects=False).status_code == 303
        assert client.get("/api/projects/unknown/generations").status_code == 401
        token = login(client)
        assert "我的项目" in client.get("/projects").text
        project_id = create_project(client, token, "测试项目")
        workspace = client.get(f"/projects/{project_id}")
        assert workspace.status_code == 200
        assert "生成新图像" in workspace.text
        assert "测试项目" in workspace.text


def test_prompt_history_and_three_state_marking(monkeypatch):
    profile = ModelProfile(
        id="api:test-image", label="Test Image", provider="api",
        upstream_model="test-image", enabled=True,
    )
    monkeypatch.setattr("image_hub.web.get_profile", lambda _: profile)
    with TestClient(app) as client:
        token = login(client)
        project_id = create_project(client, token, "提示词历史项目")
        response = client.post(
            f"/api/projects/{project_id}/generations",
            data={"prompt": "原始提示词，不要改写", "profile_id": profile.id,
                  "ratio": "1:1", "resolution": "2K", "quality": "standard",
                  "idempotency_key": "1234567890abcdef"},
            headers={"X-CSRF-Token": token},
        )
        assert response.status_code == 202
        generation_id = response.json()["id"]
        with SessionLocal() as session:
            generation = session.get(Generation, generation_id)
            assert generation.original_prompt == "原始提示词，不要改写"
            assert generation.project_id == project_id
            generation.status = "succeeded"
            session.commit()
        history = client.get(f"/api/projects/{project_id}/generations").json()["items"]
        assert history[0]["prompt"] == "原始提示词，不要改写"
        for sentiment in ("satisfied", "adopted", "dissatisfied"):
            marked = client.post(
                f"/api/projects/{project_id}/generations/{generation_id}/sentiment",
                json={"sentiment": sentiment},
                headers={"X-CSRF-Token": token},
            )
            assert marked.status_code == 200
            assert marked.json()["sentiment"] == sentiment


def test_projects_and_users_are_isolated():
    with TestClient(app) as client:
        token = login(client)
        own_project_id = create_project(client, token, "自己的项目")
        with SessionLocal() as session:
            admin = session.query(User).filter_by(username="admin").one()
            foreign = User(
                username="other", display_name="Other", password_hash=admin.password_hash
            )
            session.add(foreign)
            session.flush()
            foreign_project = Project(user_id=foreign.id, name="其他用户项目")
            session.add(foreign_project)
            session.flush()
            generation = Generation(
                user_id=foreign.id, project_id=foreign_project.id,
                idempotency_key="foreign-idempotent", original_prompt="不可见提示词",
                provider="api", model_id="x", model_label="x", status="succeeded",
            )
            session.add(generation)
            session.commit()
            foreign_project_id = foreign_project.id
        assert client.get(f"/projects/{foreign_project_id}").status_code == 404
        assert client.get(f"/api/projects/{foreign_project_id}/generations").status_code == 404
        own_history = client.get(f"/api/projects/{own_project_id}/generations").json()["items"]
        assert own_history == []


def test_canvas_state_is_unique_per_project():
    with TestClient(app) as client:
        token = login(client)
        first_id = create_project(client, token, "画布甲")
        second_id = create_project(client, token, "画布乙")
        first_state = {"viewport": {"x": 10, "y": 20, "zoom": 0.8}, "nodes": [{"id": "a"}]}
        saved = client.put(
            f"/api/projects/{first_id}/canvas",
            json=first_state,
            headers={"X-CSRF-Token": token},
        )
        assert saved.status_code == 200
        assert client.get(f"/api/projects/{first_id}/canvas").json()["state"] == first_state
        assert client.get(f"/api/projects/{second_id}/canvas").json()["state"] == {}

        draft = {"prompt": "保留画布时保存草稿"}
        assert client.put(
            f"/api/projects/{first_id}/canvas",
            json={"draft": draft},
            headers={"X-CSRF-Token": token},
        ).status_code == 200
        assert client.get(f"/api/projects/{first_id}/canvas").json()["state"] == {
            **first_state,
            "draft": draft,
        }


def test_mutations_require_csrf(monkeypatch):
    profile = ModelProfile(
        id="api:test-image", label="Test Image", provider="api",
        upstream_model="test-image", enabled=True,
    )
    monkeypatch.setattr("image_hub.web.get_profile", lambda _: profile)
    with TestClient(app) as client:
        token = login(client)
        project_id = create_project(client, token, "CSRF 项目")
        response = client.post(
            f"/api/projects/{project_id}/generations",
            data={"prompt": "不能跨站提交", "profile_id": profile.id, "ratio": "1:1",
                  "resolution": "2K", "quality": "standard",
                  "idempotency_key": "abcdef1234567890"},
        )
        assert response.status_code == 403


def test_generation_submission_is_idempotent_per_project(monkeypatch):
    profile = ModelProfile(
        id="api:test-image", label="Test Image", provider="api",
        upstream_model="test-image", enabled=True,
    )
    monkeypatch.setattr("image_hub.web.get_profile", lambda _: profile)
    with TestClient(app) as client:
        token = login(client)
        first_project = create_project(client, token, "幂等项目甲")
        second_project = create_project(client, token, "幂等项目乙")
        payload = {"prompt": "只应创建一条", "profile_id": profile.id, "ratio": "1:1",
                   "resolution": "2K", "quality": "standard",
                   "idempotency_key": "same-key-12345678"}
        first_url = f"/api/projects/{first_project}/generations"
        first = client.post(first_url, data=payload, headers={"X-CSRF-Token": token})
        duplicate = client.post(first_url, data=payload, headers={"X-CSRF-Token": token})
        second = client.post(
            f"/api/projects/{second_project}/generations",
            data=payload,
            headers={"X-CSRF-Token": token},
        )
        assert first.status_code == duplicate.status_code == second.status_code == 202
        assert first.json()["id"] == duplicate.json()["id"]
        assert second.json()["id"] != first.json()["id"]


def test_active_task_limit_applies_across_projects(monkeypatch):
    profile = ModelProfile(
        id="api:test-image", label="Test Image", provider="api",
        upstream_model="test-image", enabled=True,
        ratios=("1:1",), resolutions=("2K",), qualities=("standard",), max_references=0,
    )
    monkeypatch.setattr("image_hub.web.get_profile", lambda _: profile)
    monkeypatch.setattr(settings, "max_active_tasks_per_user", 1)
    with SessionLocal() as session:
        admin = session.query(User).filter_by(username="admin").one()
        session.add(
            User(
                username="limited-member",
                display_name="额度成员",
                password_hash=admin.password_hash,
            )
        )
        session.commit()
    with TestClient(app) as client:
        token = login(client, "limited-member")
        first_project = create_project(client, token, "额度项目甲")
        second_project = create_project(client, token, "额度项目乙")
        payload = {
            "prompt": "账号级额度测试",
            "profile_id": profile.id,
            "ratio": "1:1",
            "resolution": "2K",
            "quality": "standard",
            "idempotency_key": "limit-key-12345678",
        }
        assert client.post(
            f"/api/projects/{first_project}/generations",
            data=payload,
            headers={"X-CSRF-Token": token},
        ).status_code == 202
        payload["idempotency_key"] = "limit-key-87654321"
        assert client.post(
            f"/api/projects/{second_project}/generations",
            data=payload,
            headers={"X-CSRF-Token": token},
        ).status_code == 429


def test_concurrent_idempotent_submissions_return_the_same_generation(monkeypatch):
    profile = ModelProfile(
        id="api:test-image", label="Test Image", provider="api",
        upstream_model="test-image", enabled=True,
        ratios=("1:1",), resolutions=("2K",), qualities=("standard",), max_references=0,
    )
    monkeypatch.setattr(settings, "max_active_tasks_per_user", 50)
    first_entered, release_first, second_attempted = install_submission_race_gate(
        monkeypatch, profile
    )
    with TestClient(app) as first_client, TestClient(app) as second_client:
        first_token = login(first_client)
        second_token = login(second_client)
        project_id = create_project(first_client, first_token, "并发幂等项目")
        payload = {
            "prompt": "并发幂等测试",
            "profile_id": profile.id,
            "ratio": "1:1",
            "resolution": "2K",
            "quality": "standard",
            "idempotency_key": "concurrent-same-key",
        }
        url = f"/api/projects/{project_id}/generations"
        with ThreadPoolExecutor(max_workers=2) as executor:
            first_future = executor.submit(
                first_client.post, url, data=payload, headers={"X-CSRF-Token": first_token}
            )
            assert first_entered.wait(5)
            second_future = executor.submit(
                second_client.post, url, data=payload, headers={"X-CSRF-Token": second_token}
            )
            assert second_attempted.wait(5)
            release_first.set()
            first_response = first_future.result(timeout=5)
            second_response = second_future.result(timeout=5)

        assert first_response.status_code == second_response.status_code == 202
        assert first_response.json()["id"] == second_response.json()["id"]
        with SessionLocal() as session:
            assert session.query(Generation).filter_by(project_id=project_id).count() == 1


def test_concurrent_cross_project_submissions_respect_user_limit(monkeypatch):
    profile = ModelProfile(
        id="api:test-image", label="Test Image", provider="api",
        upstream_model="test-image", enabled=True,
        ratios=("1:1",), resolutions=("2K",), qualities=("standard",), max_references=0,
    )
    monkeypatch.setattr(settings, "max_active_tasks_per_user", 1)
    first_entered, release_first, second_attempted = install_submission_race_gate(
        monkeypatch, profile
    )
    with SessionLocal() as session:
        admin = session.query(User).filter_by(username="admin").one()
        session.add(
            User(
                username="concurrent-member",
                display_name="并发额度成员",
                password_hash=admin.password_hash,
            )
        )
        session.commit()
    with TestClient(app) as first_client, TestClient(app) as second_client:
        first_token = login(first_client, "concurrent-member")
        second_token = login(second_client, "concurrent-member")
        first_project = create_project(first_client, first_token, "并发额度项目甲")
        second_project = create_project(first_client, first_token, "并发额度项目乙")

        def submit(client, token, project_id, key):
            return client.post(
                f"/api/projects/{project_id}/generations",
                data={
                    "prompt": "并发额度测试",
                    "profile_id": profile.id,
                    "ratio": "1:1",
                    "resolution": "2K",
                    "quality": "standard",
                    "idempotency_key": key,
                },
                headers={"X-CSRF-Token": token},
            )

        with ThreadPoolExecutor(max_workers=2) as executor:
            first_future = executor.submit(
                submit, first_client, first_token, first_project, "concurrent-limit-key-a"
            )
            assert first_entered.wait(5)
            second_future = executor.submit(
                submit, second_client, second_token, second_project, "concurrent-limit-key-b"
            )
            assert second_attempted.wait(5)
            release_first.set()
            responses = [first_future.result(timeout=5), second_future.result(timeout=5)]

        assert sorted(response.status_code for response in responses) == [202, 429]
        with SessionLocal() as session:
            active_count = session.query(Generation).filter(
                Generation.user_id == session.query(User.id).filter_by(
                    username="concurrent-member"
                ).scalar_subquery(),
                Generation.status.in_(("queued", "running")),
            ).count()
            assert active_count == 1


def test_external_failure_requires_recovery(monkeypatch):
    profile = ModelProfile(
        id="api:test-image", label="Test Image", provider="api",
        upstream_model="test-image", enabled=True,
    )

    def fail_after_submission(generation, _profile):
        generation.external_task_id = "paid-upstream-task"
        raise RuntimeError("download interrupted")

    monkeypatch.setattr("image_hub.providers._execute_api", fail_after_submission)
    with SessionLocal() as session:
        admin = session.query(User).filter_by(username="admin").one()
        project = Project(user_id=admin.id, name="恢复项目")
        session.add(project)
        session.flush()
        generation = Generation(
            user_id=admin.id, project_id=project.id,
            idempotency_key="recovery-test-key", original_prompt="恢复测试",
            provider="api", model_id="test-image", model_label="Test Image",
            provider_snapshot_json=json.dumps(profile.public_dict()), status="running",
        )
        session.add(generation)
        session.commit()
        generation_id = generation.id
    execute_generation(generation_id)
    with SessionLocal() as session:
        generation = session.get(Generation, generation_id)
        assert generation.status == "recovery_required"
        assert generation.external_task_id == "paid-upstream-task"


def test_non_admin_has_no_management_ui_or_access():
    with SessionLocal() as session:
        admin = session.query(User).filter_by(username="admin").one()
        session.add(User(username="member", display_name="普通成员", password_hash=admin.password_hash))
        session.commit()
    with TestClient(app) as client:
        token = login(client, "member")
        projects = client.get("/projects")
        assert "系统管理" not in projects.text
        project_id = create_project(client, token, "普通成员项目")
        assert ">管理<" not in client.get(f"/projects/{project_id}").text
        assert client.get("/admin").status_code == 403


def test_security_headers_are_present():
    with TestClient(app) as client:
        response = client.get("/login")
        assert response.headers["x-content-type-options"] == "nosniff"
        assert response.headers["x-frame-options"] == "DENY"
        assert "default-src 'self'" in response.headers["content-security-policy"]