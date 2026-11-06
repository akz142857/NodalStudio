use query_engine::{
    ExecuteQueryRequest, QueryCell, QueryError, execute_sqlite_query, validate_read_only_sqlite,
};
use sqlx::{Connection, Executor, SqliteConnection, sqlite::SqliteConnectOptions};
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;
fn request(sql: &str) -> ExecuteQueryRequest {
    ExecuteQueryRequest {
        query_id: Uuid::new_v4(),
        sql: sql.into(),
        row_limit: 100,
        timeout_ms: 1000,
        max_cell_bytes: 1024,
        max_result_bytes: 1024 * 1024,
    }
}
#[tokio::test]
async fn readonly_wal_mixed_values_and_limits() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("数据库 ?#.db");
    let mut writer = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true),
    )
    .await
    .unwrap();
    writer.execute("PRAGMA journal_mode=WAL; CREATE TABLE sample(v); INSERT INTO sample VALUES(9223372036854775807),('text'),(NULL),(x'00ff'),(1.25)").await.unwrap();
    let mut reader = sqlite_adapter::connect(&path).await.unwrap();
    let result = execute_sqlite_query(
        &mut reader,
        &request("SELECT v FROM sample"),
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    assert!(matches!(&result.rows[0][0],QueryCell::Text{value,..} if value=="9223372036854775807"));
    assert!(matches!(&result.rows[1][0],QueryCell::Text{value,..} if value=="text"));
    assert_eq!(result.rows[2][0], QueryCell::Null);
    assert_eq!(result.rows[3][0], QueryCell::Binary { byte_length: 2 });
    assert_eq!(result.rows[4][0], QueryCell::Number { value: 1.25 });
    assert!(
        reader
            .execute("INSERT INTO sample VALUES(1)")
            .await
            .is_err()
    );
    let values_cte = execute_sqlite_query(
        &mut reader,
        &request("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<5) SELECT sum(x) FROM n"),
        &CancellationToken::new(),
    ).await.unwrap();
    assert!(matches!(&values_cte.rows[0][0], QueryCell::Text { value, .. } if value == "15"));
    let mut limited = request("SELECT v FROM sample");
    limited.row_limit = 2;
    assert!(
        execute_sqlite_query(&mut reader, &limited, &CancellationToken::new())
            .await
            .unwrap()
            .truncated
    );
    let empty = execute_sqlite_query(
        &mut reader,
        &request("SELECT v AS same, v AS same FROM sample WHERE 0"),
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    assert!(empty.rows.is_empty());
    assert_eq!(empty.columns[0].database_type, "DYNAMIC");
    assert_eq!(
        empty
            .columns
            .iter()
            .map(|column| column.name.as_str())
            .collect::<Vec<_>>(),
        ["same", "same"]
    );
    let mut text_limit = request("SELECT printf('%.*c', 2048, 'x')");
    text_limit.max_cell_bytes = 1024;
    let truncated = execute_sqlite_query(&mut reader, &text_limit, &CancellationToken::new())
        .await
        .unwrap();
    assert!(matches!(
        &truncated.rows[0][0],
        QueryCell::Text {
            truncated: true,
            ..
        }
    ));
    text_limit.max_result_bytes = 1024;
    assert!(matches!(
        execute_sqlite_query(&mut reader, &text_limit, &CancellationToken::new()).await,
        Err(QueryError::ResultLimit)
    ));
    let mut integer_limit = request(
        "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<100) SELECT 9223372036854775807 FROM n",
    );
    integer_limit.max_result_bytes = 1024;
    assert!(matches!(
        execute_sqlite_query(&mut reader, &integer_limit, &CancellationToken::new()).await,
        Err(QueryError::ResultLimit)
    ));
    reader.close().await.unwrap();
    writer.close().await.unwrap();
}
#[tokio::test]
async fn cancellation_and_deadline_interrupt_engine_and_release_worker() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("test.db");
    SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true),
    )
    .await
    .unwrap()
    .close()
    .await
    .unwrap();
    let mut connection = sqlite_adapter::connect(&path).await.unwrap();
    let sql = "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT sum(x) FROM n";
    let token = CancellationToken::new();
    let child = token.clone();
    let cancel = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(50)).await;
        child.cancel();
    });
    let started = Instant::now();
    assert!(matches!(
        execute_sqlite_query(&mut connection, &request(sql), &token).await,
        Err(QueryError::Cancelled)
    ));
    cancel.await.unwrap();
    assert!(started.elapsed() < Duration::from_secs(2));
    let mut timed = request(sql);
    timed.timeout_ms = 30;
    assert!(matches!(
        execute_sqlite_query(&mut connection, &timed, &CancellationToken::new()).await,
        Err(QueryError::Timeout)
    ));
    assert_eq!(
        execute_sqlite_query(
            &mut connection,
            &request("SELECT 1"),
            &CancellationToken::new()
        )
        .await
        .unwrap()
        .row_count,
        1
    );
    connection.close().await.unwrap();
}
#[test]
fn guard_rejects_side_effects_and_handles_quoted_identifiers() {
    for sql in [
        "VALUES(1)",
        "WITH x(v) AS (VALUES(load_extension('x'))) SELECT * FROM x",
        "INSERT INTO t VALUES(1)",
        "SELECT 1; DELETE FROM t",
        "ATTACH DATABASE 'other' AS other",
        "PRAGMA query_only=OFF",
        "VACUUM INTO 'copy'",
        "SELECT load_extension('x')",
        "SELECT \"load_extension\"('x')",
        "SELECT * FROM pragma_table_info('t')",
    ] {
        assert!(validate_read_only_sqlite(sql).is_err(), "{sql}");
    }
    for sql in [
        "SELECT 1",
        "WITH t AS (SELECT 1) SELECT * FROM t",
        "SELECT \"a;b\" FROM \"main\".\"table\"",
        "SELECT sum(x) OVER () FROM t",
    ] {
        assert!(validate_read_only_sqlite(sql).is_ok(), "{sql}");
    }
}
