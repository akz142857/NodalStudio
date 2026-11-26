#[cfg(not(feature = "mac-app-store"))]
use std::{fs, path::Path};

use schema_model::{
    ColumnDefinition, DatabaseInfo, DatabaseSnapshot, DatabaseType, ObjectKey, ObjectKind,
    SchemaDefinition, TableDefinition,
};
#[cfg(not(feature = "mac-app-store"))]
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[cfg(not(feature = "mac-app-store"))]
use super::{Binding, check_scan, collect_scan, files::Repository};
use super::{analyze, impacted_objects};

fn snapshot(payment_time: &str) -> DatabaseSnapshot {
    let mut schema = SchemaDefinition::empty("commerce");
    for (name, columns) in [
        ("orders", vec!["id"]),
        ("payments", vec!["id", "order_id", payment_time]),
    ] {
        let mut table = TableDefinition::empty("commerce", name);
        for (position, column) in columns.into_iter().enumerate() {
            table.columns.push(ColumnDefinition {
                name: column.into(),
                ordinal_position: i32::try_from(position).unwrap() + 1,
                formatted_type: "bigint".into(),
                type_schema: "commerce".into(),
                type_name: "bigint".into(),
                nullable: false,
                default_value: None,
                identity: None,
                generated: false,
                comment: None,
            });
        }
        schema.tables.push(table);
    }
    DatabaseSnapshot::new(
        Uuid::new_v4(),
        DatabaseInfo {
            name: "commerce".into(),
            database_type: DatabaseType::MySql,
            version: "8.4".into(),
        },
        vec![schema],
    )
}

#[test]
fn resolves_only_evidenced_columns_and_preserves_source_ranges() {
    let sql = "-- review\nSELECT '雪;☕', p.paid_at FROM payments AS p;\nSELECT id FROM orders JOIN payments ON orders.id = payments.order_id;\nSELECT id FROM orders JOIN unavailable;";
    let (statements, error) = analyze(sql, &snapshot("paid_at"));
    assert!(error.is_none());
    assert_eq!(statements.len(), 3);
    assert_eq!(statements[0].line, 2);
    assert_eq!(
        &sql[statements[0].start..statements[0].end],
        "SELECT '雪;☕', p.paid_at FROM payments AS p"
    );
    let payments = ObjectKey::table("commerce", "payments");
    let orders = ObjectKey::table("commerce", "orders");
    assert!(
        statements[0]
            .references
            .contains(&payments.child(ObjectKind::Column, "paid_at"))
    );
    assert!(
        statements[1]
            .references
            .contains(&payments.child(ObjectKind::Column, "order_id"))
    );
    assert!(statements[1].diagnostics.contains("ambiguousColumn"));
    assert!(
        !statements[2]
            .references
            .contains(&orders.child(ObjectKind::Column, "id"))
    );
    assert!(!statements[2].open_query);
}

#[test]
fn cte_shadowing_and_changed_session_do_not_link_to_wrong_tables() {
    let snapshot = snapshot("paid_at");
    let (cte, _) = analyze(
        "WITH PAYMENTS AS (SELECT id FROM orders) SELECT id FROM payments;",
        &snapshot,
    );
    assert!(
        cte[0]
            .references
            .contains(&ObjectKey::table("commerce", "orders"))
    );
    assert!(
        !cte[0]
            .references
            .contains(&ObjectKey::table("commerce", "payments"))
    );
    let (script, _) = analyze("USE peer; SELECT id FROM orders;", &snapshot);
    assert!(script[1].diagnostics.contains("sessionContext"));
    assert!(!script[1].open_query);
    let (cross, _) = analyze(
        "SELECT id FROM orders ORDER BY (SELECT MAX(id) FROM peer.orders);",
        &snapshot,
    );
    assert!(cross[0].diagnostics.contains("outsideDatabase"));
    assert!(cross[0].outside_databases.contains("peer"));
    assert!(!cross[0].open_query);

    let (migration, _) = analyze(
        "ALTER TABLE `peer`.payments ADD COLUMN status TEXT;",
        &snapshot,
    );
    assert!(migration[0].outside_databases.contains("peer"));
    assert!(migration[0].references.is_empty());
    assert!(migration[0].changes.is_empty());
}

