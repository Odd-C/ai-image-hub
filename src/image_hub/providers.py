import base64
import json
import os
import shutil
import subprocess
from dataclasses import asdict, dataclass
from pathlib import Path

import httpx
from sqlalchemy.orm import object_session

from image_hub.config import settings
from image_hub.models import Generation, utcnow
from image_hub.storage import resolve_storage_key


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

    def public_dict(self) -> dict:
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


def model_profiles() -> tuple[ModelProfile, ...]:
    profiles = [
        ModelProfile(
            id=f"libtv:{key}", label=label, provider="libtv", upstream_model=label,
            enabled=settings.libtv_cli.is_file(),
        )
        for key, label in LIBTV_MODELS
    ]
    lovart_ready = bool(
        settings.lovart_access_key and settings.lovart_secret_key and settings.lovart_skill_script.is_file()
    )
    profiles.extend(
        [
            ModelProfile(
                "lovart:nano-banana-pro", "Nano Banana Pro", "lovart",
                "generate_image_nano_banana_pro", lovart_ready, ratios=("1:1",),
            ),
            ModelProfile(
                "lovart:nano-banana-2", "Nano Banana 2", "lovart",
                "generate_image_nano_banana_2", lovart_ready, ratios=("1:1",),
            ),
        ]
    )
    for item in settings.openai_image_models.split(","):
        model_id, _, label = item.strip().partition("|")
        if model_id:
            profiles.append(
                ModelProfile(
                    id=f"api:{model_id}", label=label or model_id, provider="api",
                    upstream_model=model_id, enabled=bool(settings.openai_image_api_key),
                )
            )
    return tuple(profiles)


def get_profile(profile_id: str) -> ModelProfile | None:
    return next((profile for profile in model_profiles() if profile.id == profile_id), None)


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


def _run_libtv(*args: str) -> dict:
    result = subprocess.run(
        [str(settings.libtv_cli), *args], capture_output=True, text=True, check=False
    )
    if result.returncode:
        raise RuntimeError((result.stderr.strip() or result.stdout.strip() or "LibTV 执行失败")[-2000:])
    for line in reversed(result.stdout.splitlines()):
        if line.strip().startswith("{"):
            try:
                return json.loads(line)
            except json.JSONDecodeError:
                pass
    raise RuntimeError("LibTV 返回结果无法解析")


def _execute_libtv(generation: Generation, profile: ModelProfile) -> None:
    created = _run_libtv("project", "create", f"ImageHub-{generation.id[:8]}", "--team-id", "0", "--workspace", "0")
    project_id = created["projectMeta"]["uuid"]
    generation.external_project_id = project_id
    _checkpoint(generation)
    nodes = []
    for index, path in enumerate(_references(generation), 1):
        node = f"参考图{index}-{generation.id[:6]}"
        _run_libtv("upload", node, "--project", project_id, "--type", "image", "--resource", str(path))
        nodes.append(node)
    params = _params(generation)
    output_node = f"结果-{generation.id[:8]}"
    command = [
        "node", "create", output_node, "--project", project_id, "--type", "image",
        "--prompt", generation.original_prompt, "--set", f"model={profile.upstream_model}",
        "--set", f"ratio={params.get('ratio', '1:1')}", "--set", "count=1",
    ]
    if profile.upstream_model == "Lib Image":
        command.extend(["--set", "quality=medium", "--set", "resolution=2K"])
    elif profile.upstream_model == "Qwen image 3.0":
        command.extend(["--set", "quality=std", "--set", "resolution=2K"])
    elif profile.upstream_model in {"General image Pro", "General image V2"}:
        command.extend(["--set", "quality=2K"])
    if nodes:
        command.extend(["--set", "modeType=image2image"])
    for node in nodes:
        command.extend(["--left", node])
    command.append("--run")
    result = _run_libtv(*command)
    generation.external_task_id = str(result.get("taskId") or result.get("nodeKey") or output_node)
    _checkpoint(generation)
    output_dir = settings.storage_root / f"generations/{generation.id}/results"
    output_dir.mkdir(parents=True, exist_ok=True)
    download = subprocess.run(
        [str(settings.libtv_cli), "download", "--project", project_id, "--node", output_node,
         "--out", str(output_dir), "--without-ai-watermark", "--vip"],
        capture_output=True, text=True, check=False,
    )
    if download.returncode:
        raise RuntimeError((download.stderr.strip() or download.stdout.strip() or "LibTV 下载失败")[-2000:])
    files = [path for path in output_dir.iterdir() if path.is_file()]
    if not files:
        raise RuntimeError("LibTV 未下载到图片")
    generation.artifact_storage_key = str(max(files, key=lambda path: path.stat().st_mtime).relative_to(settings.storage_root))


