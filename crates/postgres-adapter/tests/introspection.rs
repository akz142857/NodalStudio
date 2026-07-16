use postgres_adapter::{PostgresConnectionOptions, connect, inspect_schema};
use schema_model::{IdentityKind, ReferentialAction};
use uuid::Uuid;

#[tokio::test]
async fn introspects_the_postgres_fixture() {
    let Ok(url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("skipping PostgreSQL integration test: TEST_DATABASE_URL is not set");
        return;
    };

    let pool = connect(&PostgresConnectionOptions::new(url))
        .await
        .expect("fixture database should accept a connection");
    let snapshot = inspect_schema(&pool, Uuid::nil())
        .await
        .expect("fixture schema should be introspected");

    assert!(!snapshot.fingerprint.is_empty());
    let app = snapshot
        .schemas
        .iter()
        .find(|schema| schema.name == "app")
        .expect("app schema should exist");
    assert_eq!(app.tables.len(), 3);
    assert_eq!(app.views.len(), 2);
    assert_eq!(app.enums.len(), 1);
    assert_eq!(app.enums[0].values, ["draft", "paid", "cancelled"]);

    let users = app
        .tables
        .iter()
        .find(|table| table.key.name == "users")
        .expect("users table should exist");
    assert_eq!(users.comment.as_deref(), Some("Application user accounts"));
    assert_eq!(
        users
            .columns
            .iter()
            .find(|column| column.name == "id")
            .and_then(|column| column.identity),
        Some(IdentityKind::Always)
    );
    assert_eq!(
        users
            .columns
            .iter()
            .find(|column| column.name == "email")
            .and_then(|column| column.comment.as_deref()),
        Some("Canonical login email")
    );

    let orders = app
        .tables
        .iter()
        .find(|table| table.key.name == "orders")
        .expect("orders table should exist");
    assert_eq!(orders.foreign_keys.len(), 1);
    assert_eq!(orders.foreign_keys[0].columns, ["user_id"]);
    assert_eq!(orders.foreign_keys[0].referenced_table, "users");
    assert_eq!(orders.foreign_keys[0].on_delete, ReferentialAction::Cascade);
    assert_eq!(
        orders.foreign_keys[0].on_update,
        ReferentialAction::Restrict
    );
    assert!(orders.foreign_keys[0].deferrable);
    assert!(orders.foreign_keys[0].initially_deferred);
    assert!(
        orders
            .indexes
            .iter()
            .any(|index| index.name == "orders_active_user_idx" && index.predicate.is_some())
    );
    assert!(
        orders
            .constraints
            .iter()
            .any(|constraint| constraint.name == "orders_total_nonnegative")
    );

    let order_items = app
        .tables
        .iter()
        .find(|table| table.key.name == "order_items")
        .expect("order_items table should exist");
    assert_eq!(
        order_items
            .primary_key
            .as_ref()
            .expect("primary key should exist")
            .columns,
        ["order_id", "line_number"]
    );
}
