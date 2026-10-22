use crate::*;
use schema_model::ObjectKey;
use schema_model::{DatabaseInfo, DatabaseType, SchemaDefinition, TableDefinition};
use semantic_model::knowledge::{
    KnowledgeBasis, KnowledgeOrigin, KnowledgeStatus, annotation_version,
};
use std::collections::BTreeMap;

#[cfg(test)]
#[path = "knowledge_http_acceptance.rs"]
mod http_acceptance;
fn model(source: Uuid) -> DatabaseSnapshot {
    let mut snapshot = DatabaseSnapshot::new(
        source,
        DatabaseInfo {
            name: "app".into(),
            database_type: DatabaseType::PostgreSql,
            version: "17".into(),
        },
        vec![SchemaDefinition {
            name: "public".into(),
            tables: vec![
                TableDefinition::empty("public", "orders"),
                TableDefinition::empty("public", "other"),
            ],
            views: vec![],
            enums: vec![],
        }],
    );
    snapshot.schemas[0].tables[0]
        .constraints
        .push(schema_model::ConstraintDefinition {
            name: "orders_business_key_unique".into(),
            constraint_type: schema_model::ConstraintType::Unique,
            definition: "UNIQUE (business_key)".into(),
        });
    snapshot.canonicalize().unwrap();
    snapshot
}
fn annotation(source: Uuid) -> ObjectAnnotation {
    ObjectAnnotation {
        source_id: source,
        object_key: ObjectKey::table("public", "orders"),
        description: Some("May represent purchase intent".into()),
        tags: vec!["core".into()],
        owner: Some("Team".into()),
        is_core: true,
        updated_at: Utc::now(),
    }
}
async fn confirm(store: &LocalSnapshotStore, snapshot: &DatabaseSnapshot) {
    let a = store
        .list_annotations(snapshot.source_id)
        .await
        .unwrap()
        .remove(0);
    store
        .confirm_knowledge(
            Uuid::new_v4(),
            snapshot.source_id,
            &a.object_key,
            &annotation_version(Some(&a)),
            &KnowledgeBasis::from_tables(snapshot, std::slice::from_ref(&a.object_key), &[]),
            a.description.as_deref().unwrap(),
            &KnowledgeOrigin {
                kind: "manualReview".into(),
                request_id: None,
                provider: None,
                model: None,
                generated_at: None,
                evidence: serde_json::json!({"privateLocalProof":"never export"}),
            },
        )
        .await
        .unwrap();
}
async fn status(store: &LocalSnapshotStore, source: Uuid) -> KnowledgeStatus {
    store.knowledge_states(source).await.unwrap()[0]
        .status
        .clone()
}
async fn receive(
    kind: &str,
    store: &LocalSnapshotStore,
    snapshot: &DatabaseSnapshot,
    annotations: Vec<ObjectAnnotation>,
) {
    if kind == "git" {
        let documents: Vec<_> = annotations
            .iter()
            .map(|a| SemanticDocument {
                object: a.object_key.clone(),
                value: git_workspace::SemanticValue::from(a),
                members: BTreeMap::default(),
            })
            .collect();
        let json = serde_json::to_string(&documents).unwrap();
        assert!(!json.contains("privateLocalProof"));
        assert!(!json.contains("confirmedAt"));
        import_git_semantics(store, snapshot.source_id, &documents, Utc::now())
            .await
            .unwrap();
    } else {
        let bundle = CloudSyncBundle {
            project_id: Uuid::new_v4(),
            source_id: snapshot.source_id,
            source_label: "app".into(),
            fingerprint: snapshot.fingerprint.clone(),
            snapshot: Some(snapshot.clone()),
            change_set: None,
            annotations,
            domain_groups: vec![],
            saved_views: vec![],
            logical_relationships: vec![],
            layout: None,
            project_settings: None,
            base_version: 0,
        };
        let json = serde_json::to_string(&bundle).unwrap();
        assert!(!json.contains("privateLocalProof"));
        assert!(!json.contains("confirmedAt"));
        apply_remote_cloud_bundle(store, snapshot.source_id, &bundle)
            .await
            .unwrap();
    }
}
#[tokio::test]
async fn two_devices_git_and_cloud_never_promote_received_text_and_preserve_only_valid_local_review()
 {
    for kind in ["git", "cloud"] {
        let a = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
        let b = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
        let mut snapshot = model(Uuid::new_v4());
        for store in [&a, &b] {
            store.save_snapshot(&snapshot).await.unwrap();
        }
        a.save_annotation(&annotation(snapshot.source_id))
            .await
            .unwrap();
        confirm(&a, &snapshot).await;
        receive(
            kind,
            &b,
            &snapshot,
            a.list_annotations(snapshot.source_id).await.unwrap(),
        )
        .await;
        assert_eq!(
            status(&b, snapshot.source_id).await,
            KnowledgeStatus::PendingReview
        );
        assert!(
            b.confirmed_annotations(snapshot.source_id)
                .await
                .unwrap()
                .is_empty()
        );
        confirm(&b, &snapshot).await;
        let confirmation = b.knowledge_states(snapshot.source_id).await.unwrap()[0]
            .confirmation
            .clone()
            .unwrap();
        receive(
            kind,
            &b,
            &snapshot,
            a.list_annotations(snapshot.source_id).await.unwrap(),
        )
        .await;
        assert_eq!(
            status(&b, snapshot.source_id).await,
            KnowledgeStatus::Confirmed
        );
        assert_eq!(
            b.knowledge_states(snapshot.source_id).await.unwrap()[0]
                .confirmation
                .as_ref()
                .unwrap()
                .id,
            confirmation.id
        );
        snapshot.id = Uuid::new_v4();
        snapshot.captured_at = Utc::now();
        // P2-01: the description was confirmed under a uniqueness constraint that is now gone.
        snapshot.schemas[0].tables[0].constraints.clear();
        snapshot.canonicalize().unwrap();
        for store in [&a, &b] {
            store.save_snapshot(&snapshot).await.unwrap();
        }
        assert_eq!(
            status(&a, snapshot.source_id).await,
            KnowledgeStatus::PendingReview
        );
        receive(
            kind,
            &b,
            &snapshot,
            a.list_annotations(snapshot.source_id).await.unwrap(),
        )
        .await;
        assert_eq!(
            status(&b, snapshot.source_id).await,
            KnowledgeStatus::PendingReview
        );
        // The new package fingerprint matches on both machines, but does not repair either proof.
        confirm(&b, &snapshot).await;
        let mut changed = a.list_annotations(snapshot.source_id).await.unwrap();
        changed[0].description = Some("Merged description from another author".into());
        receive(kind, &b, &snapshot, changed).await;
        assert_eq!(
            status(&b, snapshot.source_id).await,
            KnowledgeStatus::PendingReview
        );
        receive(
            kind,
            &a,
            &snapshot,
            b.list_annotations(snapshot.source_id).await.unwrap(),
        )
        .await;
        assert_eq!(
            status(&a, snapshot.source_id).await,
            KnowledgeStatus::PendingReview
        );
    }
}
#[tokio::test]
async fn portable_backup_does_not_carry_confirmation_and_restore_cannot_reuse_changed_text_proof() {
    let a = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
    let b = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
    let snapshot = model(Uuid::new_v4());
    a.save_snapshot(&snapshot).await.unwrap();
    a.save_annotation(&annotation(snapshot.source_id))
        .await
        .unwrap();
    confirm(&a, &snapshot).await;
    let bundle = snapshot_store::PortableModelBackup {
        format_version: 1,
        exported_at: Utc::now().to_rfc3339(),
        source_id: snapshot.source_id,
        source_profile: None,
        source_settings: DataSourceSettings::defaults_for(snapshot.source_id),
        snapshots: vec![snapshot.clone()],
        change_sets: vec![],
        annotations: a.list_annotations(snapshot.source_id).await.unwrap(),
        domain_groups: vec![],
        saved_views: vec![],
        layouts: vec![],
        provenance: vec![],
        lineage: vec![],
        logical_relationships: vec![],
        ignored_relationship_inferences: vec![],
    };
    assert!(
        !serde_json::to_string(&bundle)
            .unwrap()
            .contains("privateLocalProof")
    );
    b.import_portable_model(&bundle).await.unwrap();
    assert_eq!(
        status(&b, snapshot.source_id).await,
        KnowledgeStatus::PendingReview
    );
    confirm(&b, &snapshot).await;
    let mut changed = bundle;
    changed.annotations[0].description = Some("Old restored version".into());
    b.import_portable_model(&changed).await.unwrap();
    assert_eq!(
        status(&b, snapshot.source_id).await,
        KnowledgeStatus::PendingReview
    );
}

