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
    assert_eq!(orders.foreign_keys[0].referenced_table, "customers");
    assert!(
        schema
            .views
            .iter()
            .any(|view| view.key.name == "order_totals")
    );
}
