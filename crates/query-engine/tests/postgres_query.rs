use std::time::Duration;

use query_engine::{
    DEFAULT_CELL_BYTES, DEFAULT_RESULT_BYTES, ExecuteQueryRequest, QueryCell, QueryError,
    execute_postgres_query,
};
use sqlx::PgPool;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

fn request(sql: &str, row_limit: u32, timeout_ms: u64) -> ExecuteQueryRequest {
    ExecuteQueryRequest {
        query_id: Uuid::new_v4(),
        sql: sql.into(),
        row_limit,
        timeout_ms,
        max_cell_bytes: DEFAULT_CELL_BYTES,
        max_result_bytes: DEFAULT_RESULT_BYTES,
    }
}

/// Set `SQLAI_QUERY_TEST_DATABASE_URL` to a disposable `PostgreSQL` database to run
/// this fixture test locally and in CI. It never creates or mutates database objects.
#[tokio::test]
async fn postgres_read_only_fixture_covers_types_limits_timeout_and_cancel() {
    let Ok(database_url) = std::env::var("SQLAI_QUERY_TEST_DATABASE_URL") else {
        eprintln!("skipping PostgreSQL fixture: SQLAI_QUERY_TEST_DATABASE_URL is not set");
        return;
    };
    let pool = PgPool::connect(&database_url)
        .await
        .expect("connect to disposable PostgreSQL fixture");

    let typed = execute_postgres_query(
        &pool,
        &request(
            "SELECT NULL::text AS nothing, 9223372036854775807::int8 AS large, 1234567890.123456789::numeric AS precise, '{\"ok\":true}'::jsonb AS payload, gen_random_uuid() AS identifier, now() AS captured_at",
            100,
            5_000,
        ),
        &CancellationToken::new(),
    )
    .await
    .expect("read typed values");
    assert_eq!(typed.columns.len(), 6);
    assert!(matches!(typed.rows[0][0], QueryCell::Null));
    assert!(
        matches!(&typed.rows[0][1], QueryCell::Text { value, .. } if value == "9223372036854775807")
    );
    assert!(
        matches!(&typed.rows[0][2], QueryCell::Text { value, .. } if value == "1234567890.123456789")
    );
    assert!(matches!(typed.rows[0][3], QueryCell::Json { .. }));

    let limited = execute_postgres_query(
        &pool,
        &request("SELECT value FROM generate_series(1, 4) AS value", 2, 5_000),
        &CancellationToken::new(),
    )
    .await
    .expect("bounded result");
    assert_eq!(limited.row_count, 2);
    assert!(limited.truncated);

    let timed_out = execute_postgres_query(
        &pool,
        &request("SELECT pg_sleep(1)", 1, 50),
        &CancellationToken::new(),
    )
    .await;
    assert!(matches!(timed_out, Err(QueryError::Timeout)));

    let cancellation = CancellationToken::new();
    let cancel_signal = cancellation.clone();
    let cancel_pool = pool.clone();
    let running = tokio::spawn(async move {
        execute_postgres_query(
            &cancel_pool,
            &request("SELECT pg_sleep(5)", 1, 5_000),
            &cancellation,
        )
        .await
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    cancel_signal.cancel();
    assert!(matches!(
        running.await.expect("query task"),
        Err(QueryError::Cancelled)
    ));

    let empty = execute_postgres_query(
        &pool,
        &request("SELECT 1::int4 AS id WHERE false", 100, 5_000),
        &CancellationToken::new(),
    )
    .await
    .expect("empty result metadata");
    assert_eq!(empty.row_count, 0);
    assert_eq!(empty.columns[0].name, "id");

    pool.close().await;
}
