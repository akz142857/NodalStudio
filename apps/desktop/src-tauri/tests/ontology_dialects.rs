//! `SQLite` runs on a temporary file. `MySQL` requires `NODAL_ONTOLOGY_MYSQL_URL`
//! pointing to a disposable local `MySQL` 8 database.

use std::path::PathBuf;

use chrono::{DateTime, Duration, FixedOffset, Utc};
use query_engine::{ExecuteQueryRequest, QueryCell, execute_mysql_query, execute_sqlite_query};
use schema_model::{DatabaseSnapshot, ObjectKey};
use semantic_model::ontology::{
    BusinessTimeZone, OrderObject, PaidOrdersDefinition, PaidOrdersSample, PaymentObject,
    PaymentTimeStorage,
};
use serde_json::{Value, json};
use snapshot_store::{
    LocalSnapshotStore,
    change_review::{ReviewRequest, ReviewWorkspace, ontology::VerifyOntologyReviewInput},
    ontology::{
        ConfirmOntologyInput, DefinitionRevision, DraftOntologyInput, OntologyScope,
        SaveOntologySampleInput,
    },
};
use sqlx::{
    AssertSqlSafe, Connection, MySqlPool, SqliteConnection, mysql::MySqlPoolOptions,
    sqlite::SqliteConnectOptions,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const LARGE_ID: i64 = 9_007_199_254_740_993;
const SUCCESS: &str = "paid'\\确认";
const BASIS: &str = "Confirmed the payment-event column against the approved order set.";

enum Engine {
    Mysql(MySqlPool),
    Sqlite(PathBuf),
}

#[tokio::test]
async fn sqlite_closes_review_only_when_the_exact_order_set_matches() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("orders.sqlite");
    write_sqlite(&path).await.close().await.unwrap();
    verify_rename(Engine::Sqlite(path)).await;
}

#[tokio::test]
async fn sqlite_checks_storage_classes_and_uses_the_primary_key_collation() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("text-orders.sqlite");
    write_sqlite(&path).await.close().await.unwrap();
    let engine = Engine::Sqlite(path);
    engine
        .write(
            "CREATE TABLE orders (id TEXT COLLATE NOCASE, PRIMARY KEY (id COLLATE BINARY));
         CREATE TABLE payments (order_id TEXT, status TEXT, paid_at TEXT);
         INSERT INTO orders VALUES ('A'), ('a');
         INSERT INTO payments VALUES ('a', 'paid', '2026-10-04T06:00:00Z');"
                .into(),
        )
        .await;
    let source = Uuid::new_v4();
    let snapshot = engine.snapshot(source).await;
    let mut definition = fixture_definition(
        "main",
        "orders".into(),
        "payments".into(),
        Some(PaymentTimeStorage::Iso8601),
    );
    definition.payment.success_value = "paid".into();
    let sample = PaidOrdersSample {
        month: "2026-10".into(),
        expected_order_ids: vec!["a".into()],
    };
    let sql = definition.sample_sql(&snapshot, &sample).unwrap();
    assert_eq!(order_ids(engine.read(sql.clone()).await), ["a"]);

    // A BLOB and text with the same bytes are separate SQLite keys.
    engine
        .write(
            "INSERT INTO orders VALUES (X'61');
         INSERT INTO payments VALUES (X'61', 'paid', '2026-10-04T06:00:00Z');"
                .into(),
        )
        .await;
    assert_eq!(engine.read(sql.clone()).await, vec![vec![QueryCell::Null]]);
    engine
        .write(
            "DELETE FROM payments WHERE typeof(order_id) = 'blob';
         UPDATE payments SET paid_at = paid_at || char(0) || 'invalid';"
                .into(),
        )
        .await;
    assert_eq!(engine.read(sql).await, vec![vec![QueryCell::Null]]);

    let store = LocalSnapshotStore::open_path(&directory.path().join("snapshot.sqlite"))
        .await
        .unwrap();
    store.save_captured_snapshot(&snapshot).await.unwrap();
    let confirmed = store
        .confirm_ontology(ConfirmOntologyInput {
            scope: scope(&snapshot),
            target: None,
            definition: definition.clone(),
        })
        .await
        .unwrap();
    engine
        .write(
            "DROP TABLE orders;
         CREATE TABLE orders (id TEXT PRIMARY KEY COLLATE NOCASE);
         INSERT INTO orders VALUES ('A');
         UPDATE payments SET paid_at = '2026-10-04T06:00:00Z';"
                .into(),
        )
        .await;
    let captured = engine.snapshot(source).await;
    store.save_captured_snapshot(&captured).await.unwrap();
    let entries = store.list_ontology(&scope(&captured)).await.unwrap();
    assert_eq!(entries[0].id, confirmed.id);
    assert_eq!(entries[0].impacts.len(), 1);
    assert_eq!(
        entries[0].impacts[0].reason,
        semantic_model::ontology::ImpactReason::ChangedOrderKey
    );
    assert_eq!(
        order_ids(
            engine
                .read(definition.sample_sql(&captured, &sample).unwrap())
                .await
        ),
        ["A"]
    );
}