#[test]
fn migration_preview_retains_old_field_after_it_leaves_current_schema() {
    let before = snapshot("paid_at");
    let after = snapshot("settled_at");
    let (statements, _) = analyze(
        "ALTER TABLE payments RENAME COLUMN paid_at TO settled_at;",
        &after,
    );
    let old = ObjectKey::table("commerce", "payments").child(ObjectKind::Column, "paid_at");
    assert_eq!(statements[0].changes[0].before.as_deref(), Some("paid_at"));
    assert_eq!(
        impacted_objects(&statements[0], &after),
        (std::collections::BTreeSet::new(), true)
    );
    assert_eq!(
        impacted_objects(&statements[0], &before),
        ([old].into(), false)
    );
}

#[cfg(not(feature = "mac-app-store"))]
fn repository() -> tempfile::TempDir {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join(".git")).unwrap();
    fs::create_dir(root.path().join("sql")).unwrap();
    fs::write(
        root.path().join(".git/HEAD"),
        "3bb062c9e01738d82ea0d8251e925ae672b43a7c\n",
    )
    .unwrap();
    root
}

#[test]
#[cfg(not(feature = "mac-app-store"))]
fn repository_writes_never_replace_existing_files() {
    let root = repository();
    let (repo, _) = Repository::open(root.path(), None).unwrap();
    let directories = vec!["sql".into()];
    repo.write("sql/report.sql", &directories, "SELECT id FROM orders")
        .unwrap();
    assert_eq!(
        repo.write("sql/report.sql", &directories, "SELECT 2")
            .unwrap_err()
            .kind(),
        std::io::ErrorKind::AlreadyExists
    );
    assert!(
        repo.write("sql/../outside.sql", &directories, "SELECT 3")
            .is_err()
    );
    assert!(repo.write("outside.sql", &directories, "SELECT 4").is_err());
    assert_eq!(
        repo.read("sql/report.sql", &directories).unwrap(),
        "SELECT id FROM orders"
    );
}

#[test]
#[cfg(not(feature = "mac-app-store"))]
fn ignore_rules_apply_to_scans_reads_and_writes() {
    let root = repository();
    fs::write(root.path().join(".gitignore"), "private.sql\n").unwrap();
    fs::write(root.path().join("sql/private.sql"), "private data").unwrap();
    fs::write(root.path().join("sql/report.sql"), "SELECT id FROM orders").unwrap();
    let directories = vec!["sql".into()];
    let (repo, _) = Repository::open(root.path(), None).unwrap();
    let mut walked = Vec::new();
    assert_eq!(
        repo.walk(&directories, |path| {
            walked.push(path);
            true
        }),
        0
    );
    assert_eq!(walked, ["sql/report.sql"]);
    assert!(repo.read("sql/private.sql", &directories).is_err());
    assert!(
        repo.write("sql/private.sql", &directories, "SELECT 1")
            .is_err()
    );
}

#[cfg(unix)]
#[test]
#[cfg(not(feature = "mac-app-store"))]
fn denies_symlinks_even_under_authorized_roots() {
    let root = repository();
    let other = tempfile::tempdir().unwrap();
    fs::write(other.path().join("read.sql"), "SELECT 1").unwrap();
    std::os::unix::fs::symlink(other.path(), root.path().join("sql/elsewhere")).unwrap();
    std::os::unix::fs::symlink(
        other.path().join("read.sql"),
        root.path().join("sql/linked.sql"),
    )
    .unwrap();
    let (repo, _) = Repository::open(root.path(), None).unwrap();
    let directories = vec!["sql".into()];
    assert!(repo.read("sql/elsewhere/read.sql", &directories).is_err());
    assert!(repo.read("sql/linked.sql", &directories).is_err());
    assert!(
        repo.write("sql/elsewhere/new.sql", &directories, "SELECT 2")
            .is_err()
    );
    assert!(!other.path().join("new.sql").exists());
}

