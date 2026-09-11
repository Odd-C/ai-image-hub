import base64
import hashlib
import hmac
import ipaddress
import json
import os
import re
import secrets
import shutil
import socket
import subprocess
from dataclasses import asdict, dataclass, replace
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from sqlalchemy.orm import object_session

from image_hub.config import settings
from image_hub.models import Generation, utcnow
from image_hub.storage import InvalidImage, resolve_storage_key, validate_artifact


@dataclass(frozen=True)
class ModelProfile:
    id: str
    label: str
    provider: str
    upstream_model: str
    enabled: bool
    supports_references: bool = True
    ratios: tuple[str, ...] = ("1:1", "4:3", "3:4", "16:9", "9:16")
    qualities: tuple[str, ...] = ("standard",)
    resolutions: tuple[str, ...] = ("2K",)
    max_references: int = 14
    execution_config_id: str = ""

    def public_dict(self) -> dict:
        """Return browser-safe selection metadata without upstream routing details."""
        payload = asdict(self)
        payload.pop("upstream_model", None)
        payload.pop("execution_config_id", None)
        return payload

    def snapshot_dict(self) -> dict:
        """Keep immutable server-side execution routing with the generation evidence."""
        return asdict(self)


LIBTV_MODELS = (
    ("lib-image-2", "Lib Image"),
    ("nebula-ultra", "General image Pro"),
    ("nebula-2-flash", "General image V2"),
    ("doubao-seedream-5-0-pro", "Seedream 5.0 Pro"),
    ("qwen-image-3", "Qwen image 3.0"),
    ("mj-v8.2", "Style Image V8.2"),
    ("mj-v8.1", "Style Image V8.1"),
    ("mj-v7", "Style Image V7"),
    ("mj-niji7", "Style Image Niji 7"),
    ("jimeng-4.6", "Seedream 4.6"),
    ("seedream-5", "Seedream 5.0 Lite"),
    ("seedream-4.5", "Seedream 4.5"),
    ("z-image", "Z-image Turbo"),
    ("nebula-core", "General image"),
    ("qwen", "Qwen Image"),
    ("qwen-edit", "Qwen Edit"),
    ("seedream-4", "Seedream 4.0"),
)


class ProviderConfigError(ValueError):
    """An administrator supplied an unsafe or unsupported provider configuration."""


API_RATIOS = frozenset({"1:1", "4:3", "3:4", "16:9", "9:16"})
API_RESOLUTIONS = frozenset({"1K", "2K", "4K"})
API_QUALITIES = frozenset({"standard"})
_API_ENABLED_VALUES = frozenset({"1", "true", "on", "启用"})
_API_DISABLED_VALUES = frozenset({"0", "false", "off", "停用"})
_NATIVE_CREDENTIALS_FILE = "native-provider-credentials.json"
_CONFIG_ID_LENGTH = 32


def _api_config() -> dict:
    """Load optional admin-managed API routing from server-only storage."""
    path = settings.storage_root / "provider-config.json"
    if path.is_file():
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(payload, dict):
                return payload
        except (OSError, json.JSONDecodeError):
            pass
    return {
        "base_url": settings.openai_image_base_url,
        "api_key": settings.openai_image_api_key,
        "models": settings.openai_image_models,
    }


def _atomic_write_private_json(path: Path, payload: dict) -> None:
    """Atomically replace a private JSON file that is mode 0600 from creation."""
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(path.parent, 0o700)
    temporary = path.with_name(f".{path.name}.{secrets.token_hex(8)}.tmp")
    descriptor = None
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
        with os.fdopen(descriptor, "wb") as handle:
            descriptor = None
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        directory_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    except Exception:
        if descriptor is not None:
            os.close(descriptor)
        temporary.unlink(missing_ok=True)
        raise


def _native_credentials() -> dict:
    path = settings.storage_root / "private" / _NATIVE_CREDENTIALS_FILE
    if not path.is_file():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _validated_secret(value: str, label: str, *, allow_empty: bool = False) -> str:
    if any(character in value for character in ("\r", "\n", "\0")):
        raise ProviderConfigError(f"{label} 不得包含换行或 NUL 字符")
    normalized = value.strip()
    if not normalized and allow_empty:
        return ""
    if not 1 <= len(normalized) <= 1000:
        raise ProviderConfigError(f"{label} 长度必须在 1 到 1000 个字符之间")
    return normalized


def save_libtv_credentials(token: str, *, clear: bool = False) -> str:
    """Update only the admin-managed LibTV token; blank means keep."""
    payload = _native_credentials()
    if any(character in token for character in ("\r", "\n", "\0")):
        raise ProviderConfigError("LibTV Token 不得包含换行或 NUL 字符")
    if clear:
        if token.strip():
            raise ProviderConfigError("清除 LibTV Token 时不能同时提交新值")
        payload.pop("libtv_token", None)
        action = "cleared"
    elif token.strip():
        payload["libtv_token"] = _validated_secret(token, "LibTV Token")
        action = "saved"
    else:
        action = "kept"
    _atomic_write_private_json(
        settings.storage_root / "private" / _NATIVE_CREDENTIALS_FILE, payload
    )
    return action


