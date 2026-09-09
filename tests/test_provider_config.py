import json
import os
import re
import socket
import stat
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from image_hub import providers
from image_hub.app import app
from image_hub.config import settings
from image_hub.db import SessionLocal
from image_hub.models import Generation, User


def _login(client: TestClient) -> str:
    page = client.get("/login")
    token = re.search(r'name="csrf" value="([^"]+)"', page.text).group(1)
    response = client.post(
        "/login",
        data={"username": "admin", "password": "test-password", "csrf": token},
        follow_redirects=False,
    )
    assert response.status_code == 303
    return token


def _dns_result(address: str):
    family = socket.AF_INET6 if ":" in address else socket.AF_INET
    return [(family, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", (address, 443))]


def _set_dns(monkeypatch, address: str) -> None:
    monkeypatch.setattr(
        providers.socket,
        "getaddrinfo",
        lambda *_args, **_kwargs: _dns_result(address),
    )


@pytest.mark.parametrize(
    ("models", "message"),
    [
        ("model-a|Model A|2:1|2K|4|true|standard", "不支持的比例"),
        ("model-a|Model A|1:1|8K|4|true|standard", "不支持的分辨率"),
        ("model-a|Model A|1:1|2K|4|true|ultra", "不支持的质量"),
        (
            "model-a|Model A|1:1|2K|4|true|standard,"
            + "model-a|Model B|1:1|2K|4|true|standard",
            "不得重复",
        ),
        ("model-a|Model A|1:1|2K|4|true|standard|extra", "格式无效"),
        ("model-a|Model A|1:1|2K|-1|true|standard", "0 到 14"),
        ("model-a|Model A|1:1|2K|15|true|standard", "0 到 14"),
    ],
)
def test_admin_rejects_unsupported_or_malformed_capabilities(
    tmp_path, monkeypatch, models, message
):
    monkeypatch.setattr(settings, "storage_root", tmp_path)
    _set_dns(monkeypatch, "8.8.8.8")
    with TestClient(app) as client:
        token = _login(client)
        response = client.post(
            "/admin/providers/api",
            data={
                "csrf": token,
                "base_url": "https://images.example.test/v1",
                "api_key": "not-a-real-key",
                "models": models,
            },
        )
    assert response.status_code == 422
    assert message in response.json()["detail"]
    assert "not-a-real-key" not in response.text
    assert not (tmp_path / "provider-config.json").exists()


def test_admin_validation_error_does_not_echo_sensitive_form_values(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "storage_root", tmp_path)
    _set_dns(monkeypatch, "8.8.8.8")
    secret = "not-a-real-key-" + "x" * 1000
    base_url = "https://sensitive-route.example.test/v1"
    upstream_model = "sensitive-upstream-model"
    with TestClient(app) as client:
        token = _login(client)
        response = client.post(
            "/admin/providers/api",
            data={
                "csrf": token,
                "base_url": base_url,
                "api_key": secret,
                "models": f"{upstream_model}|Public Model",
            },
        )
    assert response.status_code == 422
    for forbidden in (secret, base_url, upstream_model):
        assert forbidden not in response.text


def test_admin_accepts_supported_https_configuration(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "storage_root", tmp_path)
    _set_dns(monkeypatch, "8.8.4.4")
    with TestClient(app) as client:
        token = _login(client)
        response = client.post(
            "/admin/providers/api",
            data={
                "csrf": token,
                "base_url": "https://images.example.test/v1",
                "api_key": "not-a-real-key",
                "models": "model-a|Model A|1:1;16:9|1K;4K|14|true|standard",
            },
            follow_redirects=False,
        )
    assert response.status_code == 303


@pytest.mark.parametrize(
    "parameters",
    [
        {"ratio": "2:1", "resolution": "2K", "quality": "standard"},
        {"ratio": "1:1", "resolution": "8K", "quality": "standard"},
        {"ratio": "1:1", "resolution": "2K", "quality": "ultra"},
    ],
)
def test_api_executor_rejects_unknown_stored_capabilities(parameters):
    profile = providers.ModelProfile(
        id="api:opaque",
        label="Model A",
        provider="api",
        upstream_model="private-model-a",
        enabled=True,
        ratios=("1:1", "2:1"),
        resolutions=("2K", "8K"),
        qualities=("standard", "ultra"),
    )
    generation = SimpleNamespace(
        parameters_json=json.dumps(parameters),
        references=[],
        original_prompt="test",
    )
    with pytest.raises(RuntimeError, match="执行器不支持"):
        providers._execute_api(generation, profile)


def test_private_json_files_are_atomic_and_private_from_creation(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "storage_root", tmp_path)
    _set_dns(monkeypatch, "8.8.8.8")

    providers.save_api_config(
        "https://images.example.test/v1",
        "not-a-real-key",
        "private-model-a|Model A|1:1|2K|4|true|standard",
    )
    identity = providers._freeze_api_execution_config()

    paths = [
        tmp_path / "provider-config.json",
        tmp_path / "provider-configs" / f"{identity}.json",
    ]
    for path in paths:
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
        assert json.loads(path.read_text())["api_key"] == "not-a-real-key"
    assert not list(tmp_path.rglob("*.tmp"))


def test_atomic_write_failure_preserves_destination_and_removes_private_temp(
    tmp_path, monkeypatch
):
    destination = tmp_path / "provider-config.json"
    destination.write_text('{"before":true}')
    destination.chmod(0o600)
    real_open = providers.os.open
    creation_modes = []

    def observed_open(path, flags, mode=0o777):
        if flags & os.O_CREAT:
            creation_modes.append(mode)
        return real_open(path, flags, mode)

    monkeypatch.setattr(providers.os, "open", observed_open)
    monkeypatch.setattr(providers.os, "fsync", lambda _fd: (_ for _ in ()).throw(OSError("disk full")))

    with pytest.raises(OSError, match="disk full"):
        providers._atomic_write_private_json(destination, {"after": True})

    assert destination.read_text() == '{"before":true}'
    assert creation_modes == [0o600]
    assert not list(tmp_path.glob(".*.tmp"))


@pytest.mark.parametrize(
    "address",
    ["127.0.0.1", "169.254.10.20", "192.0.2.10", "10.20.30.40"],
)
def test_endpoint_validation_rejects_non_public_destinations_by_default(
    monkeypatch, address
):
    monkeypatch.setattr(settings, "api_private_network_allowlist", "")
    _set_dns(monkeypatch, address)
    with pytest.raises(providers.ProviderConfigError):
        providers._resolve_and_validate_endpoint("https://images.example.test/v1")


@pytest.mark.parametrize("allowlist", ["internal.example.test", "10.20.0.0/16"])
def test_server_allowlist_can_authorize_intended_private_destination(monkeypatch, allowlist):
    monkeypatch.setattr(settings, "api_private_network_allowlist", allowlist)
    _set_dns(monkeypatch, "10.20.30.40")
    assert providers._resolve_and_validate_endpoint("https://internal.example.test/v1") == (
        "10.20.30.40",
    )


def test_execution_config_rejects_dns_rebinding(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "storage_root", tmp_path)
    monkeypatch.setattr(settings, "api_private_network_allowlist", "")
    _set_dns(monkeypatch, "8.8.8.8")
    config = providers._validated_api_config(
        "https://images.example.test/v1",
        "not-a-real-key",
        "private-model-a|Model A|1:1|2K|4|true|standard",
    )
    identity = providers._execution_config_id(config)
    path = tmp_path / "provider-configs" / f"{identity}.json"
    providers._atomic_write_private_json(path, config)

    _set_dns(monkeypatch, "8.8.4.4")
    with pytest.raises(RuntimeError, match="DNS 已变化"):
        providers._load_api_execution_config(identity)


def test_api_configuration_and_failures_do_not_leak_server_routing(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(settings, "storage_root", tmp_path)
    _set_dns(monkeypatch, "8.8.8.8")
    secret = "not-a-real-private-key"
    base_url = "https://private-route.example.test/v1"
    upstream_model = "raw-upstream-model-987"
    environment_name = "IMAGE_HUB_OPENAI_IMAGE_API_KEY"
    providers.save_api_config(
        base_url,
        secret,
        f"{upstream_model}|Public Model|1:1|2K|4|true|standard",
    )

    public_profiles = json.dumps(
        [profile.public_dict() for profile in providers.model_profiles()], ensure_ascii=False
    )
    public_config = json.dumps(providers.public_api_config())
    for forbidden in (secret, base_url, upstream_model, environment_name):
        assert forbidden not in public_profiles
        assert forbidden not in public_config

    with TestClient(app) as client:
        token = _login(client)
        project_response = client.post(
            "/projects",
            data={"name": "路由保密测试", "csrf": token},
            follow_redirects=False,
        )
        project_id = project_response.headers["location"].rsplit("/", 1)[-1]
        with SessionLocal() as session:
            user = session.query(User).filter_by(username="admin").one()
            generation = Generation(
                user_id=user.id,
                project_id=project_id,
                idempotency_key="secret-history-row",
                original_prompt="test",
                provider="api",
                model_id=upstream_model,
                model_label=upstream_model,
                provider_snapshot_json=json.dumps(
                    {
                        "id": f"api:{upstream_model}",
                        "upstream_model": upstream_model,
                    }
                ),
                parameters_json=json.dumps(
                    {"ratio": "1:1", "resolution": "2K", "quality": "standard"}
                ),
                status="failed",
                error_message=f"{secret} {base_url} {upstream_model} {environment_name}",
            )
            session.add(generation)
            session.commit()

        responses = [
            client.get("/admin").text,
            client.get(f"/projects/{project_id}").text,
            client.get(f"/projects/{project_id}/history").text,
            client.get(f"/api/projects/{project_id}/generations").text,
        ]
    for response_text in responses:
        for forbidden in (secret, base_url, upstream_model, environment_name):
            assert forbidden not in response_text
