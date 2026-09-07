import json
import shutil

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile, status
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from image_hub.auth import current_user, hash_password, require_admin, verify_password
from image_hub.config import settings
from image_hub.db import get_session
from image_hub.models import Generation, ReferenceImage, User, new_id
from image_hub.providers import get_profile, model_profiles
from image_hub.storage import InvalidImage, resolve_storage_key, store_reference
from image_hub.worker import generation_worker

router = APIRouter()
templates = Jinja2Templates(directory=settings.template_dir)
SENTIMENTS = {"satisfied", "adopted", "dissatisfied"}


def _user_or_redirect(request: Request, session: Session) -> User | None:
    user_id = request.session.get("user_id")
    user = session.get(User, user_id) if user_id else None
    return user if user and user.is_active else None


def _owned_generation(session: Session, user: User, generation_id: str) -> Generation:
    generation = session.get(Generation, generation_id)
    if generation is None or (user.role != "admin" and generation.user_id != user.id):
        raise HTTPException(404, "生成记录不存在")
    return generation


@router.get("/login")
def login_page(request: Request):
    return templates.TemplateResponse(request, "login.html", {"error": ""})


@router.post("/login")
def login(
    request: Request,
    username: str = Form(...),
    password: str = Form(...),
    session: Session = Depends(get_session),
):
    user = session.scalar(select(User).where(User.username == username.strip()))
    if user is None or not user.is_active or not verify_password(password, user.password_hash):
        return templates.TemplateResponse(
            request, "login.html", {"error": "账号或密码不正确"}, status_code=401
        )
    request.session.clear()
    request.session["user_id"] = user.id
    return RedirectResponse("/", status_code=status.HTTP_303_SEE_OTHER)


@router.post("/logout")
def logout(request: Request):
    request.session.clear()
    return RedirectResponse("/login", status_code=status.HTTP_303_SEE_OTHER)


@router.get("/")
def workspace(request: Request, session: Session = Depends(get_session)):
    user = _user_or_redirect(request, session)
    if not user:
        return RedirectResponse("/login", status_code=status.HTTP_303_SEE_OTHER)
    return templates.TemplateResponse(
        request,
        "workspace.html",
        {"user": user, "profiles": [profile.public_dict() for profile in model_profiles()]},
    )


@router.post("/api/generations", status_code=202)
async def create_generation(
    request: Request,
    prompt: str = Form(..., min_length=1, max_length=12000),
    profile_id: str = Form(...),
    ratio: str = Form("1:1"),
    quality: str = Form("standard"),
    parent_generation_id: str = Form(""),
    references: list[UploadFile] = File(default=[]),
    session: Session = Depends(get_session),
):
    user = current_user(request, session)
    profile = get_profile(profile_id)
    if profile is None or not profile.enabled:
        raise HTTPException(503, "平台或模型尚未启用")
    if ratio not in profile.ratios or quality not in profile.qualities:
        raise HTTPException(422, "模型参数无效")
    if len(references) > 14:
        raise HTTPException(422, "参考图最多 14 张")
    active_count = session.scalar(
        select(func.count()).select_from(Generation).where(
            Generation.user_id == user.id,
            Generation.status.in_(("queued", "running")),
        )
    )
    if (active_count or 0) >= settings.max_active_tasks_per_user:
        raise HTTPException(429, "当前进行中的任务已达到上限，请稍后再试")
    if parent_generation_id:
        parent = session.scalar(
            select(Generation.id).where(
                Generation.id == parent_generation_id,
                Generation.user_id == user.id,
            )
        )
        if parent is None:
            raise HTTPException(422, "来源历史记录无效")
    clean_prompt = prompt.strip()
    generation = Generation(
        user_id=user.id,
        original_prompt=clean_prompt,
        provider=profile.provider,
        model_id=profile.id.split(":", 1)[1],
        model_label=profile.label,
        parameters_json=json.dumps({"ratio": ratio, "quality": quality}, ensure_ascii=False),
        parent_generation_id=parent_generation_id,
        status="queued",
    )
    session.add(generation)
    session.flush()
    manifest = []
    try:
        for position, upload in enumerate([item for item in references if item.filename], 1):
            reference_id = new_id()
            stored = await store_reference(generation.id, reference_id, upload)
            reference = ReferenceImage(
                id=reference_id,
                generation_id=generation.id,
                position=position,
                original_name=upload.filename or f"reference-{position}",
                storage_key=stored.storage_key,
                sha256=stored.sha256,
                mime_type=stored.mime_type,
                width=stored.width,
                height=stored.height,
            )
            session.add(reference)
            manifest.append(
                {"id": reference_id, "position": position, "name": reference.original_name,
                 "sha256": stored.sha256, "width": stored.width, "height": stored.height}
            )
    except InvalidImage as exc:
        session.rollback()
        shutil.rmtree(settings.storage_root / f"generations/{generation.id}", ignore_errors=True)
        raise HTTPException(422, str(exc)) from exc
    generation.reference_manifest_json = json.dumps(manifest, ensure_ascii=False)
    session.commit()
    generation_worker.wake()
    return {"id": generation.id, "status": generation.status}