#[tokio::test]
async fn legacy_change_and_domain_requests_never_serialize_confirmed_team_text() {
    let store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
    let mut before = model(Uuid::new_v4());
    let mut snapshot = before.clone();
    before.schemas[0].tables.retain(|t| t.key.name != "orders");
    before.canonicalize().unwrap();
    snapshot.id = Uuid::new_v4();
    snapshot.captured_at = Utc::now();
    snapshot.schemas[0]
        .tables
        .iter_mut()
        .find(|t| t.key.name == "orders")
        .unwrap()
        .comment = Some("Changed database comment".into());
    snapshot.canonicalize().unwrap();
    store.save_snapshot(&snapshot).await.unwrap();
    let target = ObjectKey::table("public", "orders");
    let basis = KnowledgeBasis::from_tables(
        &snapshot,
        &[target.clone(), ObjectKey::table("public", "other")],
        &[],
    );
    store
        .confirm_knowledge(
            Uuid::new_v4(),
            snapshot.source_id,
            &target,
            &annotation_version(None),
            &basis,
            "Secret_B_business_meaning",
            &KnowledgeOrigin {
                kind: "manualReview".into(),
                request_id: None,
                provider: None,
                model: None,
                generated_at: None,
                evidence: serde_json::json!({}),
            },
        )
        .await
        .unwrap();
    assert_eq!(
        status(&store, snapshot.source_id).await,
        KnowledgeStatus::Confirmed
    );
    let mut input = ExplainSchemaInput {
        snapshot_id: snapshot.id,
        target_type: "changeSet".into(),
        object_key: None,
        domain_group: Some(DomainGroup {
            id: Uuid::new_v4(),
            source_id: snapshot.source_id,
            name: "Orders".into(),
            description: None,
            color: "blue".into(),
            table_keys: vec![target.clone()],
            updated_at: Utc::now(),
        }),
        change_set: Some(diff_snapshots(&before, &snapshot)),
        question: None,
        relationship_depth: 1,
        ai_enabled: true,
    };
    for kind in ["changeSet", "domain"] {
        input.target_type = kind.into();
        for comments in [true, false] {
            let context = legacy_explanation_context(&snapshot, &input, comments).unwrap();
            assert_eq!(context.tables.len(), 1);
            assert_eq!(context.tables[0].key, target);
            assert!(context.tables[0].annotation.is_none());
            assert_eq!(context.tables[0].comment.is_some(), comments);
            assert!(
                !serde_json::to_string(&context)
                    .unwrap()
                    .contains("Secret_B_business_meaning")
            );
        }
    }
}