#[tokio::test]
#[ignore = "requires a disposable local MySQL 8 database"]
async fn mysql_closes_review_only_when_the_exact_order_set_matches() {
    let url = std::env::var("NODAL_ONTOLOGY_MYSQL_URL").expect("set the local MySQL fixture URL");
    let pool = MySqlPoolOptions::new()
        .after_connect(|connection, _| {
            Box::pin(async move {
                sqlx::query(
                    "SET SESSION time_zone = '-05:00', optimizer_switch = 'derived_merge=off'",
                )
                .execute(connection)
                .await?;
                Ok(())
            })
        })
        .connect(&url)
        .await
        .unwrap();
    verify_rename(Engine::Mysql(pool)).await;
}

async fn write_sqlite(path: &std::path::Path) -> SqliteConnection {
    SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true),
    )
    .await
    .unwrap()
}

impl Engine {
    async fn write(&self, sql: String) {
        let query = sqlx::raw_sql(AssertSqlSafe(sql));
        match self {
            Self::Mysql(pool) => {
                query.execute(pool).await.unwrap();
            }
            Self::Sqlite(path) => {
                query.execute(&mut write_sqlite(path).await).await.unwrap();
            }
        }
    }

    async fn snapshot(&self, source: Uuid) -> DatabaseSnapshot {
        match self {
            Self::Mysql(pool) => mysql_adapter::inspect_schema(pool, source).await.unwrap(),
            Self::Sqlite(path) => sqlite_adapter::inspect_schema(
                &mut sqlite_adapter::connect(path).await.unwrap(),
                source,
                "orders",
            )
            .await
            .unwrap(),
        }
    }

    async fn read(&self, sql: String) -> Vec<Vec<QueryCell>> {
        let request = ExecuteQueryRequest {
            query_id: Uuid::new_v4(),
            sql,
            row_limit: 200,
            timeout_ms: 10_000,
            max_cell_bytes: query_engine::DEFAULT_CELL_BYTES,
            max_result_bytes: query_engine::DEFAULT_RESULT_BYTES,
        };
        let token = CancellationToken::new();
        let result = match self {
            Self::Mysql(pool) => execute_mysql_query(pool, &request, &token).await,
            Self::Sqlite(path) => {
                execute_sqlite_query(
                    &mut sqlite_adapter::connect(path).await.unwrap(),
                    &request,
                    &token,
                )
                .await
            }
        }
        .unwrap_or_else(|error| panic!("{error}\n{}", request.sql));
        assert!(!result.truncated);
        result.rows
    }

