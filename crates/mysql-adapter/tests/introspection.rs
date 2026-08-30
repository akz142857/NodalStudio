use mysql_adapter::{MySqlConnectionOptions, connect, inspect_schema};
use uuid::Uuid;

#[tokio::test]
async fn introspects_the_mysql_fixture() {
    let Ok(url) = std::env::var("TEST_MYSQL_DATABASE_URL") else {
        return;
    };
    let pool = connect(&MySqlConnectionOptions::new(url)).await.unwrap();
    let snapshot = inspect_schema(&pool, Uuid::new_v4()).await.unwrap();
    let schema = &snapshot.schemas[0];
    let orders = schema
        .tables
        .iter()
        .find(|table| table.key.name == "orders")
        .unwrap();

    assert_eq!(
        snapshot.database.database_type,
        schema_model::DatabaseType::MySql
    );
    assert!(orders.primary_key.is_some());

    // The fixture declares ON DELETE RESTRICT and a UNIQUE column. Both used to
    // be read with a fallback that quietly substituted NO ACTION and
    // "not unique", so assert them: a wrong referential action inverts what a
    // delete does, and a missed UNIQUE misreports the shape of the key.
    let foreign_key = &orders.foreign_keys[0];
    assert_eq!(foreign_key.referenced_table, "customers");
    assert_eq!(foreign_key.referenced_columns, vec!["id".to_string()]);
    assert_eq!(
        foreign_key.on_delete,
        schema_model::ReferentialAction::Restrict
    );
    assert_eq!(
        foreign_key.on_update,
        schema_model::ReferentialAction::NoAction
    );

    let customers = schema
        .tables
        .iter()
        .find(|table| table.key.name == "customers")
        .unwrap();
    let email_index = customers
        .indexes
        .iter()
        .find(|index| index.columns == vec!["email".to_string()])
        .expect("UNIQUE email should surface as an index");
    assert!(email_index.unique, "UNIQUE column must read back as unique");
    assert!(!email_index.method.is_empty(), "index method must be read");

    let status_index = orders
        .indexes
        .iter()
        .find(|index| index.name == "orders_status_idx")
        .unwrap();
    assert!(!status_index.unique);

    assert!(
        schema
            .views
            .iter()
            .any(|view| view.key.name == "order_totals")
    );
}
