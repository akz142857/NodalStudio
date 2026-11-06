use schema_model::DatabaseType;
use sqlx::{Connection, Executor, SqliteConnection, sqlite::SqliteConnectOptions};
use uuid::Uuid;
#[tokio::test]
async fn captures_schema_without_rows_and_preserves_sqlite_semantics() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("catalog.sqlite");
    let mut writer = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true),
    )
    .await
    .unwrap();
    writer.execute(r"
        CREATE TABLE parent(a TEXT,b INTEGER,PRIMARY KEY(a,b)) WITHOUT ROWID;
        CREATE TABLE child(id INTEGER PRIMARY KEY, a TEXT,b INTEGER, data, computed TEXT GENERATED ALWAYS AS (a||b) STORED, CHECK(b>=0), FOREIGN KEY(a,b) REFERENCES parent DEFERRABLE INITIALLY DEFERRED);
        CREATE TABLE multiple_keys(id INTEGER, FOREIGN KEY(id) REFERENCES parent(a), FOREIGN KEY(id) REFERENCES parent(b));
        CREATE TABLE nullable_pk(id TEXT PRIMARY KEY);
        CREATE TABLE descending_pk(id INTEGER PRIMARY KEY DESC);
        CREATE TABLE strict_table(id INTEGER PRIMARY KEY,value TEXT, arbitrary ANY) STRICT;
        CREATE UNIQUE INDEX expression_index ON child(lower(a)) WHERE b>0;
        CREATE VIEW summary AS SELECT id,a FROM child;
        CREATE TRIGGER audit AFTER INSERT ON child BEGIN SELECT 1; END;
        CREATE VIRTUAL TABLE search USING fts5(text);
    ").await.unwrap();
    let mut reader = sqlite_adapter::connect(&path).await.unwrap();
    let source = Uuid::new_v4();
    let snapshot = sqlite_adapter::inspect_schema(&mut reader, source, "catalog.sqlite")
        .await
        .unwrap();
    assert_eq!(snapshot.database.database_type, DatabaseType::Sqlite);
    let schema = &snapshot.schemas[0];
    let table = |name| schema.tables.iter().find(|t| t.key.name == name).unwrap();
    assert!(!table("child").columns[0].nullable);
    assert!(table("nullable_pk").columns[0].nullable);
    assert_ne!(
        table("multiple_keys").foreign_keys[0].name,
        table("multiple_keys").foreign_keys[1].name
    );
    assert!(table("descending_pk").columns[0].nullable);
    assert!(
        table("child")
            .columns
            .iter()
            .find(|c| c.name == "computed")
            .unwrap()
            .generated
    );
    assert_eq!(
        table("child").foreign_keys[0].referenced_columns,
        ["a", "b"]
    );
    assert!(table("child").foreign_keys[0].deferrable);
    assert!(table("child").foreign_keys[0].initially_deferred);
    assert_eq!(
        table("child").sqlite.as_ref().unwrap().columns["computed"]
            .generation_expression
            .as_deref(),
        Some("a || b")
    );
    assert_eq!(table("child").constraints.len(), 1);
    assert_eq!(
        table("child").indexes[0].predicate.as_deref(),
        Some("b > 0")
    );
    assert!(table("parent").sqlite.as_ref().unwrap().without_rowid);
    assert!(table("strict_table").sqlite.as_ref().unwrap().strict);
    assert_eq!(
        table("strict_table").sqlite.as_ref().unwrap().columns["arbitrary"].affinity,
        "NONE"
    );
    assert!(table("search").sqlite.as_ref().unwrap().virtual_table);
    assert!(!schema.tables.iter().any(|t| t.key.name == "search_data"));
    assert_eq!(schema.views.len(), 1);
    assert_eq!(schema.programs.len(), 1);
    let again = sqlite_adapter::inspect_schema(&mut reader, source, "catalog.sqlite")
        .await
        .unwrap();
    assert_eq!(snapshot.fingerprint, again.fingerprint);
    reader.close().await.unwrap();
    writer.close().await.unwrap();
}
#[tokio::test]
async fn never_creates_missing_files_and_rejects_non_databases() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("missing.db");
    assert!(sqlite_adapter::connect(&path).await.is_err());
    assert!(!path.exists());
    std::fs::write(&path, "not a sqlite database").unwrap();
    if let Ok(mut conn) = sqlite_adapter::connect(&path).await {
        assert!(
            sqlite_adapter::test_connection(&mut conn, "invalid")
                .await
                .is_err()
        );
        conn.close().await.unwrap();
    }
    assert_eq!(
        std::fs::read_to_string(path).unwrap(),
        "not a sqlite database"
    );
}