@router.get("/api/generations")
def list_generations(
    request: Request,
    q: str = "",
    provider: str = "",
    sentiment: str = "",
    limit: int = 60,
    session: Session = Depends(get_session),
):
    user = current_user(request, session)
    query = select(Generation).where(Generation.user_id == user.id)
    if q.strip():
        query = query.where(Generation.original_prompt.contains(q.strip()))
    if provider:
        query = query.where(Generation.provider == provider)
    if sentiment:
        query = query.where(Generation.sentiment == sentiment)
    generations = session.scalars(query.order_by(Generation.created_at.desc()).limit(min(limit, 100))).all()
    return {
        "items": [
            {
                "id": item.id,
                "prompt": item.original_prompt,
                "provider": item.provider,
                "model_id": item.model_id,
                "model_label": item.model_label,
                "parameters": json.loads(item.parameters_json or "{}"),
                "references": json.loads(item.reference_manifest_json or "[]"),
                "parent_generation_id": item.parent_generation_id,
                "status": item.status,
                "sentiment": item.sentiment,
                "error": item.error_message,
                "created_at": item.created_at.isoformat(),
                "artifact_url": f"/generations/{item.id}/artifact" if item.artifact_storage_key else "",
            }
            for item in generations
        ]
    }


@router.post("/api/generations/{generation_id}/sentiment")
async def mark_sentiment(
    generation_id: str,
    request: Request,
    session: Session = Depends(get_session),
):
    user = current_user(request, session)
    payload = await request.json()
    sentiment = str(payload.get("sentiment", ""))
    if sentiment not in SENTIMENTS:
        raise HTTPException(422, "标记必须是满意、采用或不满意")
    generation = _owned_generation(session, user, generation_id)
    if generation.status != "succeeded":
        raise HTTPException(409, "只有成功结果可以标记")
    generation.sentiment = sentiment
    session.commit()
    return {"id": generation.id, "sentiment": sentiment}


@router.post("/api/generations/{generation_id}/retry", status_code=202)
def retry_generation(
    generation_id: str,
    request: Request,
    session: Session = Depends(get_session),
):
    user = current_user(request, session)
    source = _owned_generation(session, user, generation_id)
    if source.status not in {"failed", "recovery_required"} or source.external_task_id:
        raise HTTPException(409, "该任务不能安全重试")
    source.status = "queued"
    source.error_message = ""
    source.started_at = None
    source.finished_at = None
    source.lease_owner = ""
    source.lease_expires_at = None
    session.commit()
    generation_worker.wake()
    return {"id": source.id, "status": source.status}


@router.get("/generations/{generation_id}/artifact")
def artifact(
    generation_id: str,
    request: Request,
    download: bool = False,
    session: Session = Depends(get_session),
):
    user = current_user(request, session)
    generation = _owned_generation(session, user, generation_id)
    path = resolve_storage_key(generation.artifact_storage_key)
    if not generation.artifact_storage_key or not path.is_file():
        raise HTTPException(404, "图片不存在")
    return FileResponse(path, filename=path.name if download else None)


@router.get("/generations/{generation_id}/references/{reference_id}")
def reference_file(
    generation_id: str,
    reference_id: str,
    request: Request,
    session: Session = Depends(get_session),
):
    user = current_user(request, session)
    generation = _owned_generation(session, user, generation_id)
    reference = session.get(ReferenceImage, reference_id)
    if not reference or reference.generation_id != generation.id:
        raise HTTPException(404, "参考图不存在")
    return FileResponse(resolve_storage_key(reference.storage_key))


@router.get("/admin")
def admin_page(request: Request, session: Session = Depends(get_session)):
    user = _user_or_redirect(request, session)
    if not user:
        return RedirectResponse("/login", status_code=303)
    require_admin(user)
    users = session.scalars(select(User).order_by(User.created_at)).all()
    counts = {
        row[0]: row[1]
        for row in session.execute(
            select(Generation.status, func.count()).group_by(Generation.status)
        )
    }
    return templates.TemplateResponse(
        request, "admin.html", {"user": user, "users": users, "counts": counts,
                                "profiles": model_profiles()}
    )


@router.post("/admin/users")
def create_user(
    request: Request,
    username: str = Form(..., min_length=2, max_length=80),
    password: str = Form(..., min_length=8, max_length=200),
    display_name: str = Form("", max_length=120),
    department: str = Form("", max_length=120),
    role: str = Form("user"),
    session: Session = Depends(get_session),
):
    admin = current_user(request, session)
    require_admin(admin)
    clean_username = username.strip()
    if session.scalar(select(User).where(User.username == clean_username)):
        raise HTTPException(409, "用户名已存在")
    session.add(
        User(username=clean_username, display_name=display_name.strip(), department=department.strip(),
             role=role if role in {"user", "admin"} else "user", password_hash=hash_password(password))
    )
    session.commit()
    return RedirectResponse("/admin", status_code=303)


@router.post("/admin/users/{user_id}/toggle")
def toggle_user(user_id: str, request: Request, session: Session = Depends(get_session)):
    admin = current_user(request, session)
    require_admin(admin)
    user = session.get(User, user_id)
    if not user or user.id == admin.id:
        raise HTTPException(409, "不能操作该账号")
    user.is_active = 0 if user.is_active else 1
    session.commit()
    return RedirectResponse("/admin", status_code=303)


@router.get("/health")
def health(session: Session = Depends(get_session)):
    queued = session.scalar(select(Generation).where(or_(Generation.status == "queued", Generation.status == "running")).limit(1))
    return {"status": "ok", "service": "ai-image-hub", "worker_backlog": bool(queued)}
