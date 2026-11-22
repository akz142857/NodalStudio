use mysql_adapter::MySqlConnectionOptions;
use postgres_adapter::PostgresConnectionOptions;
use query_engine::schema_ddl::{DdlError, execute_mysql_ddl, execute_postgres_ddl};
use schema_model::DatabaseSnapshot;
use uuid::Uuid;

const SETUP: [&str; 4] = [
    "CREATE TABLE ddl_parent (id BIGINT PRIMARY KEY);",
    "CREATE TABLE ddl_child (id BIGINT PRIMARY KEY, parent_id BIGINT, label VARCHAR(80));",
    "ALTER TABLE ddl_child ADD CONSTRAINT ddl_parent_fk FOREIGN KEY (parent_id) REFERENCES ddl_parent (id);",
    "CREATE INDEX ddl_label_idx ON ddl_child (label);",
];
const SEED: &str = "INSERT INTO ddl_child (id, label) VALUES (1, 'duplicate'), (2, 'duplicate')";
const INVALID_FK: &str = "INSERT INTO ddl_child (id, parent_id) VALUES (3, 999)";
const INVALID_INDEX: &str = "CREATE UNIQUE INDEX ddl_duplicate_idx ON ddl_child (label)";

fn verify_fixture(snapshot: &DatabaseSnapshot) {
    assert!(
        snapshot.database.name.starts_with("nodal_ddl_qa_"),
        "use a disposable DDL database"
    );
    assert!(
        snapshot
            .schemas
            .iter()
            .flat_map(|schema| &schema.tables)
            .all(|table| !matches!(table.key.name.as_str(), "ddl_parent" | "ddl_child"))
    );
}

fn verify_schema(snapshot: &DatabaseSnapshot) {
    let child = snapshot
        .schemas
        .iter()
        .flat_map(|schema| &schema.tables)
        .find(|table| table.key.name == "ddl_child")
        .expect("refreshed child table");
    assert!(
        child
            .foreign_keys
            .iter()
            .any(|fk| fk.name == "ddl_parent_fk" && fk.referenced_table == "ddl_parent")
    );
    assert!(
        child
            .indexes
            .iter()
            .any(|index| index.name == "ddl_label_idx" && index.columns == ["label"])
    );
    assert!(
        child
            .indexes
            .iter()
            .all(|index| index.name != "ddl_duplicate_idx")
    );
}

#[tokio::test]
#[ignore = "requires NODAL_MYSQL_DDL_TEST_URL pointing at a disposable nodal_ddl_qa_* database"]
async fn mysql_applies_ddl_and_refreshes_schema() {
    let url = std::env::var("NODAL_MYSQL_DDL_TEST_URL").expect("disposable MySQL fixture URL");
    let pool = mysql_adapter::connect(&MySqlConnectionOptions::new(url))
        .await
        .unwrap();
    let source = Uuid::new_v4();
    let initial = mysql_adapter::inspect_schema(&pool, source).await.unwrap();
    verify_fixture(&initial);
    let database = &initial.database.name;
    for sql in SETUP {
        execute_mysql_ddl(&pool, database, sql)
            .await
            .unwrap_or_else(|error| panic!("{sql}: {error}"));
    }
    sqlx::query(SEED).execute(&pool).await.unwrap();
    assert!(
        sqlx::query(INVALID_FK)
            .execute(&pool)
            .await
            .unwrap_err()
            .as_database_error()
            .is_some()
    );
    assert!(matches!(
        execute_mysql_ddl(&pool, database, INVALID_INDEX).await,
        Err(DdlError::Database(_))
    ));
    verify_schema(&mysql_adapter::inspect_schema(&pool, source).await.unwrap());
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM ddl_child")
            .fetch_one(&pool)
            .await
            .unwrap(),
        2
    );
    for sql in [
        "DROP INDEX ddl_label_idx ON ddl_child",
        "DROP TABLE ddl_child",
        "DROP TABLE ddl_parent",
    ] {
        execute_mysql_ddl(&pool, database, sql)
            .await
            .unwrap_or_else(|error| panic!("{sql}: {error}"));
    }
    verify_fixture(&mysql_adapter::inspect_schema(&pool, source).await.unwrap());
    pool.close().await;
}

#[tokio::test]
#[ignore = "requires NODAL_PG_DDL_TEST_URL pointing at a disposable nodal_ddl_qa_* database"]
async fn postgres_applies_ddl_and_refreshes_schema() {
    let url = std::env::var("NODAL_PG_DDL_TEST_URL").expect("disposable PostgreSQL fixture URL");
    let pool = postgres_adapter::connect(&PostgresConnectionOptions::new(url))
        .await
        .unwrap();
    let source = Uuid::new_v4();
    verify_fixture(
        &postgres_adapter::inspect_schema(&pool, source)
            .await
            .unwrap(),
    );
    for sql in SETUP {
        execute_postgres_ddl(&pool, sql)
            .await
            .unwrap_or_else(|error| panic!("{sql}: {error}"));
    }
    sqlx::query(SEED).execute(&pool).await.unwrap();
    assert!(
        sqlx::query(INVALID_FK)
            .execute(&pool)
            .await
            .unwrap_err()
            .as_database_error()
            .is_some()
    );
    assert!(matches!(
        execute_postgres_ddl(&pool, INVALID_INDEX).await,
        Err(DdlError::Database(_))
    ));
    verify_schema(
        &postgres_adapter::inspect_schema(&pool, source)
            .await
            .unwrap(),
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM ddl_child")
            .fetch_one(&pool)
            .await
            .unwrap(),
        2
    );
    for sql in [
        "DROP INDEX ddl_label_idx",
        "DROP TABLE ddl_child",
        "DROP TABLE ddl_parent",
    ] {
        execute_postgres_ddl(&pool, sql)
            .await
            .unwrap_or_else(|error| panic!("{sql}: {error}"));
    }
    verify_fixture(
        &postgres_adapter::inspect_schema(&pool, source)
            .await
            .unwrap(),
    );
    pool.close().await;
}