def _run_lovart(*args: str) -> dict:
    env = os.environ.copy()
    env.update(
        LOVART_ACCESS_KEY=settings.lovart_access_key,
        LOVART_SECRET_KEY=settings.lovart_secret_key,
        LOVART_BASE_URL=settings.lovart_base_url,
    )
    result = subprocess.run(
        ["python3", str(settings.lovart_skill_script), *args], capture_output=True,
        text=True, check=False, env=env,
    )
    if result.returncode:
        raise RuntimeError((result.stderr.strip() or result.stdout.strip() or "Lovart 执行失败")[-2000:])
    return json.loads(result.stdout)


def _execute_lovart(generation: Generation, profile: ModelProfile) -> None:
    created = _run_lovart("create-project")
    project_id = str(created.get("project_id") or "")
    if not project_id:
        raise RuntimeError("Lovart 未返回 Project ID")
    generation.external_project_id = project_id
    _checkpoint(generation)
    attachments = []
    for path in _references(generation):
        uploaded = _run_lovart("upload", "--file", str(path))
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
    result = _run_lovart(*command)
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
    generation.artifact_storage_key = str(target.relative_to(settings.storage_root))


def _data_url(path: Path) -> str:
    mime = "image/png" if path.suffix.lower() == ".png" else "image/webp" if path.suffix.lower() == ".webp" else "image/jpeg"
    return f"data:{mime};base64,{base64.b64encode(path.read_bytes()).decode()}"


def _execute_api(generation: Generation, profile: ModelProfile) -> None:
    params = _params(generation)
    ratio_sizes = {"1:1": "2048x2048", "4:3": "2048x1536", "3:4": "1536x2048", "16:9": "2048x1152", "9:16": "1152x2048"}
    body = {
        "model": profile.upstream_model,
        "prompt": generation.original_prompt,
        "size": ratio_sizes.get(params.get("ratio"), "2048x2048"),
        "n": 1,
        "response_format": "b64_json",
        "watermark": False,
    }
    if params.get("quality") not in (None, "standard"):
        body["quality"] = params["quality"]
    references = _references(generation)
    if references:
        body["image"] = [_data_url(path) for path in references]
    with httpx.Client(timeout=300) as client:
        response = client.post(
            f"{settings.openai_image_base_url.rstrip('/')}/images/generations",
            headers={"Authorization": f"Bearer {settings.openai_image_api_key}"}, json=body,
        )
        response.raise_for_status()
        payload = response.json()
    generation.external_task_id = str(payload.get("id") or "")
    image = (payload.get("data") or [{}])[0]
    output_dir = settings.storage_root / f"generations/{generation.id}/results"
    output_dir.mkdir(parents=True, exist_ok=True)
    target = output_dir / "result.png"
    if image.get("b64_json"):
        target.write_bytes(base64.b64decode(image["b64_json"]))
    elif image.get("url"):
        with httpx.Client(timeout=120) as client:
            download = client.get(image["url"])
            download.raise_for_status()
            target.write_bytes(download.content)
    else:
        raise RuntimeError("图像 API 未返回图片")
    generation.artifact_storage_key = str(target.relative_to(settings.storage_root))


def execute_generation(generation_id: str) -> None:
    from image_hub.db import SessionLocal

    with SessionLocal() as session:
        generation = session.get(Generation, generation_id)
        if not generation:
            return
        try:
            profile = ModelProfile(**json.loads(generation.provider_snapshot_json or "{}"))
        except (TypeError, json.JSONDecodeError):
            profile = get_profile(f"{generation.provider}:{generation.model_id}")
        generation.status = "running"
        session.commit()
        try:
            if not profile or not profile.enabled:
                raise RuntimeError("生成平台或模型当前不可用")
            {"libtv": _execute_libtv, "lovart": _execute_lovart, "api": _execute_api}[profile.provider](generation, profile)
            generation.status = "succeeded"
        except Exception as exc:  # noqa: BLE001
            generation.status = "failed"
            generation.error_message = str(exc)[-2000:]
        finally:
            generation.finished_at = utcnow()
            generation.lease_owner = ""
            generation.lease_expires_at = None
            session.commit()
