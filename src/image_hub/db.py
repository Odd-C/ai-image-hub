import uuid
from collections.abc import Generator

from sqlalchemy import Engine, MetaData, create_engine, event, inspect, select, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker
from sqlalchemy.schema import CreateIndex, CreateTable

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
    _migrate_project_scope()
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


def _migrate_project_scope() -> None:
    """Preserve prompt history when upgrading an older SQLite database."""
    if not settings.database_url.startswith("sqlite"):
        return
    inspector = inspect(engine)
    if "generations" not in inspector.get_table_names():
        return
    columns = {column["name"] for column in inspector.get_columns("generations")}
    if "project_id" not in columns:
        with engine.begin() as connection:
            connection.execute(
                text("ALTER TABLE generations ADD COLUMN project_id VARCHAR(32) NOT NULL DEFAULT ''")
            )
            connection.execute(
                text("CREATE INDEX ix_generations_project_id ON generations (project_id)")
            )
    with engine.begin() as connection:
        user_ids = [
            row[0]
            for row in connection.execute(
                text(
                    "SELECT DISTINCT user_id FROM generations "
                    "WHERE project_id IS NULL OR project_id=''"
                )
            )
        ]
        for user_id in user_ids:
            project_id = connection.execute(
                text(
                    "SELECT id FROM projects "
                    "WHERE user_id=:user_id AND name='迁移的历史项目' LIMIT 1"
                ),
                {"user_id": user_id},
            ).scalar_one_or_none()
            if project_id is None:
                project_id = uuid.uuid4().hex
                connection.execute(
                    text(
                        "INSERT INTO projects "
                        "(id,user_id,name,description,canvas_state_json,created_at,updated_at) "
                        "VALUES (:id,:user_id,'迁移的历史项目','','{}',"
                        "CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)"
                    ),
                    {"id": project_id, "user_id": user_id},
                )
            connection.execute(
                text(
                    "UPDATE generations SET project_id=:project_id "
                    "WHERE user_id=:user_id AND (project_id IS NULL OR project_id='')"
                ),
                {"project_id": project_id, "user_id": user_id},
            )

    constraints = {
        tuple(constraint["column_names"])
        for constraint in inspect(engine).get_unique_constraints("generations")
    }
    if (
        ("project_id", "idempotency_key") not in constraints
        or ("user_id", "idempotency_key") in constraints
    ):
        _rebuild_generations_table()


def _rebuild_generations_table() -> None:
    """Replace legacy SQLite constraints without losing generations or references."""
    from image_hub.models import Generation, Project, User

    migration_metadata = MetaData()
    User.__table__.to_metadata(migration_metadata)
    Project.__table__.to_metadata(migration_metadata)
    migrated_table = Generation.__table__.to_metadata(
        migration_metadata, name="generations_project_scope"
    )
    column_names = [column.name for column in Generation.__table__.columns]
    quoted_columns = ", ".join(
        engine.dialect.identifier_preparer.quote(name) for name in column_names
    )

    with engine.connect() as connection:
        connection.exec_driver_sql("PRAGMA foreign_keys=OFF")
        connection.commit()
        try:
            with connection.begin():
                connection.execute(text("DROP TABLE IF EXISTS generations_project_scope"))
                connection.execute(CreateTable(migrated_table))
                connection.execute(
                    text(
                        "INSERT INTO generations_project_scope "
                        f"({quoted_columns}) SELECT {quoted_columns} FROM generations"
                    )
                )
                connection.execute(text("DROP TABLE generations"))
                connection.execute(
                    text("ALTER TABLE generations_project_scope RENAME TO generations")
                )
                for index in Generation.__table__.indexes:
                    connection.execute(CreateIndex(index))
        finally:
            connection.exec_driver_sql("PRAGMA foreign_keys=ON")
            violations = connection.exec_driver_sql("PRAGMA foreign_key_check").all()
            connection.commit()
        if violations:
            raise RuntimeError(f"SQLite project migration left invalid foreign keys: {violations}")


def get_session() -> Generator[Session, None, None]:
    with SessionLocal() as session:
        yield session