    async fn seed(&self, payments: &str, start: DateTime<Utc>, end: DateTime<Utc>) {
        let data = [
            (
                1,
                SUCCESS,
                start + Duration::days(3),
                start + Duration::days(3),
            ),
            (
                1,
                SUCCESS,
                start + Duration::days(4),
                start + Duration::days(4),
            ),
            (
                2,
                SUCCESS,
                start - Duration::nanoseconds(1),
                start + Duration::days(5),
            ),
            (
                2,
                SUCCESS,
                start + Duration::days(6),
                start + Duration::days(6),
            ),
            (3, "PAID'\\确认", start, start),
            (4, SUCCESS, start, start),
            (5, SUCCESS, end, end),
            (LARGE_ID, SUCCESS, end - Duration::nanoseconds(1), end),
        ];
        let singapore = FixedOffset::east_opt(8 * 3600).unwrap();
        let mysql_session = FixedOffset::west_opt(5 * 3600).unwrap();
        for (id, status, paid_at, settled_at) in data {
            let sql = format!(
                "INSERT INTO {payments} (order_id,status,paid_at,settled_at,local_time,unix_ms) VALUES (?,?,?,?,?,?)"
            );
            match self {
                Self::Mysql(pool) => {
                    let wall_time = |instant: DateTime<Utc>, offset: FixedOffset| {
                        instant
                            .with_timezone(&offset)
                            .format("%Y-%m-%d %H:%M:%S%.6f")
                            .to_string()
                    };
                    sqlx::query(AssertSqlSafe(sql))
                        .bind(id)
                        .bind(status)
                        .bind(wall_time(paid_at, mysql_session))
                        .bind(wall_time(settled_at, mysql_session))
                        .bind(wall_time(paid_at, singapore))
                        .bind(paid_at.timestamp_millis())
                        .execute(pool)
                        .await
                        .unwrap();
                }
                Self::Sqlite(path) => {
                    let mut connection = write_sqlite(path).await;
                    sqlx::query(AssertSqlSafe(sql))
                        .bind(id)
                        .bind(status)
                        .bind(paid_at.with_timezone(&singapore).to_rfc3339())
                        .bind(
                            settled_at
                                .naive_utc()
                                .format("%Y-%m-%d %H:%M:%S%.9f")
                                .to_string(),
                        )
                        .bind(paid_at.timestamp())
                        .bind(paid_at.timestamp_millis())
                        .execute(&mut connection)
                        .await
                        .unwrap();
                }
            }
        }
    }
}

fn expected_ids() -> Vec<String> {
    ["1", "4", "9007199254740993"].map(str::to_owned).to_vec()
}

async fn create_fixture(engine: &Engine, source: Uuid) -> (DatabaseSnapshot, PaidOrdersDefinition) {
    let suffix = source.simple();
    let orders = format!("orders_{suffix}");
    let payments = format!("payments_{suffix}");
    let (key_type, status_type, time_type, local_type, time_storage) = match engine {
        Engine::Mysql(_) => (
            "BIGINT",
            "VARCHAR(100)",
            "TIMESTAMP(6) NULL",
            "DATETIME(6)",
            None,
        ),
        Engine::Sqlite(_) => (
            "INTEGER",
            "TEXT",
            "TEXT",
            "INTEGER",
            Some(PaymentTimeStorage::Iso8601),
        ),
    };
    engine
        .write(format!(
            "CREATE TABLE {orders} (id {key_type} PRIMARY KEY);
         CREATE TABLE {payments} (order_id {key_type}, status {status_type}, paid_at {time_type},
             settled_at {time_type}, local_time {local_type}, unix_ms {key_type});
         INSERT INTO {orders} VALUES (1),(2),(3),(4),(5),({LARGE_ID});"
        ))
        .await;

    let initial = engine.snapshot(source).await;
    let definition = fixture_definition(&initial.schemas[0].name, orders, payments, time_storage);
    (initial, definition)
}

fn fixture_definition(
    schema: &str,
    orders: String,
    payments: String,
    time_storage: Option<PaymentTimeStorage>,
) -> PaidOrdersDefinition {
    PaidOrdersDefinition {
        name: "Paid orders".into(),
        order: OrderObject {
            name: "Order".into(),
            table: ObjectKey::table(schema, orders),
            id_column: "id".into(),
        },
        payment: PaymentObject {
            name: "Payment".into(),
            table: ObjectKey::table(schema, payments),
            order_id_column: "order_id".into(),
            status_column: "status".into(),
            success_value: SUCCESS.into(),
            paid_at_column: "paid_at".into(),
            time_storage,
        },
        time_zone: BusinessTimeZone::Singapore,
    }
}

