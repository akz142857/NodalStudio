//! Run against a disposable local `PostgreSQL` database with
//! `NODAL_ONTOLOGY_TEST_URL=... cargo test -p nodalstudio-desktop --test ontology_postgres -- --ignored`.

use chrono::{DateTime, Utc};
use postgres_adapter::{PostgresConnectionOptions, connect, inspect_schema};
use query_engine::{ExecuteQueryRequest, QueryCell, execute_postgres_query};
use schema_model::ObjectKey;
use semantic_model::ontology::{
    BusinessTimeZone, OrderObject, PaidOrdersDefinition, PaidOrdersSample, PaymentObject,
};
use serde_json::json;
use snapshot_store::{
    LocalSnapshotStore,
    change_review::{ReviewRequest, ReviewWorkspace, ontology::VerifyOntologyReviewInput},
    ontology::{
        ConfirmOntologyInput, DefinitionRevision, DraftOntologyInput, OntologyScope,
        SaveOntologySampleInput,
    },
};
use sqlx::{AssertSqlSafe, PgPool};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[tokio::test]
#[ignore = "requires a disposable local PostgreSQL database"]
async fn paid_orders_recover_after_a_live_postgres_column_rename() {
    let url = std::env::var("NODAL_ONTOLOGY_TEST_URL").expect("set the local fixture URL");
    let pool = connect(&PostgresConnectionOptions::new(url)).await.unwrap();
    let schema = create_fixture_schema(&pool).await;

    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("store.sqlite");
    let store = LocalSnapshotStore::open_path(&path).await.unwrap();
    let source = Uuid::new_v4();
    let initial = inspect_schema(&pool, source).await.unwrap();
    store.save_captured_snapshot(&initial).await.unwrap();
    let definition = fixture_definition(&schema);
    let saved = store
        .confirm_ontology(ConfirmOntologyInput {
            scope: scope(&initial),
            target: None,
            definition: definition.clone(),
        })
        .await
        .unwrap();
    let before = seed_approved_sample(&store, &pool, &schema, &initial, saved.id).await;
    let renamed = capture_payment_time_rename(&store, &pool, source, &schema).await;
    store.close().await;
    let store = LocalSnapshotStore::open_path(&path).await.unwrap();
    let pending = store.change_review(source).await.unwrap();
    let item_key = format!("ontology:{}", saved.id);
    let wrong = run_check(
        &store,
        &pool,
        &pending,
        &item_key,
        &definition,
        "settled_at",
    )
    .await;
    let failed = evidence(&wrong);
    assert_eq!(failed["expectedOrderIds"], json!(["1", "4", "7"]));
    assert_eq!(failed["actualOrderIds"], json!(["1", "2", "4"]));
    assert_eq!(failed["missingOrderIds"], json!(["7"]));
    assert_eq!(failed["unexpectedOrderIds"], json!(["2"]));
    assert_eq!(failed["passed"], false);
    let close_wrong = decision(
        &wrong,
        "confirmOntology",
        Some(&item_key),
        failed["id"].as_str(),
    );
    assert!(store.apply_change_review(&close_wrong).await.is_err());
    let draft_request = |revision| DraftOntologyInput {
        scope: scope(&renamed),
        target: DefinitionRevision {
            id: saved.id,
            revision,
        },
    };
    assert!(
        store
            .draft_ontology_last_month(&draft_request(1))
            .await
            .is_err()
    );
    println!(
        "wrong binding · three rows vs three rows · missing 7, unexpected 2 · closure rejected"
    );

    let correct = run_check(
        &store,
        &pool,
        &wrong,
        &item_key,
        &definition,
        "completed_at",
    )
    .await;
    let passed = evidence(&correct);
    assert_eq!(passed["actualOrderIds"], failed["expectedOrderIds"]);
    assert_eq!(passed["passed"], true);
    let accepted = decision(
        &correct,
        "confirmOntology",
        Some(&item_key),
        passed["id"].as_str(),
    );
    let finished = store.apply_change_review(&accepted).await.unwrap();
    assert!(finished.items.iter().all(|item| item.key != item_key));
    let event = finished.events.last().unwrap();
    assert_eq!(event.action, "confirmOntology");
    assert_eq!(event.text, "Verified the payment event contract.");
    assert_eq!(event.item.as_ref().unwrap().after["confirmedRevision"], 2);

    let rebound = store
        .draft_ontology_last_month(&draft_request(2))
        .await
        .unwrap();
    assert!(rebound.sql.contains(r#"MIN(p."completed_at")"#));
    assert_eq!(before, execute(&pool, rebound.sql).await);
    println!("correct binding · review closed · revision 2 resumes the matching query");
    sqlx::raw_sql(AssertSqlSafe(format!("DROP SCHEMA {schema} CASCADE")))
        .execute(&pool)
        .await
        .unwrap();
}

async fn capture_payment_time_rename(
    store: &LocalSnapshotStore,
    pool: &PgPool,
    source: Uuid,
    schema: &str,
) -> schema_model::DatabaseSnapshot {
    let initial_round = store.change_review(source).await.unwrap();
    store
        .apply_change_review(&decision(&initial_round, "start", None, None))
        .await
        .unwrap();
    sqlx::raw_sql(AssertSqlSafe(format!(
        "ALTER TABLE {schema}.payments RENAME COLUMN paid_at TO completed_at"
    )))
    .execute(pool)
    .await
    .unwrap();
    let renamed = inspect_schema(pool, source).await.unwrap();
    let capture = store.save_captured_snapshot(&renamed).await.unwrap();
    assert!(capture.change_set.is_some());
    renamed
}

fn scope(snapshot: &schema_model::DatabaseSnapshot) -> OntologyScope {
    OntologyScope {
        source_id: snapshot.source_id,
        snapshot_id: snapshot.id,
    }
}

async fn seed_approved_sample(
    store: &LocalSnapshotStore,
    pool: &PgPool,
    schema: &str,
    snapshot: &schema_model::DatabaseSnapshot,
    id: Uuid,
) -> Vec<Vec<QueryCell>> {
    let target = || DefinitionRevision { id, revision: 1 };
    let draft = store
        .draft_ontology_last_month(&DraftOntologyInput {
            scope: scope(snapshot),
            target: target(),
        })
        .await
        .unwrap();
    seed_payments(pool, schema, &draft.starts_at, &draft.ends_before).await;
    store
        .save_ontology_sample(SaveOntologySampleInput {
            scope: scope(snapshot),
            target: target(),
            sample: PaidOrdersSample {
                month: draft.starts_at[..7].into(),
                expected_order_ids: ["1", "4", "7"].map(str::to_owned).to_vec(),
            },
        })
        .await
        .unwrap();
    let before = execute(pool, draft.sql).await;
    assert_eq!(before.len(), 3);
    before
}

fn decision(
    workspace: &ReviewWorkspace,
    action: &str,
    item: Option<&str>,
    text: Option<&str>,
) -> ReviewRequest {
    ReviewRequest {
        source_id: workspace.source_id,
        revision: workspace.revision.clone(),
        prepared_at: Utc::now().to_rfc3339(),
        operation_id: Uuid::new_v4(),
        action: action.into(),
        item_key: item.map(str::to_owned),
        item_keys: Vec::new(),
        text: text.map(str::to_owned),
    }
}

fn evidence(workspace: &ReviewWorkspace) -> &serde_json::Value {
    &workspace
        .items
        .iter()
        .find(|item| item.kind == "ontology")
        .unwrap()
        .after["verification"]
}

async fn run_check(
    store: &LocalSnapshotStore,
    pool: &PgPool,
    workspace: &ReviewWorkspace,
    key: &str,
    original: &PaidOrdersDefinition,
    field: &str,
) -> ReviewWorkspace {
    let mut definition = original.clone();
    definition.payment.paid_at_column = field.into();
    let prepared = store
        .prepare_ontology_check(VerifyOntologyReviewInput {
            source_id: workspace.source_id,
            revision: workspace.revision.clone(),
            item_key: key.into(),
            definition,
            basis: "Verified the payment event contract.".into(),
        })
        .await
        .unwrap();
    let rows = execute(pool, prepared.sql.clone()).await;
    let ids = rows
        .into_iter()
        .map(|mut row| match row.pop() {
            Some(QueryCell::Text {
                value,
                truncated: false,
            }) if row.is_empty() => value,
            _ => panic!("expected an exact order ID"),
        })
        .collect();
    store
        .record_ontology_check(prepared, Ok(ids))
        .await
        .unwrap()
}

async fn create_fixture_schema(pool: &PgPool) -> String {
    let schema = format!("ontology_qa_{}", Uuid::new_v4().simple());
    sqlx::raw_sql(AssertSqlSafe(format!(
        "CREATE SCHEMA {schema};
        CREATE TABLE {schema}.orders (id integer PRIMARY KEY);
        CREATE TABLE {schema}.payments (
            id integer PRIMARY KEY,
            order_id integer NOT NULL REFERENCES {schema}.orders(id),
            status text NOT NULL,
            paid_at timestamptz,
            settled_at timestamptz
        );
        INSERT INTO {schema}.orders (id) VALUES (1),(2),(3),(4),(5),(6),(7);"
    )))
    .execute(pool)
    .await
    .unwrap();
    schema
}

fn fixture_definition(schema: &str) -> PaidOrdersDefinition {
    PaidOrdersDefinition {
        name: "已付款订单".into(),
        order: OrderObject {
            name: "订单".into(),
            table: ObjectKey::table(schema, "orders"),
            id_column: "id".into(),
        },
        payment: PaymentObject {
            name: "付款".into(),
            table: ObjectKey::table(schema, "payments"),
            order_id_column: "order_id".into(),
            status_column: "status".into(),
            success_value: "succeeded".into(),
            paid_at_column: "paid_at".into(),
            time_storage: None,
        },
        time_zone: BusinessTimeZone::Singapore,
    }
}

async fn seed_payments(pool: &PgPool, schema: &str, starts_at: &str, ends_before: &str) {
    let start = starts_at.parse::<DateTime<Utc>>().unwrap();
    let end = ends_before.parse::<DateTime<Utc>>().unwrap();
    sqlx::query(AssertSqlSafe(format!(
        "INSERT INTO {schema}.payments (id, order_id, status, paid_at) VALUES
          (1,1,'succeeded',$1 + interval '7 days'),
          (2,1,'succeeded',$1 + interval '19 days'),
          (3,2,'succeeded',$1 - interval '1 second'),
          (4,2,'succeeded',$1 + interval '9 days'),
          (5,3,'failed',$1 + interval '10 days'),
          (6,4,'succeeded',$1),
          (7,5,'succeeded',$2),
          (8,6,'succeeded',NULL),
          (9,1,'refunded',$1 + interval '20 days'),
          (10,7,'succeeded',$2 - interval '1 minute')"
    )))
    .bind(start)
    .bind(end)
    .execute(pool)
    .await
    .unwrap();
    sqlx::raw_sql(AssertSqlSafe(format!(
        "UPDATE {schema}.payments SET settled_at = CASE WHEN id IN (3, 10) THEN paid_at + interval '2 minutes' ELSE paid_at END"
    ))).execute(pool).await.unwrap();
}

async fn execute(pool: &PgPool, sql: String) -> Vec<Vec<QueryCell>> {
    execute_postgres_query(
        pool,
        &ExecuteQueryRequest {
            query_id: Uuid::new_v4(),
            sql,
            row_limit: 100,
            timeout_ms: 10_000,
            max_cell_bytes: query_engine::DEFAULT_CELL_BYTES,
            max_result_bytes: query_engine::DEFAULT_RESULT_BYTES,
        },
        &CancellationToken::new(),
    )
    .await
    .unwrap()
    .rows
}
