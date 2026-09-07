from collections.abc import Generator

from sqlalchemy import Engine, create_engine, event, select
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from image_hub.config import settings


class Base(DeclarativeBase):
    pass


engine: Engine = create_engine(
    settings.database_url,
    connect_args={"check_same_thread": False} if settings.database_url.startswith("sqlite") else {},
)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


if settings.database_url.startswith("sqlite"):
    @event.listens_for(engine, "connect")
    def configure_sqlite(dbapi_connection, _connection_record) -> None:
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.close()


def init_database() -> None:
    from image_hub.auth import hash_password
    from image_hub.models import User

    Base.metadata.create_all(bind=engine)
    with SessionLocal() as session:
        admin = session.scalar(select(User).where(User.username == settings.bootstrap_admin_username))
        if admin is None:
            session.add(
                User(
                    username=settings.bootstrap_admin_username,
                    display_name="管理员",
                    password_hash=hash_password(settings.bootstrap_admin_password),
                    role="admin",
                )
            )
            session.commit()


def get_session() -> Generator[Session, None, None]:
    with SessionLocal() as session:
        yield session