#[test]
#[cfg(not(feature = "mac-app-store"))]
fn a_stable_coverage_gap_does_not_invalidate_the_index() {
    let root = repository();
    fs::write(root.path().join("sql/report.sql"), "SELECT id FROM orders").unwrap();
    fs::write(root.path().join("sql/unreadable.sql"), [0xFF]).unwrap();
    let (_, root_identity) = Repository::open(root.path(), None).unwrap();
    let binding = Binding {
        id: Uuid::new_v4(),
        root: root.path().to_str().unwrap().into(),
        root_identity,
        directories: vec!["sql".into()],
        connection: String::new(),
    };
    let token = CancellationToken::new();
    let scan = collect_scan(&binding, &snapshot("paid_at"), Uuid::new_v4(), &token, None).unwrap();
    assert_eq!(scan.skipped, 1);
    assert!(check_scan(&binding, &scan));
    fs::write(
        Path::new(&binding.root).join("sql/new.sql"),
        "SELECT id FROM orders",
    )
    .unwrap();
    assert!(!check_scan(&binding, &scan));
}

#[cfg(not(feature = "mac-app-store"))]
#[tokio::test]
#[ignore = "requires NODAL_CODE_VIEW_FIXTURE_REPO and a disposable MySQL payment fixture"]
async fn scans_a_local_working_tree_against_a_captured_mysql_database() {
    use super::{QueryHandoff, connection_identity, digest, validate_query_handoff};

    let root = std::env::var("NODAL_CODE_VIEW_FIXTURE_REPO").unwrap();
    let url = std::env::var("NODAL_CODE_VIEW_FIXTURE_MYSQL_URL").unwrap();
    let (state, profile, snapshot) = captured_source(&url).await;
    let source_id = profile.id;
    let (project, root_identity) = Repository::open(Path::new(&root), None).unwrap();
    let binding = Binding {
        id: Uuid::new_v4(),
        root,
        root_identity,
        directories: vec!["queries".into(), "migrations".into()],
        connection: connection_identity(&profile),
    };
    state
        .store
        .save_code_view_binding(
            source_id,
            binding.id,
            &serde_json::to_string(&binding).unwrap(),
        )
        .await
        .unwrap();
    let scan = collect_scan(
        &binding,
        &snapshot,
        Uuid::new_v4(),
        &CancellationToken::new(),
        None,
    )
    .unwrap();
    assert!(scan.git.commit.is_some());
    let query_path = "queries/paid_orders.sql";
    let contents = project.read(query_path, &binding.directories).unwrap();
    let report = &scan.files[query_path].statements[0];
    let payment_time =
        ObjectKey::table(&snapshot.database.name, "payments").child(ObjectKind::Column, "paid_at");
    assert!(report.references.contains(&payment_time));
    assert!(report.open_query);
    assert!(!scan.files["queries/context_changes.sql"].statements[1].open_query);
    let migration = &scan.files["migrations/002_rename_payment_time.sql"].statements[0];
    assert!(
        impacted_objects(migration, &snapshot)
            .0
            .contains(&payment_time)
    );
    let sql = &contents[report.start..report.end];
    let handoff = QueryHandoff {
        source_id,
        binding_id: binding.id,
        database: profile.database.clone(),
        connection: binding.connection,
        profile_revision: profile.updated_at,
        snapshot_id: snapshot.id,
        path: query_path.into(),
        statement_digest: digest(sql),
    };
    validate_query_handoff(&state, &profile, &handoff, sql)
        .await
        .unwrap();
    assert!(
        validate_query_handoff(
            &state,
            &profile,
            &handoff,
            "SELECT id FROM another_database.orders"
        )
        .await
        .is_err()
    );
    let mut revised = profile;
    revised.updated_at += chrono::Duration::seconds(1);
    state.store.save_data_source(&revised).await.unwrap();
    assert!(
        validate_query_handoff(&state, &revised, &handoff, sql)
            .await
            .is_err()
    );
}