def save_lovart_credentials(
    access_key: str, secret_key: str, *, clear: bool = False
) -> str:
    """Update the admin-managed Lovart credential pair; two blanks mean keep."""
    payload = _native_credentials()
    if any(
        character in value
        for value in (access_key, secret_key)
        for character in ("\r", "\n", "\0")
    ):
        raise ProviderConfigError("Lovart 凭据不得包含换行或 NUL 字符")
    if clear:
        if access_key.strip() or secret_key.strip():
            raise ProviderConfigError("清除 Lovart 凭据时不能同时提交新值")
        payload.pop("lovart_access_key", None)
        payload.pop("lovart_secret_key", None)
        action = "cleared"
    elif access_key.strip() or secret_key.strip():
        if not access_key.strip() or not secret_key.strip():
            raise ProviderConfigError("Lovart Access Key 与 Secret Key 必须成对填写")
        payload["lovart_access_key"] = _validated_secret(access_key, "Lovart Access Key")
        payload["lovart_secret_key"] = _validated_secret(secret_key, "Lovart Secret Key")
        action = "saved"
    else:
        action = "kept"
    _atomic_write_private_json(
        settings.storage_root / "private" / _NATIVE_CREDENTIALS_FILE, payload
    )
    return action


def _libtv_cli_login_state() -> bool | None:
    """Recognize common CLI login records without exposing or copying their contents."""
    path = Path.home() / ".libtv" / "credentials.json"
    if not path.is_file():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    known_fields = ("token", "access_token", "accessToken")
    if not any(field in payload for field in known_fields):
        return None
    return any(
        isinstance(payload.get(field), str) and payload[field].strip()
        for field in known_fields
    )


def _runtime_secret(value: object) -> str:
    if not isinstance(value, str):
        return ""
    try:
        return _validated_secret(value, "平台凭据", allow_empty=True)
    except ProviderConfigError:
        return ""


def _resolved_libtv_token() -> tuple[str, str]:
    managed = _runtime_secret(_native_credentials().get("libtv_token", ""))
    if managed:
        return managed, "管理后台已配置"
    environment = _runtime_secret(os.environ.get("LIBTV_TOKEN", ""))
    if environment:
        return environment, "环境已配置"
    login_state = _libtv_cli_login_state()
    if login_state is True:
        return "", "CLI 已登录"
    if login_state is None:
        return "", "CLI 登录状态无法确认"
    return "", "未配置"


def _resolved_lovart_credentials() -> tuple[str, str, str]:
    payload = _native_credentials()
    managed_access = _runtime_secret(payload.get("lovart_access_key", ""))
    managed_secret = _runtime_secret(payload.get("lovart_secret_key", ""))
    if managed_access and managed_secret:
        return managed_access, managed_secret, "管理后台已配置"
    environment_access = _runtime_secret(settings.lovart_access_key)
    environment_secret = _runtime_secret(settings.lovart_secret_key)
    if environment_access and environment_secret:
        return environment_access, environment_secret, "环境已配置"
    return "", "", "未配置"


def public_native_credentials() -> dict:
    """Return only booleans and safe source labels for the admin page."""
    libtv_token, libtv_source = _resolved_libtv_token()
    lovart_access, lovart_secret, lovart_source = _resolved_lovart_credentials()
    return {
        "has_libtv_token": bool(libtv_token),
        "has_lovart_access_key": bool(lovart_access),
        "has_lovart_secret_key": bool(lovart_secret),
        "libtv_source": libtv_source,
        "lovart_source": lovart_source,
    }


def _parse_allowlist() -> tuple[set[str], tuple[ipaddress.IPv4Network | ipaddress.IPv6Network, ...]]:
    hosts: set[str] = set()
    networks = []
    for raw in settings.api_private_network_allowlist.split(","):
        entry = raw.strip().lower()
        if not entry:
            continue
        try:
            networks.append(ipaddress.ip_network(entry, strict=False))
        except ValueError:
            hosts.add(entry.rstrip("."))
    return hosts, tuple(networks)