#[tokio::test]
async fn unavailable_virtual_module_keeps_definition_with_explicit_coverage() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("module.db");
    let mut writer = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true),
    )
    .await
    .unwrap();
    writer
        .execute(
            "CREATE TABLE ordinary(id INTEGER REFERENCES external(body)); CREATE VIRTUAL TABLE external USING fts5(body)",
        )
        .await
        .unwrap();
    writer.close().await.unwrap();
    // A disposable on-disk fixture emulates a database created with another module.
    let mut bytes = std::fs::read(&path).unwrap();
    let marker = b"USING fts5(";
    let at = bytes
        .windows(marker.len())
        .position(|w| w == marker)
        .unwrap();
    bytes[at + 6..at + 10].copy_from_slice(b"zzzz");
    std::fs::write(&path, bytes).unwrap();
    let mut reader = sqlite_adapter::connect(&path).await.unwrap();
    let snapshot = sqlite_adapter::inspect_schema(&mut reader, Uuid::new_v4(), "module.db")
        .await
        .unwrap();
    let table = snapshot.schemas[0]
        .tables
        .iter()
        .find(|t| t.key.name == "external")
        .unwrap();
    assert!(table.sqlite.as_ref().unwrap().columns_unavailable);
    assert!(table.sqlite.as_ref().unwrap().definition.contains("zzzz"));
    assert!(!table.sqlite.as_ref().unwrap().diagnostics.is_empty());
    assert!(
        snapshot.schemas[0]
            .tables
            .iter()
            .any(|t| t.key.name == "ordinary")
    );
    reader.close().await.unwrap();
}

#[tokio::test]
async fn references_use_catalog_spelling_and_view_trigger_identity() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("references.db");
    let mut writer = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true),
    )
    .await
    .unwrap();
    writer.execute("CREATE TABLE Parents(ParentID INTEGER PRIMARY KEY); CREATE TABLE Children(childID INTEGER CONSTRAINT child_parent REFERENCES parents(parentid) DEFERRABLE INITIALLY DEFERRED); CREATE VIEW Visible AS SELECT * FROM Children; CREATE TRIGGER forward INSTEAD OF INSERT ON Visible BEGIN SELECT 1; END;").await.unwrap();
    writer.close().await.unwrap();
    let mut reader = sqlite_adapter::connect(&path).await.unwrap();
    let snapshot = sqlite_adapter::inspect_schema(&mut reader, Uuid::new_v4(), "references.db")
        .await
        .unwrap();
    let schema = &snapshot.schemas[0];
    let child = schema
        .tables
        .iter()
        .find(|t| t.key.name == "Children")
        .unwrap();
    let fk = &child.foreign_keys[0];
    assert_eq!(fk.referenced_table, "Parents");
    assert_eq!(fk.referenced_columns, ["ParentID"]);
    assert_eq!(fk.name, "child_parent");
    assert!(fk.deferrable && fk.initially_deferred);
    assert_eq!(
        schema.programs[0].table.as_ref().unwrap().kind,
        schema_model::ObjectKind::View
    );
    assert_eq!(
        schema.dependencies[0].target.kind,
        schema_model::ObjectKind::View
    );
    reader.close().await.unwrap();
}

#[tokio::test]
async fn catalog_budget_counts_utf8_bytes_not_characters() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("large.db");
    let mut writer = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true),
    )
    .await
    .unwrap();
    let ddl = format!(
        "CREATE VIEW large AS SELECT '{}' AS body",
        "汉".repeat(6 * 1024 * 1024)
    );
    writer.execute(sqlx::AssertSqlSafe(ddl)).await.unwrap();
    writer.close().await.unwrap();
    let mut reader = sqlite_adapter::connect(&path).await.unwrap();
    assert!(matches!(
        sqlite_adapter::inspect_schema(&mut reader, Uuid::new_v4(), "large.db").await,
        Err(sqlite_adapter::SqliteError::Limit)
    ));
    reader.close().await.unwrap();
}