#[cfg(not(feature = "mac-app-store"))]
async fn captured_source(
    url: &str,
) -> (
    crate::AppState,
    schema_model::DataSourceProfile,
    DatabaseSnapshot,
) {
    use std::sync::Arc;

    use chrono::Utc;
    use schema_model::{ConnectionSecurity, DataSourceProfile, SslMode};
    use snapshot_store::LocalSnapshotStore;
    use tokio::sync::Semaphore;

    use crate::AppState;

    let options = url.parse::<sqlx::mysql::MySqlConnectOptions>().unwrap();
    let pool = sqlx::mysql::MySqlPoolOptions::new()
        .connect_with(options.clone())
        .await
        .unwrap();
    let source_id = Uuid::new_v4();
    let snapshot = mysql_adapter::inspect_schema(&pool, source_id)
        .await
        .unwrap();
    let profile = DataSourceProfile {
        id: source_id,
        display_name: "Disposable MySQL fixture".into(),
        host: options.get_host().into(),
        port: options.get_port(),
        database: snapshot.database.name.clone(),
        username: options.get_username().into(),
        database_type: DatabaseType::MySql,
        ssl_mode: SslMode::Disable,
        security: ConnectionSecurity::default(),
        sqlite: None,
        connection_sync: None,
        server_source_id: None,
        created_at: Utc::now(),
        updated_at: Utc::now(),
    };
    let store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
    store
        .save_verified_source(&profile, &snapshot)
        .await
        .unwrap();
    let state = AppState {
        store,
        sessions: crate::connection_sessions::ConnectionSessions::default(),
        ai_limiter: Arc::new(Semaphore::new(1)),
        snapshot_captures: Arc::default(),
        cloud_operations: Arc::default(),
        active_queries: Arc::default(),
    };
    (state, profile, snapshot)
}

#[tokio::test]
async fn migration_suggests_only_an_exact_unambiguous_local_history_link() {
    use std::sync::Arc;

    use chrono::{Duration, Utc};
    use extension_model::ChangeProvenance;
    use snapshot_store::LocalSnapshotStore;
    use tokio::sync::Semaphore;

    use super::{files::GitVersion, linked_migration_baseline};

    let mut before = snapshot("paid_at");
    before.canonicalize().unwrap();
    let mut current = snapshot("settled_at");
    current.source_id = before.source_id;
    current.captured_at = before.captured_at + Duration::minutes(1);
    current.canonicalize().unwrap();
    let store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
    store.save_snapshot(&before).await.unwrap();
    store.save_snapshot(&current).await.unwrap();
    let changes = schema_diff::diff_snapshots(&before, &current);
    store.save_change_set(&changes).await.unwrap();
    store
        .save_change_provenance(&ChangeProvenance {
            change_set_id: changes.id,
            branch: Some("main".into()),
            commit_sha: None,
            pull_request_url: None,
            migration_files: vec!["migrations/payment.sql".into()],
            recorded_at: Utc::now(),
        })
        .await
        .unwrap();
    let state = crate::AppState {
        store,
        sessions: crate::connection_sessions::ConnectionSessions::default(),
        ai_limiter: Arc::new(Semaphore::new(1)),
        snapshot_captures: Arc::default(),
        cloud_operations: Arc::default(),
        active_queries: Arc::default(),
    };
    let git = GitVersion {
        branch: Some("main".into()),
        commit: None,
    };
    let proposed = linked_migration_baseline(&state, &current, "migrations/payment.sql", &git)
        .await
        .unwrap();
    assert_eq!(proposed.map(|value| value.id), Some(before.id));
    assert!(
        linked_migration_baseline(&state, &current, "examples/payment.sql", &git)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        linked_migration_baseline(
            &state,
            &current,
            "migrations/payment.sql",
            &GitVersion::default()
        )
        .await
        .unwrap()
        .is_none()
    );
}