def _resolve_and_validate_endpoint(base_url: str) -> tuple[str, ...]:
    parsed = urlsplit(base_url)
    if parsed.scheme.lower() != "https" or not parsed.hostname:
        raise ProviderConfigError("API Base URL 必须是有效的 HTTPS 地址")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ProviderConfigError("API Base URL 不得包含凭证、查询参数或片段")
    try:
        port = parsed.port or 443
    except ValueError as exc:
        raise ProviderConfigError("API Base URL 端口无效") from exc
    hostname = parsed.hostname.rstrip(".").lower()
    try:
        addresses = {
            item[4][0]
            for item in socket.getaddrinfo(hostname, port, type=socket.SOCK_STREAM)
        }
    except socket.gaierror as exc:
        raise ProviderConfigError("API Base URL 域名无法解析") from exc
    if not addresses:
        raise ProviderConfigError("API Base URL 域名未解析到地址")
    allowed_hosts, allowed_networks = _parse_allowlist()
    for address in addresses:
        try:
            ip = ipaddress.ip_address(address)
        except ValueError as exc:
            raise ProviderConfigError("API Base URL 域名解析结果无效") from exc
        allowlisted_private = hostname in allowed_hosts or any(
            ip in network for network in allowed_networks
        )
        if (
            ip.is_loopback
            or ip.is_link_local
            or ip.is_multicast
            or ip.is_unspecified
            or ip.is_reserved
        ):
            raise ProviderConfigError("API Base URL 不得指向本机、链路本地或保留地址")
        if ip.is_private:
            if not allowlisted_private:
                raise ProviderConfigError("API Base URL 指向内网；需由服务端 allowlist 明确授权")
        elif not ip.is_global:
            raise ProviderConfigError("API Base URL 不得指向非公网地址")
    return tuple(sorted(addresses))


def _parse_api_models(models: str) -> tuple[dict, ...]:
    parsed_models = []
    seen = set()
    raw_models = models.split(",")
    if any(not item.strip() for item in raw_models):
        raise ProviderConfigError("API 模型配置包含空行或多余逗号")
    for raw_item in raw_models:
        fields = [field.strip() for field in raw_item.split("|")]
        if len(fields) > 7 or not fields[0] or any("\n" in field or "\r" in field for field in fields):
            raise ProviderConfigError("API 模型配置格式无效")
        model_id = fields[0]
        if any(character.isspace() for character in model_id):
            raise ProviderConfigError("API 模型 ID 不得包含空白字符")
        if model_id in seen:
            raise ProviderConfigError("API 模型 ID 不得重复")
        seen.add(model_id)
        ratios = (
            tuple(filter(None, fields[2].split(";")))
            if len(fields) > 2
            else tuple(sorted(API_RATIOS))
        )
        resolutions = (
            tuple(filter(None, fields[3].split(";")))
            if len(fields) > 3
            else tuple(sorted(API_RESOLUTIONS))
        )
        if not ratios or any(value not in API_RATIOS for value in ratios):
            raise ProviderConfigError("API 模型包含执行器不支持的比例")
        if not resolutions or any(value not in API_RESOLUTIONS for value in resolutions):
            raise ProviderConfigError("API 模型包含执行器不支持的分辨率")
        try:
            max_references = int(fields[4]) if len(fields) > 4 else 4
        except ValueError as exc:
            raise ProviderConfigError("API 模型最大参考图数量必须是整数") from exc
        if not 0 <= max_references <= 14:
            raise ProviderConfigError("API 模型最大参考图数量必须在 0 到 14 之间")
        enabled_value = fields[5].lower() if len(fields) > 5 else "true"
        if enabled_value not in _API_ENABLED_VALUES | _API_DISABLED_VALUES:
            raise ProviderConfigError("API 模型启用状态必须是 true 或 false")
        qualities = (
            tuple(filter(None, fields[6].split(";")))
            if len(fields) > 6
            else tuple(sorted(API_QUALITIES))
        )
        if not qualities or any(value not in API_QUALITIES for value in qualities):
            raise ProviderConfigError("API 模型包含执行器不支持的质量参数")
        parsed_models.append(
            {
                "model_id": model_id,
                "label": (
                    fields[1]
                    if len(fields) > 1 and fields[1] and fields[1] != model_id
                    else f"API 模型 {len(parsed_models) + 1}"
                ),
                "ratios": ratios,
                "resolutions": resolutions,
                "qualities": qualities,
                "max_references": max_references,
                "enabled": enabled_value in _API_ENABLED_VALUES,
            }
        )
    if not parsed_models:
        raise ProviderConfigError("至少配置一个 API 模型")
    return tuple(parsed_models)


def _validated_api_config(base_url: str, api_key: str, models: str) -> dict:
    normalized_url = base_url.strip().rstrip("/")
    resolved_ips = _resolve_and_validate_endpoint(normalized_url)
    _parse_api_models(models.strip())
    return {
        "base_url": normalized_url,
        "api_key": api_key.strip(),
        "models": models.strip(),
        "resolved_ips": list(resolved_ips),
    }


def save_api_config(base_url: str, api_key: str, models: str) -> None:
    """Validate and atomically persist server-only credentials with mode 0600."""
    current = _api_config()
    payload = _validated_api_config(
        base_url,
        api_key.strip() or str(current.get("api_key", "")),
        models,
    )
    _atomic_write_private_json(settings.storage_root / "provider-config.json", payload)


