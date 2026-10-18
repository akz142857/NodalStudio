//! Opt-in live catalog acceptance. These tests never query application rows or write to the
//! source databases. All annotation changes are confined to an in-memory local store.
use crate::*;
use ai_context::{discovery, understanding};
use schema_model::ObjectKey;
use semantic_model::knowledge::{
    KnowledgeBasis, KnowledgeOrigin, KnowledgeStatus, annotation_version,
};
use sqlx::{mysql::MySqlPoolOptions, postgres::PgPoolOptions};

fn required(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("Set {name} to run this ignored acceptance test"))
}

#[tokio::test]
#[ignore = "requires an explicitly configured live PostgreSQL catalog"]
async fn live_postgres_catalog_supports_ai_workflow() {
    let pool = PgPoolOptions::new()
        .max_connections(2)
        .after_connect(|connection, _| {
            Box::pin(async move {
                sqlx::query("SET default_transaction_read_only = on")
                    .execute(&mut *connection)
                    .await?;
                sqlx::query("SET statement_timeout = '15s'")
                    .execute(&mut *connection)
                    .await?;
                Ok(())
            })
        })
        .connect(&required("NODAL_ACCEPTANCE_POSTGRES_URL"))
        .await
        .expect("connect to read-only PostgreSQL catalog");
    let readonly: String = sqlx::query_scalar("SHOW default_transaction_read_only")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(readonly, "on");
    let snapshot = postgres_adapter::inspect_schema(&pool, Uuid::new_v4())
        .await
        .expect("capture actual PostgreSQL metadata");
    verify_catalog(&snapshot, "postgres").await;
    pool.close().await;
}

#[tokio::test]
#[ignore = "requires an explicitly configured live MySQL catalog"]
async fn live_mysql_catalog_supports_ai_workflow() {
    let pool = MySqlPoolOptions::new()
        .max_connections(2)
        .after_connect(|connection, _| {
            Box::pin(async move {
                sqlx::query("SET SESSION TRANSACTION READ ONLY")
                    .execute(&mut *connection)
                    .await?;
                Ok(())
            })
        })
        .connect(&required("NODAL_ACCEPTANCE_MYSQL_URL"))
        .await
        .expect("connect to read-only MySQL catalog");
    let readonly: i64 = sqlx::query_scalar("SELECT @@session.transaction_read_only")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(readonly, 1);
    let snapshot = mysql_adapter::inspect_schema(&pool, Uuid::new_v4())
        .await
        .expect("capture actual MySQL metadata");
    verify_catalog(&snapshot, "mysql").await;
    pool.close().await;
}