async fn verify_rename(engine: Engine) {
    let directory = tempfile::tempdir().unwrap();
    let store = LocalSnapshotStore::open_path(&directory.path().join("snapshots.sqlite"))
        .await
        .unwrap();
    let source = Uuid::new_v4();
    let (initial, definition) = create_fixture(&engine, source).await;
    let orders = &definition.order.table.name;
    let payments = &definition.payment.table.name;
    store.save_captured_snapshot(&initial).await.unwrap();
    let saved = store
        .confirm_ontology(ConfirmOntologyInput {
            scope: scope(&initial),
            target: None,
            definition: definition.clone(),
        })
        .await
        .unwrap();
    let target = |revision| DefinitionRevision {
        id: saved.id,
        revision,
    };
    let draft = |snapshot: &DatabaseSnapshot, revision| DraftOntologyInput {
        scope: scope(snapshot),
        target: target(revision),
    };
    let before = store
        .draft_ontology_last_month(&draft(&initial, 1))
        .await
        .unwrap();
    engine
        .seed(
            payments,
            before.starts_at.parse().unwrap(),
            before.ends_before.parse().unwrap(),
        )
        .await;
    let rows = engine.read(before.sql).await;
    assert_eq!(rows.len(), 3);
    assert!(
        matches!(&rows[1][1], QueryCell::Text { value, .. } if value.starts_with(&before.starts_at.parse::<DateTime<Utc>>().unwrap().format("%Y-%m-%dT%H:%M:%S").to_string()))
    );

    let sample = PaidOrdersSample {
        month: before.starts_at[..7].into(),
        expected_order_ids: expected_ids(),
    };
    exercise_time_encodings(&engine, &initial, &definition, &sample, payments).await;
    store
        .save_ontology_sample(SaveOntologySampleInput {
            scope: scope(&initial),
            target: target(1),
            sample,
        })
        .await
        .unwrap();
    let review = store.change_review(source).await.unwrap();
    store
        .apply_change_review(&decision(&review, "start", None, None))
        .await
        .unwrap();

    engine
        .write(format!(
            "ALTER TABLE {payments} RENAME COLUMN paid_at TO completed_at"
        ))
        .await;
    let renamed = engine.snapshot(source).await;
    assert!(
        store
            .save_captured_snapshot(&renamed)
            .await
            .unwrap()
            .change_set
            .is_some()
    );
    let review = store.change_review(source).await.unwrap();
    let key = format!("ontology:{}", saved.id);
    assert!(review.items.iter().any(|item| item.key == key));
    assert!(
        store
            .draft_ontology_last_month(&draft(&renamed, 1))
            .await
            .is_err()
    );
    verify_review_decisions(&store, &engine, &review, &key, &definition).await;
    let after = store
        .draft_ontology_last_month(&draft(&renamed, 2))
        .await
        .unwrap();
    assert_eq!(engine.read(after.sql).await, rows);
    engine
        .write(format!("DROP TABLE {payments}; DROP TABLE {orders};"))
        .await;
}

async fn verify_review_decisions(
    store: &LocalSnapshotStore,
    engine: &Engine,
    review: &ReviewWorkspace,
    key: &str,
    definition: &PaidOrdersDefinition,
) {
    let prepared = prepare_check(store, review, key, definition, "completed_at").await;
    let mut duplicated_ids = expected_ids();
    duplicated_ids.push(duplicated_ids[0].clone());
    let duplicate = store
        .record_ontology_check(prepared, Ok(duplicated_ids))
        .await
        .unwrap();
    let duplicate_proof = evidence(&duplicate, key);
    assert_eq!(duplicate_proof["passed"], false);
    assert_eq!(
        duplicate_proof["error"],
        "The result contains duplicate order IDs."
    );

    let wrong = check(store, engine, &duplicate, key, definition, "settled_at").await;
    let proof = evidence(&wrong, key);
    assert_eq!(proof["actualOrderIds"], json!(["1", "2", "4"]));
    assert_eq!(proof["expectedOrderIds"], json!(expected_ids()));
    assert_eq!(proof["missingOrderIds"], json!(["9007199254740993"]));
    assert_eq!(proof["unexpectedOrderIds"], json!(["2"]));
    assert_eq!(proof["passed"], false);
    assert!(
        store
            .apply_change_review(&decision(
                &wrong,
                "confirmOntology",
                Some(key),
                proof["id"].as_str()
            ))
            .await
            .is_err()
    );

    let correct = check(store, engine, &wrong, key, definition, "completed_at").await;
    let proof = evidence(&correct, key);
    assert_eq!(proof["actualOrderIds"], json!(expected_ids()));
    assert_eq!(proof["passed"], true);
    let closed = store
        .apply_change_review(&decision(
            &correct,
            "confirmOntology",
            Some(key),
            proof["id"].as_str(),
        ))
        .await
        .unwrap();
    assert!(closed.items.iter().all(|item| item.key != key));
    assert_eq!(closed.events.last().unwrap().text, BASIS);
}

