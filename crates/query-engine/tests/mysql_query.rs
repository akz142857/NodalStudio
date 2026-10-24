use query_engine::{
    DEFAULT_CELL_BYTES, DEFAULT_RESULT_BYTES, ExecuteQueryRequest, QueryCell, QueryError,
    execute_mysql_query,
};
use sqlx::MySqlPool;
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

fn request(sql: &str, rows: u32, timeout: u64) -> ExecuteQueryRequest {
    ExecuteQueryRequest {
        query_id: Uuid::new_v4(),
        sql: sql.into(),
        row_limit: rows,
        timeout_ms: timeout,
        max_cell_bytes: DEFAULT_CELL_BYTES,
        max_result_bytes: DEFAULT_RESULT_BYTES,
    }
}

/// Use only the disposable `MySQL` fixture; this test executes no DDL or DML.
#[tokio::test]
#[allow(
    clippy::too_many_lines,
    reason = "Verify the complete read-only contract against one disposable fixture"
)]
async fn mysql_fixture_types_limits_guard_timeout_and_server_cancellation() {
    let Ok(url) = std::env::var("SQLAI_MYSQL_QUERY_TEST_DATABASE_URL") else {
        eprintln!("skipping MySQL fixture: SQLAI_MYSQL_QUERY_TEST_DATABASE_URL is not set");
        return;
    };
    let pool = MySqlPool::connect(&url).await.unwrap();
    let run = |sql| request(sql, 100, 5_000);
    let result = execute_mysql_query(&pool, &run("SELECT NULL AS nothing, CAST(18446744073709551615 AS UNSIGNED) AS large, CAST(1234567890.123456789 AS DECIMAL(30,9)) AS precise, JSON_OBJECT('id', 18446744073709551615) AS payload, CAST('2026-10-24 12:34:56.123456' AS DATETIME(6)) AS moment, CAST('-123:45:56.123456' AS TIME(6)) AS duration, UNHEX('00FF') AS binary_data, '你好' AS greeting"), &CancellationToken::new()).await.unwrap();
    assert_eq!(result.columns.len(), 8);
    assert_eq!(result.rows[0][0], QueryCell::Null);
    for (index, expected) in [
        (1, "18446744073709551615"),
        (2, "1234567890.123456789"),
        (4, "2026-10-24 12:34:56.123456"),
        (5, "-123:45:56.123456"),
        (7, "你好"),
    ] {
        assert!(
            matches!(&result.rows[0][index], QueryCell::Text { value, truncated: false } if value == expected),
            "cell {index}: {:?}",
            result.rows[0][index]
        );
    }
    assert!(
        matches!(&result.rows[0][3], QueryCell::Json { raw: Some(value), .. } if value.contains("18446744073709551615"))
    );
    assert_eq!(result.rows[0][6], QueryCell::Binary { byte_length: 2 });
    let empty = execute_mysql_query(
        &pool,
        &run("SELECT id FROM `orders` WHERE 1=0"),
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(empty.row_count, 0);
    assert_eq!(empty.columns[0].name, "id");
    let limited = execute_mysql_query(&pool, &request("WITH items AS (SELECT 1 AS id UNION ALL SELECT 2 UNION ALL SELECT 3) SELECT id FROM items", 2, 5_000), &CancellationToken::new()).await.unwrap();
    assert_eq!(limited.row_count, 2);
    assert!(limited.truncated);
    let mut short = run("SELECT '你好世界' AS value");
    short.max_cell_bytes = 5;
    let result = execute_mysql_query(&pool, &short, &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(
        result.rows[0][0],
        QueryCell::Text {
            value: "你".into(),
            truncated: true
        }
    );
    short.max_result_bytes = 3;
    assert!(matches!(
        execute_mysql_query(&pool, &short, &CancellationToken::new()).await,
        Err(QueryError::ResultLimit)
    ));
    for sql in [
        "DELETE FROM orders",
        "SELECT 1 INTO OUTFILE '/tmp/nodalstudio-unsafe'",
        "SELECT * FROM orders FOR UPDATE",
        "SELECT 1; SELECT 2",
    ] {
        assert!(matches!(
            execute_mysql_query(&pool, &run(sql), &CancellationToken::new()).await,
            Err(QueryError::Validation(_))
        ));
    }
    let begin = Instant::now();
    assert!(matches!(
        execute_mysql_query(
            &pool,
            &request("SELECT SLEEP(10) AS nodalstudio_timeout", 1, 100),
            &CancellationToken::new()
        )
        .await,
        Err(QueryError::Timeout)
    ));
    assert!(begin.elapsed() < Duration::from_secs(3));
    wait_for_statement(&pool, "SELECT SLEEP(10) AS nodalstudio_timeout", false).await;
    let token = CancellationToken::new();
    let signal = token.clone();
    let query_pool = pool.clone();
    let task = tokio::spawn(async move {
        execute_mysql_query(
            &query_pool,
            &request("SELECT SLEEP(10) AS nodalstudio_cancel", 1, 20_000),
            &token,
        )
        .await
    });
    wait_for_statement(&pool, "SELECT SLEEP(10) AS nodalstudio_cancel", true).await;
    signal.cancel();
    let result = tokio::time::timeout(Duration::from_secs(3), task)
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(result, Err(QueryError::Cancelled)));
    wait_for_statement(&pool, "SELECT SLEEP(10) AS nodalstudio_cancel", false).await;
    let again = execute_mysql_query(
        &pool,
        &run("SELECT 42 AS answer"),
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(again.row_count, 1);
    pool.close().await;
}

async fn wait_for_statement(pool: &MySqlPool, statement: &str, present: bool) {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM information_schema.processlist WHERE INFO = ?",
        )
        .bind(statement)
        .fetch_one(pool)
        .await
        .unwrap();
        if (count > 0) == present {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "server statement presence did not become {present}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}
