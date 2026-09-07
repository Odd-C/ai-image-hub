import base64
import hashlib
import hmac
import os

from fastapi import HTTPException, Request, status
from sqlalchemy.orm import Session

from image_hub.models import User


def hash_password(password: str) -> str:
    salt = os.urandom(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 310_000)
    return "pbkdf2_sha256$310000$" + base64.b64encode(salt).decode() + "$" + base64.b64encode(digest).decode()


def verify_password(password: str, encoded: str) -> bool:
    try:
        algorithm, rounds, salt_text, expected_text = encoded.split("$", 3)
        if algorithm != "pbkdf2_sha256":
            return False
        actual = hashlib.pbkdf2_hmac(
            "sha256", password.encode(), base64.b64decode(salt_text), int(rounds)
        )
        return hmac.compare_digest(actual, base64.b64decode(expected_text))
    except (ValueError, TypeError):
        return False


def current_user(request: Request, session: Session) -> User:
    user_id = request.session.get("user_id")
    user = session.get(User, user_id) if user_id else None
    if user is None or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="请先登录")
    return user


def require_admin(user: User) -> None:
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="需要管理员权限")