#[allow(clippy::too_many_lines)]
async fn verify_catalog(snapshot: &DatabaseSnapshot, label: &str) {
    use understanding::SendScope;
    let tables: Vec<_> = snapshot.schemas.iter().flat_map(|s| &s.tables).collect();
    assert!(!tables.is_empty(), "acceptance requires actual tables");
    for table in &tables {
        for comments in [false, true] {
            let context = understanding::build_context(
                snapshot,
                &table.key,
                None,
                SendScope::CurrentTable,
                None,
                &[],
                comments,
            )
            .expect("single-table context");
            assert_eq!(context.tables, std::slice::from_ref(&table.key));
            assert!(context.evidence.iter().all(|e| e.table_key == table.key));
            for column in &table.columns {
                assert!(
                    context.evidence.iter().any(|e| e.kind == "column"
                        && e.object_key
                            == table
                                .key
                                .child(schema_model::ObjectKind::Column, &column.name)),
                    "every captured column must be locatable"
                );
            }
        }
    }
    // Also exercise candidate scoping on catalogs without any declared foreign keys.
    for table in &tables {
        let domain = DomainGroup {
            id: Uuid::new_v4(),
            source_id: snapshot.source_id,
            name: "One-table acceptance domain".into(),
            description: None,
            color: "blue".into(),
            table_keys: vec![table.key.clone()],
            updated_at: Utc::now(),
        };
        let mut candidates = vec![table.key.clone()];
        if let Some(other) = tables.iter().find(|t| t.key != table.key) {
            candidates.push(other.key.clone());
        }
        let task = discovery::DiscoveryTask {
            operation: discovery::Operation::Rank,
            question: "Find this permitted table".into(),
            root: Some(table.key.clone()),
            candidates,
            path_tables: vec![],
            path_relationships: vec![],
        };
        let ranked = discovery::build_context(
            snapshot,
            &task,
            SendScope::Domain,
            Some(&domain),
            &[],
            false,
        )
        .unwrap();
        assert_eq!(ranked.candidates.len(), 1);
        assert_eq!(ranked.candidates[0].table_key, table.key);
    }
    let relationships = discovery::known_relationships(snapshot, &[]);
    let foreign_keys: usize = tables.iter().map(|t| t.foreign_keys.len()).sum();
    assert_eq!(
        relationships.len(),
        foreign_keys,
        "all captured FK endpoints must resolve"
    );
    for relation in &relationships {
        // Self-references are valid structural facts, but not a navigational path between
        // distinct tables. The path contract intentionally rejects repeated table IDs.
        if relation.source == relation.target {
            continue;
        }
        let keys = vec![relation.source.clone(), relation.target.clone()];
        let domain = DomainGroup {
            id: Uuid::new_v4(),
            source_id: snapshot.source_id,
            name: "Acceptance scope".into(),
            description: None,
            color: "blue".into(),
            table_keys: keys.clone(),
            updated_at: Utc::now(),
        };
        let mut task = discovery::DiscoveryTask {
            operation: discovery::Operation::Path,
            question: "Explain only this known relationship".into(),
            root: Some(relation.source.clone()),
            candidates: keys.clone(),
            path_tables: keys,
            path_relationships: vec![relation.id.clone()],
        };
        let context = discovery::build_context(
            snapshot,
            &task,
            SendScope::Domain,
            Some(&domain),
            &[],
            false,
        )
        .expect("real FK path context");
        assert_eq!(context.path, std::slice::from_ref(relation));
        assert_eq!(context.path[0].source_columns, relation.source_columns);
        assert_eq!(context.path[0].target_columns, relation.target_columns);
        task.operation = discovery::Operation::Rank;
        task.path_tables.clear();
        task.path_relationships.clear();
        let ranked = discovery::build_context(
            snapshot,
            &task,
            SendScope::Domain,
            Some(&domain),
            &[],
            false,
        )
        .expect("permitted candidate context");
        assert!(
            ranked
                .candidates
                .iter()
                .all(|c| domain.table_keys.contains(&c.table_key))
        );
    }
    verify_local_knowledge(snapshot, &tables[0].key).await;
    if let Ok(directory) = std::env::var("NODAL_ACCEPTANCE_OUTPUT") {
        let path = Path::new(&directory);
        fs::create_dir_all(path).unwrap();
        // Metadata-only evidence stays in the operator-selected local output directory.
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options
            .open(path.join(format!("{label}-snapshot.json")))
            .unwrap();
        serde_json::to_writer_pretty(file, snapshot).unwrap();
    }
    println!(
        "LIVE_CATALOG_ACCEPTANCE {label}: version={}, tables={}, columns={}, foreign_keys={}, read_only=true; current-table evidence, scoped paths/ranking and local confirmation passed",
        snapshot.database.version,
        tables.len(),
        tables.iter().map(|t| t.columns.len()).sum::<usize>(),
        relationships.len()
    );
}

async fn verify_local_knowledge(snapshot: &DatabaseSnapshot, target: &ObjectKey) {
    let store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
    store.save_captured_snapshot(snapshot).await.unwrap();
    let annotation = ObjectAnnotation {
        source_id: snapshot.source_id,
        object_key: target.clone(),
        description: Some(
            "Acceptance-only description; business meaning remains unverified".into(),
        ),
        tags: vec![],
        owner: None,
        is_core: false,
        updated_at: Utc::now(),
    };
    store.save_annotation(&annotation).await.unwrap();
    assert!(
        store
            .confirmed_annotations(snapshot.source_id)
            .await
            .unwrap()
            .is_empty()
    );
    store
        .confirm_knowledge(
            Uuid::new_v4(),
            snapshot.source_id,
            target,
            &annotation_version(Some(&annotation)),
            &KnowledgeBasis::from_tables(snapshot, std::slice::from_ref(target), &[]),
            annotation.description.as_deref().unwrap(),
            &KnowledgeOrigin {
                kind: "manualReview".into(),
                request_id: None,
                provider: None,
                model: None,
                generated_at: None,
                evidence: serde_json::json!({"acceptanceOnly":true}),
            },
        )
        .await
        .unwrap();
    let states = store.knowledge_states(snapshot.source_id).await.unwrap();
    assert_eq!(states[0].status, KnowledgeStatus::Confirmed);
    let mut context = understanding::build_context(
        snapshot,
        target,
        None,
        understanding::SendScope::CurrentTable,
        None,
        &[],
        false,
    )
    .unwrap();
    understanding::append_confirmed_notes(
        snapshot,
        &context.tables,
        &mut context.evidence,
        &states,
    )
    .unwrap();
    assert!(context.evidence.iter().any(|e| e.kind == "teamStatement"));
    let mut repeated = snapshot.clone();
    repeated.id = Uuid::new_v4();
    repeated.captured_at = Utc::now();
    let capture = store.save_captured_snapshot(&repeated).await.unwrap();
    assert!(!capture.stored);
    assert_eq!(capture.snapshot.id, snapshot.id);
    let mut changed = annotation;
    changed.description = Some("Edited without renewed review".into());
    store.save_annotation(&changed).await.unwrap();
    assert_eq!(
        store.knowledge_states(snapshot.source_id).await.unwrap()[0].status,
        KnowledgeStatus::PendingReview
    );
    assert!(
        store
            .confirmed_annotations(snapshot.source_id)
            .await
            .unwrap()
            .is_empty()
    );
}