def public_api_config() -> dict:
    """Expose configuration state without returning any routing or credential material."""
    config = _api_config()
    return {
        "has_base_url": bool(config.get("base_url")),
        "has_api_key": bool(config.get("api_key")),
        "has_models": bool(config.get("models")),
    }


def _execution_config_id(config: dict) -> str:
    encoded = json.dumps(config, sort_keys=True, separators=(",", ":")).encode()
    return hmac.new(settings.session_secret.encode(), encoded, hashlib.sha256).hexdigest()[:32]


def _freeze_api_execution_config() -> str:
    current = _api_config()
    config = _validated_api_config(
        str(current.get("base_url", "")),
        str(current.get("api_key", "")),
        str(current.get("models", "")),
    )
    identity = _execution_config_id(config)
    path = settings.storage_root / "provider-configs" / f"{identity}.json"
    if not path.exists():
        _atomic_write_private_json(path, config)
    return identity


def _current_native_execution_config(provider: str) -> dict:
    if provider == "libtv":
        token, _ = _resolved_libtv_token()
        return {
            "provider": "libtv",
            "token": token,
            "cli_path": str(settings.libtv_cli),
        }
    if provider == "lovart":
        access_key, secret_key, _ = _resolved_lovart_credentials()
        if not access_key or not secret_key:
            raise ProviderConfigError("Lovart 凭据未成对配置")
        return {
            "provider": "lovart",
            "access_key": access_key,
            "secret_key": secret_key,
            "base_url": settings.lovart_base_url,
            "skill_script": str(settings.lovart_skill_script),
        }
    raise ProviderConfigError("不支持冻结该平台配置")


def _freeze_native_execution_config(provider: str) -> str:
    config = _current_native_execution_config(provider)
    identity = _execution_config_id(config)
    path = settings.storage_root / "provider-configs" / f"{identity}.json"
    if path.exists():
        _load_native_execution_config(identity, provider)
    else:
        _atomic_write_private_json(path, config)
    return identity


def freeze_profile_execution(profile: ModelProfile) -> ModelProfile:
    """Attach an immutable server-only route identity before a task is queued."""
    if profile.provider == "api":
        identity = _freeze_api_execution_config()
    elif profile.provider in {"libtv", "lovart"}:
        identity = _freeze_native_execution_config(profile.provider)
    else:
        return profile
    if profile.execution_config_id and profile.execution_config_id != identity:
        raise ProviderConfigError("平台配置在提交期间发生变化，请重新确认模型后提交")
    return replace(profile, execution_config_id=identity)


def _valid_config_identity(identity: str) -> bool:
    return len(identity) == _CONFIG_ID_LENGTH and all(
        character in "0123456789abcdef" for character in identity
    )


def _load_private_execution_config(identity: str, error_prefix: str) -> dict:
    if not _valid_config_identity(identity):
        raise RuntimeError(f"{error_prefix}任务缺少有效的冻结配置标识")
    path = settings.storage_root / "provider-configs" / f"{identity}.json"
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"{error_prefix}任务的冻结配置不存在或已损坏") from exc
    if not isinstance(payload, dict) or _execution_config_id(payload) != identity:
        raise RuntimeError(f"{error_prefix}任务的冻结配置校验失败")
    return payload


def _load_native_execution_config(identity: str, provider: str) -> dict:
    payload = _load_private_execution_config(identity, provider.capitalize())
    if payload.get("provider") != provider:
        raise RuntimeError("任务冻结配置的平台不匹配")
    required = (
        ("cli_path",)
        if provider == "libtv"
        else ("access_key", "secret_key", "base_url", "skill_script")
    )
    if any(not isinstance(payload.get(field), str) or not payload[field] for field in required):
        raise RuntimeError("任务冻结配置内容无效")
    return payload


def _load_api_execution_config(identity: str) -> dict:
    payload = _load_private_execution_config(identity, "API ")
    current_ips = _resolve_and_validate_endpoint(str(payload.get("base_url", "")))
    if tuple(payload.get("resolved_ips", ())) != current_ips:
        raise RuntimeError("API 上游 DNS 已变化，已阻止可能的重绑定请求")
    return payload