async fn exercise_time_encodings(
    engine: &Engine,
    snapshot: &DatabaseSnapshot,
    definition: &PaidOrdersDefinition,
    sample: &PaidOrdersSample,
    payments: &str,
) {
    let modes = match engine {
        Engine::Mysql(_) => {
            let mut legacy = snapshot.clone();
            legacy.database.version = "5.7.44-log".into();
            assert_eq!(
                definition.sample_sql(&legacy, sample),
                Err("Ontology requires MySQL 8.0 or later.")
            );
            vec![("local_time", PaymentTimeStorage::SingaporeDateTime)]
        }
        Engine::Sqlite(_) => vec![
            ("local_time", PaymentTimeStorage::UnixSeconds),
            ("unix_ms", PaymentTimeStorage::UnixMilliseconds),
        ],
    };
    for (name, storage) in modes {
        let mut alternative = definition.clone();
        alternative.payment.paid_at_column = name.into();
        assert!(alternative.sample_sql(snapshot, sample).is_err());
        alternative.payment.time_storage = Some(storage);
        assert_eq!(
            order_ids(
                engine
                    .read(alternative.sample_sql(snapshot, sample).unwrap())
                    .await
            ),
            expected_ids()
        );
    }
    if matches!(engine, Engine::Sqlite(_)) {
        let sql = definition.sample_sql(snapshot, sample).unwrap();
        engine
            .write(format!(
                "UPDATE {payments} SET paid_at = 'now' WHERE order_id = 5"
            ))
            .await;
        assert_eq!(engine.read(sql).await, vec![vec![QueryCell::Null]]);
        engine
            .write(format!(
                "UPDATE {payments} SET paid_at = settled_at WHERE order_id = 5"
            ))
            .await;
    }
}

fn scope(snapshot: &DatabaseSnapshot) -> OntologyScope {
    OntologyScope {
        source_id: snapshot.source_id,
        snapshot_id: snapshot.id,
    }
}

fn decision(
    review: &ReviewWorkspace,
    action: &str,
    key: Option<&str>,
    proof: Option<&str>,
) -> ReviewRequest {
    ReviewRequest {
        source_id: review.source_id,
        revision: review.revision.clone(),
        prepared_at: Utc::now().to_rfc3339(),
        operation_id: Uuid::new_v4(),
        action: action.into(),
        item_key: key.map(str::to_owned),
        item_keys: Vec::new(),
        text: proof.map(str::to_owned),
    }
}

fn evidence<'a>(review: &'a ReviewWorkspace, key: &str) -> &'a Value {
    &review
        .items
        .iter()
        .find(|item| item.key == key)
        .unwrap()
        .after["verification"]
}

fn order_ids(rows: Vec<Vec<QueryCell>>) -> Vec<String> {
    rows.into_iter()
        .map(|mut row| match row.pop() {
            Some(QueryCell::Text {
                value,
                truncated: false,
            }) if row.is_empty() => value,
            _ => panic!("Expected an exact order ID, got {row:?}"),
        })
        .collect()
}

async fn check(
    store: &LocalSnapshotStore,
    engine: &Engine,
    review: &ReviewWorkspace,
    key: &str,
    original: &PaidOrdersDefinition,
    field: &str,
) -> ReviewWorkspace {
    let prepared = prepare_check(store, review, key, original, field).await;
    let ids = order_ids(engine.read(prepared.sql.clone()).await);
    store
        .record_ontology_check(prepared, Ok(ids))
        .await
        .unwrap()
}

async fn prepare_check(
    store: &LocalSnapshotStore,
    review: &ReviewWorkspace,
    key: &str,
    original: &PaidOrdersDefinition,
    field: &str,
) -> snapshot_store::change_review::ontology::PreparedOntologyCheck {
    let mut definition = original.clone();
    definition.payment.paid_at_column = field.into();
    store
        .prepare_ontology_check(VerifyOntologyReviewInput {
            source_id: review.source_id,
            revision: review.revision.clone(),
            item_key: key.into(),
            definition,
            basis: BASIS.into(),
        })
        .await
        .unwrap()
}
