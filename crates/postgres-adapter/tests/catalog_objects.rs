use postgres_adapter::{PostgresConnectionOptions, connect, inspect_schema};
use schema_model::ObjectKind;
use uuid::Uuid;
#[tokio::test]
async fn reads_catalog_objects_and_materialized_indexes() {
    let Ok(url) = std::env::var("CATALOG_POSTGRES_URL") else {
        return;
    };
    let pool = connect(&PostgresConnectionOptions::new(url)).await.unwrap();
    let snapshot = inspect_schema(&pool, Uuid::nil()).await.unwrap();
    let schema = snapshot
        .schemas
        .iter()
        .find(|s| s.name == "catalog_acceptance")
        .unwrap();
    assert_eq!(
        schema
            .programs
            .iter()
            .filter(|p| p.key.name.starts_with("echo("))
            .count(),
        2
    );
    assert!(
        schema
            .programs
            .iter()
            .any(|p| p.key.kind == ObjectKind::Procedure)
    );
    let trigger = schema
        .programs
        .iter()
        .find(|p| p.key.kind == ObjectKind::Trigger && p.key.name == "accounts.account_guard")
        .unwrap();
    assert_eq!(trigger.table.as_ref().unwrap().name, "accounts");
    assert!(
        trigger
            .definition
            .as_ref()
            .unwrap()
            .contains("keep_account")
    );
    let view = schema
        .views
        .iter()
        .find(|v| v.key.name == "account_totals")
        .unwrap();
    assert!(view.materialized);
    assert!(view.indexes.iter().any(|i| {
        i.name == "account_totals_cover_idx"
            && i.definition
                .as_deref()
                .is_some_and(|d| d.contains("INCLUDE (balance)"))
    }));
    assert!(
        view.indexes
            .iter()
            .any(|i| i.name == "account_totals_id_idx" && i.unique)
    );
    assert!(
        schema
            .dependencies
            .iter()
            .any(|d| d.source.name == "account_count()" && d.target.name == "accounts")
    );
    assert!(
        schema
            .dependencies
            .iter()
            .any(|d| d.source.name == "account_view" && d.target.name == "accounts")
    );
    assert!(
        schema
            .dependencies
            .iter()
            .any(|d| d.source.kind == ObjectKind::Trigger && d.target.name == "keep_account()")
    );
    let again = inspect_schema(&pool, Uuid::nil()).await.unwrap();
    assert_eq!(snapshot.fingerprint, again.fingerprint);
}
