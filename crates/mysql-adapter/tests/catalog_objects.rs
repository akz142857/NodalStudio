use mysql_adapter::{MySqlConnectionOptions, connect, inspect_schema};
use schema_model::{ObjectKind, SchemaDefinition};
use uuid::Uuid;
#[tokio::test]
async fn reads_programs_trigger_dependencies_and_checks() {
    let Ok(url) = std::env::var("CATALOG_MYSQL_URL") else {
        return;
    };
    let pool = connect(&MySqlConnectionOptions::new(url)).await.unwrap();
    let snapshot = inspect_schema(&pool, Uuid::nil()).await.unwrap();
    let schema = &snapshot.schemas[0];
    assert_generated_flags(schema);
    let cases = schema
        .tables
        .iter()
        .find(|t| t.key.name == "catalog_index_cases")
        .unwrap();
    assert!(cases.indexes.iter().any(|i| {
        i.name == "catalog_label_prefix"
            && i.definition
                .as_deref()
                .is_some_and(|d| d.contains("(12) DESC"))
    }));
    assert!(
        cases
            .indexes
            .iter()
            .any(|i| i.name == "catalog_label_expression"
                && i.columns.iter().any(|c| c.contains("lower")))
    );
    assert!(
        cases
            .constraints
            .iter()
            .any(|c| c.name == "catalog_label_unique")
    );
    let function = schema
        .programs
        .iter()
        .find(|p| p.key.name == "catalog_echo")
        .unwrap();
    assert_eq!(function.key.kind, ObjectKind::Function);
    let hidden = schema
        .programs
        .iter()
        .find(|p| p.key.name == "catalog_hidden")
        .unwrap();
    assert!(
        hidden.definition.is_none(),
        "a hidden body must remain unavailable, not fabricated SQL"
    );
    assert!(function.arguments.contains("value_in"));
    assert_event_definition(schema);
    assert!(
        function
            .definition
            .as_deref()
            .is_some_and(|body| body.contains("value_in"))
    );
    assert!(
        schema
            .programs
            .iter()
            .any(|p| p.key.name == "catalog_read_accounts" && p.key.kind == ObjectKind::Procedure)
    );
    assert!(
        schema.dependencies.iter().any(
            |d| d.source.name == "catalog_account_guard" && d.target.name == "catalog_accounts"
        )
    );
    assert!(schema.dependencies.iter().any(|d|d.source.name=="catalog_account_view" && d.target.name=="catalog_accounts"));
    let table = schema
        .tables
        .iter()
        .find(|t| t.key.name == "catalog_accounts")
        .unwrap();
    assert!(
        table
            .constraints
            .iter()
            .any(|c| c.name == "catalog_balance_check")
    );
    assert_eq!(
        snapshot.fingerprint,
        inspect_schema(&pool, Uuid::nil())
            .await
            .unwrap()
            .fingerprint
    );
}

fn assert_generated_flags(schema: &SchemaDefinition) {
    let columns = &schema
        .tables
        .iter()
        .find(|table| table.key.name == "catalog_generated_flags")
        .unwrap()
        .columns;
    let timestamp = columns
        .iter()
        .find(|column| column.name == "created_at")
        .unwrap();
    assert!(timestamp.default_value.is_some() && !timestamp.generated);
    assert!(
        columns
            .iter()
            .find(|column| column.name == "derived")
            .unwrap()
            .generated
    );
}

fn assert_event_definition(schema: &SchemaDefinition) {
    let event = schema
        .programs
        .iter()
        .find(|program| {
            program.key.kind == ObjectKind::Event && program.key.name == "catalog_daily_check"
        })
        .expect("the catalog includes scheduled events");
    assert_eq!(event.enabled.as_deref(), Some("DISABLED"));
    let definition = event.definition.as_deref().unwrap();
    assert!(definition.contains("EVERY 1 DAY"));
    assert!(definition.contains("@catalog_checked"));
}
