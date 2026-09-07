from sqlalchemy import create_engine, inspect, text

from image_hub import db
from image_hub.db import Base
from image_hub.models import Generation

LEGACY_GENERATIONS_DDL = """
CREATE TABLE generations (
    id VARCHAR(32) NOT NULL PRIMARY KEY,
    user_id VARCHAR(32) NOT NULL,
    idempotency_key VARCHAR(64) NOT NULL,
    original_prompt TEXT NOT NULL,
    provider VARCHAR(40) NOT NULL,
    model_id VARCHAR(120) NOT NULL,
    model_label VARCHAR(160) NOT NULL,
    provider_snapshot_json TEXT NOT NULL,
    parameters_json TEXT NOT NULL,
    reference_manifest_json TEXT NOT NULL,
    parent_generation_id VARCHAR(32) NOT NULL,
    status VARCHAR(40) NOT NULL,
    sentiment VARCHAR(20) NOT NULL,
    external_project_id VARCHAR(160) NOT NULL,
    external_task_id VARCHAR(160) NOT NULL,
    artifact_storage_key VARCHAR(500) NOT NULL,
    error_message TEXT NOT NULL,
    attempt_count INTEGER NOT NULL,
    lease_owner VARCHAR(160) NOT NULL,
    lease_expires_at DATETIME,
    created_at DATETIME NOT NULL,
    started_at DATETIME,
    finished_at DATETIME,
    UNIQUE (user_id, idempotency_key),
    FOREIGN KEY(user_id) REFERENCES users (id)
)
"""


def test_legacy_sqlite_migration_preserves_history_and_updates_constraints(
    tmp_path, monkeypatch
):
    database_path = tmp_path / "legacy.db"
    migration_engine = create_engine(f"sqlite:///{database_path}")
    with migration_engine.begin() as connection:
        connection.execute(text("CREATE TABLE users (id VARCHAR(32) PRIMARY KEY)"))
        connection.execute(text(LEGACY_GENERATIONS_DDL))
        connection.execute(text("INSERT INTO users (id) VALUES ('legacy-user')"))
        connection.execute(
            text(
                "INSERT INTO generations "
                "(id,user_id,idempotency_key,original_prompt,provider,model_id,model_label,"
                "provider_snapshot_json,parameters_json,reference_manifest_json,"
                "parent_generation_id,status,sentiment,external_project_id,external_task_id,"
                "artifact_storage_key,error_message,attempt_count,lease_owner,created_at) "
                "VALUES ('legacy-generation','legacy-user','same-key','旧提示词','api','model',"
                "'Model','{}','{}','[]','','succeeded','','','','','',0,'',CURRENT_TIMESTAMP)"
            )
        )

    assert Generation.__table__.metadata is Base.metadata
    Base.metadata.create_all(bind=migration_engine)
    with migration_engine.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO reference_images "
                "(id,generation_id,position,original_name,storage_key,sha256,mime_type,width,height) "
                "VALUES ('legacy-reference','legacy-generation',1,'参考图.png','legacy/reference.png',"
                "'sha256','image/png',100,100)"
            )
        )
    monkeypatch.setattr(db, "engine", migration_engine)
    monkeypatch.setattr(db.settings, "database_url", f"sqlite:///{database_path}")

    db._migrate_project_scope()
    db._migrate_project_scope()

    unique_constraints = {
        tuple(constraint["column_names"])
        for constraint in inspect(migration_engine).get_unique_constraints("generations")
    }
    assert ("project_id", "idempotency_key") in unique_constraints
    assert ("user_id", "idempotency_key") not in unique_constraints

    with migration_engine.begin() as connection:
        migrated_projects = connection.execute(
            text("SELECT id, name FROM projects WHERE user_id='legacy-user'")
        ).all()
        assert len(migrated_projects) == 1
        assert migrated_projects[0].name == "迁移的历史项目"
        assert connection.execute(
            text("SELECT project_id FROM generations WHERE id='legacy-generation'")
        ).scalar_one() == migrated_projects[0].id
        assert connection.execute(
            text(
                "SELECT generation_id FROM reference_images WHERE id='legacy-reference'"
            )
        ).scalar_one() == "legacy-generation"
        assert connection.execute(text("PRAGMA foreign_key_check")).all() == []

        connection.execute(
            text(
                "INSERT INTO projects "
                "(id,user_id,name,description,canvas_state_json,created_at,updated_at) "
                "VALUES ('second-project','legacy-user','第二个项目','','{}',"
                "CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)"
            )
        )
        connection.execute(
            text(
                "INSERT INTO generations "
                "(id,user_id,project_id,idempotency_key,original_prompt,provider,model_id,"
                "model_label,provider_snapshot_json,parameters_json,reference_manifest_json,"
                "parent_generation_id,status,sentiment,external_project_id,external_task_id,"
                "artifact_storage_key,error_message,attempt_count,lease_owner,created_at) "
                "VALUES ('second-generation','legacy-user','second-project','same-key','新提示词',"
                "'api','model','Model','{}','{}','[]','','queued','','','','','',0,'',"
                "CURRENT_TIMESTAMP)"
            )
        )