def model_profiles() -> tuple[ModelProfile, ...]:
    libtv_token, libtv_source = _resolved_libtv_token()
    libtv_login_usable = libtv_source in {"CLI 已登录", "CLI 登录状态无法确认"}
    libtv_ready = settings.libtv_cli.is_file() and bool(libtv_token or libtv_login_usable)
    profiles = [
        ModelProfile(
            id=f"libtv:{key}", label=label, provider="libtv", upstream_model=label,
            enabled=libtv_ready,
            resolutions=(
                ("1K",)
                if key == "z-image"
                else ("1K", "2K", "4K")
                if key in {"lib-image-2", "nebula-ultra", "nebula-2-flash", "qwen-image-3"}
                else ("2K",)
            ),
        )
        for key, label in LIBTV_MODELS
    ]
    lovart_access_key, lovart_secret_key, _ = _resolved_lovart_credentials()
    lovart_ready = bool(
        lovart_access_key and lovart_secret_key and settings.lovart_skill_script.is_file()
    )
    profiles.extend(
        [
            ModelProfile(
                "lovart:nano-banana-pro", "Nano Banana Pro", "lovart",
                "generate_image_nano_banana_pro", lovart_ready, ratios=("1:1",),
                resolutions=("2K",),
            ),
            ModelProfile(
                "lovart:nano-banana-2", "Nano Banana 2", "lovart",
                "generate_image_nano_banana_2", lovart_ready, ratios=("1:1",),
                resolutions=("2K",),
            ),
        ]
    )
    api_config = _api_config()
    try:
        api_models = _parse_api_models(str(api_config.get("models", "")))
    except ProviderConfigError:
        api_models = ()
    for item in api_models:
        public_id = hashlib.sha256(item["model_id"].encode()).hexdigest()[:16]
        profiles.append(
            ModelProfile(
                id=f"api:{public_id}",
                label=item["label"],
                provider="api",
                upstream_model=item["model_id"],
                enabled=bool(
                    item["enabled"] and api_config.get("api_key") and api_config.get("base_url")
                ),
                ratios=item["ratios"],
                resolutions=item["resolutions"],
                qualities=item["qualities"],
                max_references=item["max_references"],
                execution_config_id=(
                    _execution_config_id(api_config) if api_config.get("resolved_ips") else ""
                ),
            )
        )
    return tuple(profiles)


def get_profile(profile_id: str) -> ModelProfile | None:
    """Resolve opaque and legacy IDs, failing closed if their meanings collide."""
    profiles = model_profiles()
    exact_matches = [profile for profile in profiles if profile.id == profile_id]
    if not profile_id.startswith("api:"):
        return exact_matches[0] if len(exact_matches) == 1 else None

    legacy_model = profile_id.split(":", 1)[1]
    legacy_matches = [
        profile
        for profile in profiles
        if profile.provider == "api" and profile.upstream_model == legacy_model
    ]
    matches = {profile.id: profile for profile in (*exact_matches, *legacy_matches)}
    return next(iter(matches.values())) if len(matches) == 1 else None


def _params(generation: Generation) -> dict:
    return json.loads(generation.parameters_json or "{}")


def _references(generation: Generation) -> list[Path]:
    paths = []
    for reference in generation.references:
        path = resolve_storage_key(reference.storage_key)
        if not path.is_file():
            raise RuntimeError(f"参考图不存在：{reference.original_name}")
        paths.append(path)
    return paths


def _checkpoint(generation: Generation) -> None:
    session = object_session(generation)
    if session:
        session.commit()


def _legacy_native_execution_config(provider: str) -> dict:
    """Resolve mutable deployment configuration only for pre-freeze legacy tasks."""
    return _current_native_execution_config(provider)


def _native_execution_config(profile: ModelProfile) -> dict:
    if profile.execution_config_id:
        return _load_native_execution_config(profile.execution_config_id, profile.provider)
    return _legacy_native_execution_config(profile.provider)


def _sanitize_provider_output(text: str, *secret_values: str) -> str:
    sanitized = text
    for value in secret_values:
        if value:
            sanitized = sanitized.replace(value, "[已隐藏]")
    sanitized = re.sub(r"https?://\S+", "[已隐藏地址]", sanitized)
    sanitized = re.sub(
        r"(?i)(bearer|api[_ -]?key|access[_ -]?key|secret[_ -]?key|token)"
        r"\s*[:=]?\s*\S+",
        r"\1 [已隐藏]",
        sanitized,
    )
    return sanitized[-2000:]


def _libtv_env(config: dict) -> dict[str, str]:
    env = os.environ.copy()
    token = str(config.get("token", ""))
    if token:
        env["LIBTV_TOKEN"] = token
    else:
        env.pop("LIBTV_TOKEN", None)
    return env