#[tokio::test]
async fn failed_candidate_introspection_does_not_replace_profile_or_invalidate_confirmation() {
    let store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
    let snapshot = model(Uuid::new_v4());
    let original = DataSourceProfile {
        id: snapshot.source_id,
        display_name: "Original".into(),
        host: "old.example".into(),
        port: 5432,
        database: "app".into(),
        username: "reader".into(),
        database_type: DatabaseType::PostgreSql,
        ssl_mode: SslMode::Disable,
        security: schema_model::ConnectionSecurity::default(),
        created_at: Utc::now(),
        updated_at: Utc::now(),
    };
    store
        .save_verified_source(&original, &snapshot)
        .await
        .unwrap();
    store
        .save_annotation(&annotation(snapshot.source_id))
        .await
        .unwrap();
    confirm(&store, &snapshot).await;
    let mut settings = DataSourceSettings::defaults_for(snapshot.source_id);
    settings.refresh.connection_timeout_seconds = 1;
    store.save_data_source_settings(&settings).await.unwrap();
    let state = AppState {
        store,
        ai_limiter: Arc::new(tokio::sync::Semaphore::new(840)),
        snapshot_captures: Arc::default(),
        cloud_operations: Arc::default(),
        active_queries: Arc::default(),
    };
    let mut candidate = original.clone();
    candidate.host = "127.0.0.1".into();
    candidate.port = 0;
    let candidate_input = SaveDataSourceInput {
        id: Some(candidate.id),
        display_name: candidate.display_name.clone(),
        host: candidate.host.clone(),
        port: candidate.port,
        database: candidate.database.clone(),
        username: candidate.username.clone(),
        password: "unused".into(),
        ssh_password: None,
        database_type: candidate.database_type,
        ssl_mode: candidate.ssl_mode,
        security: candidate.security.clone(),
    };
    // Introspection fails before any Keychain or persistence write.
    assert!(
        capture_snapshot_using(
            CaptureSnapshotInput {
                source_id: snapshot.source_id,
                trigger: None
            },
            &state,
            Some((&candidate, &candidate_input))
        )
        .await
        .is_err()
    );
    assert_eq!(
        state
            .store
            .get_data_source(snapshot.source_id)
            .await
            .unwrap(),
        Some(original)
    );
    assert_eq!(
        state
            .store
            .latest_snapshot(snapshot.source_id)
            .await
            .unwrap()
            .unwrap()
            .id,
        snapshot.id
    );
    assert_eq!(
        status(&state.store, snapshot.source_id).await,
        KnowledgeStatus::Confirmed
    );
}
