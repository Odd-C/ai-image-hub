import hashlib
import io
from dataclasses import dataclass
from pathlib import Path

from fastapi import UploadFile
from PIL import Image, UnidentifiedImageError

from image_hub.config import settings

ALLOWED_FORMATS = {"PNG": ".png", "JPEG": ".jpg", "WEBP": ".webp"}
MAX_IMAGE_PIXELS = 60_000_000


class InvalidImage(ValueError):
    pass


@dataclass(frozen=True)
class StoredImage:
    storage_key: str
    sha256: str
    mime_type: str
    width: int
    height: int


async def store_reference(generation_id: str, reference_id: str, upload: UploadFile) -> StoredImage:
    payload = await upload.read(settings.max_upload_bytes + 1)
    if not payload or len(payload) > settings.max_upload_bytes:
        raise InvalidImage("图片为空或超过 30 MB")
    try:
        with Image.open(io.BytesIO(payload)) as image:
            image.verify()
        with Image.open(io.BytesIO(payload)) as image:
            image_format, (width, height) = image.format or "", image.size
    except (UnidentifiedImageError, OSError) as exc:
        raise InvalidImage("无法识别该图片") from exc
    if image_format not in ALLOWED_FORMATS or width < 64 or height < 64:
        raise InvalidImage("仅支持宽高不小于 64px 的 PNG、JPEG、WebP")
    if width * height > MAX_IMAGE_PIXELS:
        raise InvalidImage("图片像素总量过大")
    extension = ALLOWED_FORMATS[image_format]
    storage_key = f"generations/{generation_id}/references/{reference_id}{extension}"
    target = settings.storage_root / storage_key
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(payload)
    return StoredImage(
        storage_key=storage_key,
        sha256=hashlib.sha256(payload).hexdigest(),
        mime_type={"PNG": "image/png", "JPEG": "image/jpeg", "WEBP": "image/webp"}[image_format],
        width=width,
        height=height,
    )


def resolve_storage_key(storage_key: str) -> Path:
    root = settings.storage_root.resolve()
    candidate = (root / storage_key).resolve()
    if not candidate.is_relative_to(root):
        raise ValueError("非法存储路径")
    return candidate