def _run_libtv(*args: str, execution_config: dict | None = None) -> dict:
    config = execution_config or _legacy_native_execution_config("libtv")
    token = str(config.get("token", ""))
    try:
        result = subprocess.run(
            [str(config["cli_path"]), *args], capture_output=True, text=True, check=False,
            env=_libtv_env(config), timeout=settings.provider_command_timeout_seconds,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("LibTV 命令执行超时") from exc
    if result.returncode:
        message = result.stderr.strip() or result.stdout.strip() or "LibTV 执行失败"
        raise RuntimeError(_sanitize_provider_output(message, token))
    for line in reversed(result.stdout.splitlines()):
        if line.strip().startswith("{"):
            try:
                return json.loads(line)
            except json.JSONDecodeError:
                pass
    raise RuntimeError("LibTV 返回结果无法解析")


def _execute_libtv(generation: Generation, profile: ModelProfile) -> None:
    config = _native_execution_config(profile)
    created = _run_libtv(
        "project", "create", f"ImageHub-{generation.id[:8]}", "--team-id", "0",
        "--workspace", "0", execution_config=config,
    )
    project_id = created["projectMeta"]["uuid"]
    generation.external_project_id = project_id
    _checkpoint(generation)
    nodes = []
    for index, path in enumerate(_references(generation), 1):
        node = f"参考图{index}-{generation.id[:6]}"
        _run_libtv(
            "upload", node, "--project", project_id, "--type", "image",
            "--resource", str(path), execution_config=config,
        )
        nodes.append(node)
    params = _params(generation)
    output_node = f"结果-{generation.id[:8]}"
    command = [
        "node", "create", output_node, "--project", project_id, "--type", "image",
        "--prompt", generation.original_prompt, "--set", f"model={profile.upstream_model}",
        "--set", f"ratio={params.get('ratio', '1:1')}", "--set", "count=1",
    ]
    if profile.upstream_model == "Lib Image":
        command.extend(["--set", "quality=medium", "--set", f"resolution={params.get('resolution', '2K')}"])
    elif profile.upstream_model == "Qwen image 3.0":
        command.extend(["--set", "quality=std", "--set", f"resolution={params.get('resolution', '2K')}"])
    elif profile.upstream_model in {"General image Pro", "General image V2"}:
        command.extend(["--set", f"quality={params.get('resolution', '2K')}"])
    if nodes:
        command.extend(["--set", "modeType=image2image"])
    for node in nodes:
        command.extend(["--left", node])
    command.append("--run")
    result = _run_libtv(*command, execution_config=config)
    generation.external_task_id = str(result.get("taskId") or result.get("nodeKey") or output_node)
    _checkpoint(generation)
    output_dir = settings.storage_root / f"generations/{generation.id}/results"
    output_dir.mkdir(parents=True, exist_ok=True)
    try:
        download = subprocess.run(
            [str(config["cli_path"]), "download", "--project", project_id, "--node", output_node,
             "--out", str(output_dir), "--without-ai-watermark", "--vip"],
            capture_output=True, text=True, check=False, env=_libtv_env(config),
            timeout=settings.provider_command_timeout_seconds,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("LibTV 下载超时") from exc
    if download.returncode:
        message = download.stderr.strip() or download.stdout.strip() or "LibTV 下载失败"
        raise RuntimeError(_sanitize_provider_output(message, str(config.get("token", ""))))
    files = []
    for path in output_dir.iterdir():
        try:
            validate_artifact(path)
            files.append(path)
        except InvalidImage:
            continue
    if not files:
        raise RuntimeError("LibTV 未下载到图片")
    generation.artifact_storage_key = str(max(files, key=lambda path: path.stat().st_mtime).relative_to(settings.storage_root))


def _run_lovart(*args: str, execution_config: dict | None = None) -> dict:
    config = execution_config or _legacy_native_execution_config("lovart")
    access_key = str(config["access_key"])
    secret_key = str(config["secret_key"])
    env = os.environ.copy()
    env.update(
        LOVART_ACCESS_KEY=access_key,
        LOVART_SECRET_KEY=secret_key,
        LOVART_BASE_URL=str(config["base_url"]),
    )
    try:
        result = subprocess.run(
            ["python3", str(config["skill_script"]), *args], capture_output=True,
            text=True, check=False, env=env, timeout=settings.provider_command_timeout_seconds,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("Lovart 命令执行超时") from exc
    if result.returncode:
        message = result.stderr.strip() or result.stdout.strip() or "Lovart 执行失败"
        raise RuntimeError(_sanitize_provider_output(message, access_key, secret_key))
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError("Lovart 返回结果无法解析") from exc


def _execute_lovart(generation: Generation, profile: ModelProfile) -> None:
    config = _native_execution_config(profile)
    created = _run_lovart("create-project", execution_config=config)
    project_id = str(created.get("project_id") or "")
    if not project_id:
        raise RuntimeError("Lovart 未返回 Project ID")
    generation.external_project_id = project_id
    _checkpoint(generation)
    attachments = []
    for path in _references(generation):
        uploaded = _run_lovart("upload", "--file", str(path), execution_config=config)
        if not uploaded.get("url"):
            raise RuntimeError("Lovart 参考图上传失败")
        attachments.append(uploaded["url"])
    output_dir = settings.storage_root / f"generations/{generation.id}/results"
    output_dir.mkdir(parents=True, exist_ok=True)
    command = [
        "chat", "--project-id", project_id, "--prompt", generation.original_prompt,
        "--prefer-models", json.dumps({"IMAGE": [profile.upstream_model]}, separators=(",", ":")),
        "--mode", "fast", "--json", "--download", "--output-dir", str(output_dir),
    ]
    if attachments:
        command.extend(["--attachments", *attachments])
    result = _run_lovart(*command, execution_config=config)
    generation.external_task_id = str(result.get("thread_id") or "")
    _checkpoint(generation)
    if result.get("final_status") == "pending_confirmation":
        raise RuntimeError("Lovart 要求确认高成本操作，请由管理员检查上游任务")
    downloaded = [item for item in result.get("downloaded", []) if item.get("type") == "image" and item.get("local_path")]
    if not downloaded:
        raise RuntimeError("Lovart 未返回图片")
    source = Path(downloaded[0]["local_path"])
    target = output_dir / f"result{source.suffix or '.png'}"
    if source.resolve() != target.resolve():
        shutil.copy2(source, target)
    validate_artifact(target)
    generation.artifact_storage_key = str(target.relative_to(settings.storage_root))


def _data_url(path: Path) -> str:
    mime = "image/png" if path.suffix.lower() == ".png" else "image/webp" if path.suffix.lower() == ".webp" else "image/jpeg"
    return f"data:{mime};base64,{base64.b64encode(path.read_bytes()).decode()}"


def _execute_api(generation: Generation, profile: ModelProfile) -> None:
    params = _params(generation)
    resolution = params.get("resolution")
    ratio = params.get("ratio")
    quality = params.get("quality")
    if resolution not in profile.resolutions or resolution not in API_RESOLUTIONS:
        raise RuntimeError("API 任务包含执行器不支持的分辨率")
    if ratio not in profile.ratios or ratio not in API_RATIOS:
        raise RuntimeError("API 任务包含执行器不支持的比例")
    if quality not in profile.qualities or quality not in API_QUALITIES:
        raise RuntimeError("API 任务包含执行器不支持的质量参数")
    if len(generation.references) > profile.max_references:
        raise RuntimeError("API 任务参考图数量超过冻结能力上限")
    edge = {"1K": 1024, "2K": 2048, "4K": 4096}[resolution]
    ratio_dimensions = {
        "1:1": (edge, edge), "4:3": (edge, edge * 3 // 4),
        "3:4": (edge * 3 // 4, edge), "16:9": (edge, edge * 9 // 16),
        "9:16": (edge * 9 // 16, edge),
    }
    width, height = ratio_dimensions[ratio]
    body = {
        "model": profile.upstream_model,
        "prompt": generation.original_prompt,
        "size": f"{width}x{height}",
        "n": 1,
        "response_format": "b64_json",
        "watermark": False,
    }
    if quality != "standard":
        body["quality"] = quality
    references = _references(generation)
    if references:
        body["image"] = [_data_url(path) for path in references]
    api_config = _load_api_execution_config(profile.execution_config_id)
    with httpx.Client(timeout=300) as client:
        response = client.post(
            f"{str(api_config['base_url']).rstrip('/')}/images/generations",
            headers={"Authorization": f"Bearer {api_config['api_key']}"}, json=body,
        )
        response.raise_for_status()
        payload = response.json()
    generation.external_task_id = str(payload.get("id") or "")
    image = (payload.get("data") or [{}])[0]
    output_dir = settings.storage_root / f"generations/{generation.id}/results"
    output_dir.mkdir(parents=True, exist_ok=True)
    target = output_dir / "result.png"
    if image.get("b64_json"):
        payload = base64.b64decode(image["b64_json"])
        if len(payload) > settings.max_artifact_bytes:
            raise RuntimeError("图像 API 返回文件超过大小限制")
        target.write_bytes(payload)
    elif image.get("url"):
        with httpx.Client(timeout=120) as client:
            download = client.get(image["url"])
            download.raise_for_status()
            if len(download.content) > settings.max_artifact_bytes:
                raise RuntimeError("图像 API 返回文件超过大小限制")
            target.write_bytes(download.content)
    else:
        raise RuntimeError("图像 API 未返回图片")
    validate_artifact(target)
    generation.artifact_storage_key = str(target.relative_to(settings.storage_root))


def _validate_frozen_capabilities(generation: Generation, profile: ModelProfile) -> None:
    params = _params(generation)
    if params.get("ratio") not in profile.ratios:
        raise RuntimeError("任务比例不在冻结能力范围内")
    if params.get("resolution") not in profile.resolutions:
        raise RuntimeError("任务分辨率不在冻结能力范围内")
    if params.get("quality") not in profile.qualities:
        raise RuntimeError("任务质量不在冻结能力范围内")
    if len(generation.references) > profile.max_references:
        raise RuntimeError("任务参考图数量超过冻结能力上限")


def _generation_frozen_profile(generation: Generation) -> ModelProfile | None:
    try:
        payload = json.loads(generation.provider_snapshot_json or "{}")
    except json.JSONDecodeError:
        return None
    if not isinstance(payload, dict):
        return None
    try:
        return ModelProfile(**payload)
    except TypeError:
        if payload.get("execution_config_id"):
            return None
        return get_profile(f"{generation.provider}:{generation.model_id}")


def execute_generation(generation_id: str) -> None:
    from image_hub.db import SessionLocal

    with SessionLocal() as session:
        generation = session.get(Generation, generation_id)
        if not generation:
            return
        profile = _generation_frozen_profile(generation)
        generation.status = "running"
        session.commit()
        try:
            if not profile or not profile.enabled:
                raise RuntimeError("生成平台或模型当前不可用")
            _validate_frozen_capabilities(generation, profile)
            executor = {"libtv": _execute_libtv, "lovart": _execute_lovart, "api": _execute_api}.get(
                profile.provider
            )
            if executor is None:
                raise RuntimeError("任务执行器未知")
            executor(generation, profile)
            generation.status = "succeeded"
        except Exception as exc:  # noqa: BLE001
            generation.status = (
                "recovery_required"
                if generation.external_project_id or generation.external_task_id
                else "failed"
            )
            generation.error_message = (
                "API 图像生成失败，请联系管理员检查服务端配置"
                if profile and profile.provider == "api"
                else str(exc)[-2000:]
            )
        finally:
            generation.finished_at = utcnow()
            generation.lease_owner = ""
            generation.lease_expires_at = None
            session.commit()


def recover_generation(generation_id: str) -> tuple[bool, str]:
    from image_hub.db import SessionLocal

    with SessionLocal() as session:
        generation = session.get(Generation, generation_id)
        if not generation or generation.status != "recovery_required":
            raise RuntimeError("任务不处于待恢复状态")
        output_dir = settings.storage_root / f"generations/{generation.id}/results"
        output_dir.mkdir(parents=True, exist_ok=True)
        profile = _generation_frozen_profile(generation)
        if not profile:
            raise RuntimeError("任务缺少有效的平台快照")
        if generation.provider == "libtv":
            if not generation.external_project_id:
                raise RuntimeError("LibTV 任务缺少外部 Project ID")
            config = _native_execution_config(profile)
            output_node = f"结果-{generation.id[:8]}"
            result = _run_libtv(
                "node", output_node, "--project", generation.external_project_id,
                execution_config=config,
            )
            data = result.get("data", {}) if isinstance(result, dict) else {}
            urls = data.get("url", []) if isinstance(data, dict) else []
            task_info = data.get("taskInfo", {}) if isinstance(data, dict) else {}
            if not urls:
                status_value = task_info.get("status", "unknown")
                progress = task_info.get("progressPercent", 0)
                message = f"LibTV 上游状态 {status_value}，进度 {progress}%，暂未产生结果。"
                generation.error_message = message
                session.commit()
                return False, message
            _execute_libtv_download(generation, output_node, output_dir, config)
        elif generation.provider == "lovart":
            if not generation.external_task_id:
                raise RuntimeError("Lovart 任务缺少外部 Thread ID")
            config = _native_execution_config(profile)
            result = _run_lovart(
                "result", "--thread-id", generation.external_task_id, "--json", "--download",
                "--output-dir", str(output_dir), execution_config=config,
            )
            downloaded = [
                item for item in result.get("downloaded", [])
                if item.get("type") == "image" and item.get("local_path")
            ]
            if not downloaded:
                generation.error_message = "Lovart 上游暂未返回可下载图片。"
                session.commit()
                return False, generation.error_message
            source = Path(downloaded[0]["local_path"])
            target = output_dir / f"result{source.suffix or '.png'}"
            if source.resolve() != target.resolve():
                shutil.copy2(source, target)
            validate_artifact(target)
            generation.artifact_storage_key = str(target.relative_to(settings.storage_root))
        else:
            raise RuntimeError("该 API 为同步接口，没有可查询的外部恢复任务")
        generation.status = "succeeded"
        generation.error_message = ""
        generation.finished_at = utcnow()
        generation.lease_owner = ""
        generation.lease_expires_at = None
        session.commit()
        return True, "已从上游恢复生成结果"


def _execute_libtv_download(
    generation: Generation, output_node: str, output_dir: Path, config: dict
) -> None:
    try:
        download = subprocess.run(
            [str(config["cli_path"]), "download", "--project", generation.external_project_id,
             "--node", output_node, "--out", str(output_dir), "--without-ai-watermark", "--vip"],
            capture_output=True, text=True, check=False, env=_libtv_env(config),
            timeout=settings.provider_command_timeout_seconds,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("LibTV 恢复下载超时") from exc
    if download.returncode:
        message = download.stderr.strip() or download.stdout.strip() or "LibTV 恢复下载失败"
        raise RuntimeError(_sanitize_provider_output(message, str(config.get("token", ""))))
    files = []
    for path in output_dir.iterdir():
        try:
            validate_artifact(path)
            files.append(path)
        except InvalidImage:
            continue
    if not files:
        raise RuntimeError("LibTV 上游有结果，但未下载到有效图片")
    artifact = max(files, key=lambda path: path.stat().st_mtime)
    generation.artifact_storage_key = str(artifact.relative_to(settings.storage_root))
