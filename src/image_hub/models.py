import uuid
from datetime import UTC, datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from image_hub.db import Base


def utcnow() -> datetime:
    return datetime.now(UTC)


def new_id() -> str:
    return uuid.uuid4().hex


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    username: Mapped[str] = mapped_column(String(80), unique=True, index=True)
    display_name: Mapped[str] = mapped_column(String(120), default="")
    department: Mapped[str] = mapped_column(String(120), default="")
    password_hash: Mapped[str] = mapped_column(String(300))
    role: Mapped[str] = mapped_column(String(20), default="user")
    is_active: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    projects: Mapped[list["Project"]] = relationship(
        back_populates="user", cascade="all, delete-orphan", order_by="Project.updated_at.desc()"
    )
    generations: Mapped[list["Generation"]] = relationship(back_populates="user")


class Project(Base):
    __tablename__ = "projects"
    __table_args__ = (UniqueConstraint("user_id", "name"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    name: Mapped[str] = mapped_column(String(160))
    description: Mapped[str] = mapped_column(Text, default="")
    canvas_state_json: Mapped[str] = mapped_column(Text, default="{}")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow, index=True
    )
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    user: Mapped[User] = relationship(back_populates="projects")
    generations: Mapped[list["Generation"]] = relationship(
        back_populates="project", cascade="all, delete-orphan",
        order_by="Generation.created_at.desc()",
    )


class Generation(Base):
    __tablename__ = "generations"
    __table_args__ = (UniqueConstraint("project_id", "idempotency_key"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    idempotency_key: Mapped[str] = mapped_column(String(64), index=True)
    original_prompt: Mapped[str] = mapped_column(Text)
    provider: Mapped[str] = mapped_column(String(40), index=True)
    model_id: Mapped[str] = mapped_column(String(120), index=True)
    model_label: Mapped[str] = mapped_column(String(160))
    provider_snapshot_json: Mapped[str] = mapped_column(Text, default="{}")
    parameters_json: Mapped[str] = mapped_column(Text, default="{}")
    reference_manifest_json: Mapped[str] = mapped_column(Text, default="[]")
    parent_generation_id: Mapped[str] = mapped_column(String(32), default="", index=True)
    status: Mapped[str] = mapped_column(String(40), default="queued", index=True)
    sentiment: Mapped[str] = mapped_column(String(20), default="", index=True)
    external_project_id: Mapped[str] = mapped_column(String(160), default="")
    external_task_id: Mapped[str] = mapped_column(String(160), default="")
    artifact_storage_key: Mapped[str] = mapped_column(String(500), default="")
    error_message: Mapped[str] = mapped_column(Text, default="")
    attempt_count: Mapped[int] = mapped_column(Integer, default=0)
    lease_owner: Mapped[str] = mapped_column(String(160), default="")
    lease_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    user: Mapped[User] = relationship(back_populates="generations")
    project: Mapped[Project] = relationship(back_populates="generations")
    references: Mapped[list["ReferenceImage"]] = relationship(
        back_populates="generation", cascade="all, delete-orphan", order_by="ReferenceImage.position"
    )


class ReferenceImage(Base):
    __tablename__ = "reference_images"
    __table_args__ = (UniqueConstraint("generation_id", "position"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    generation_id: Mapped[str] = mapped_column(ForeignKey("generations.id", ondelete="CASCADE"))
    position: Mapped[int] = mapped_column(Integer)
    original_name: Mapped[str] = mapped_column(String(255))
    storage_key: Mapped[str] = mapped_column(String(500), unique=True)
    sha256: Mapped[str] = mapped_column(String(64))
    mime_type: Mapped[str] = mapped_column(String(80))
    width: Mapped[int] = mapped_column(Integer)
    height: Mapped[int] = mapped_column(Integer)

    generation: Mapped[Generation] = relationship(back_populates="references")
