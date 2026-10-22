use chrono::Utc;
use schema_model::{
    DatabaseInfo, DatabaseSnapshot, DatabaseType, ObjectKey, SchemaDefinition, TableDefinition,
};
use semantic_model::{
    ObjectAnnotation,
    knowledge::{KnowledgeBasis, KnowledgeOrigin, KnowledgeStatus, annotation_version},
};
use snapshot_store::LocalSnapshotStore;
use uuid::Uuid;
fn snapshot(source: Uuid) -> DatabaseSnapshot {
    let mut s = DatabaseSnapshot::new(
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
    s.canonicalize().unwrap();
    s
}
fn origin() -> KnowledgeOrigin {
    KnowledgeOrigin {
        kind: "manualReview".into(),
        request_id: None,
        provider: None,
        model: None,
        generated_at: None,
        evidence: serde_json::json!({"review":"local"}),
    }
}
fn annotation(source: Uuid) -> ObjectAnnotation {
    ObjectAnnotation {
        source_id: source,
        object_key: ObjectKey::table("public", "orders"),
        description: Some("May represent a purchase intent".into()),
        tags: vec!["core".into()],
        owner: Some("Commerce".into()),
        is_core: true,
        updated_at: Utc::now(),
    }
}
async fn confirm(store: &LocalSnapshotStore, s: &DatabaseSnapshot, a: &ObjectAnnotation) {
    store
        .confirm_knowledge(
            Uuid::new_v4(),
            s.source_id,
            &a.object_key,
            &annotation_version(Some(a)),
            &KnowledgeBasis::from_tables(s, std::slice::from_ref(&a.object_key), &[]),
            a.description.as_deref().unwrap(),
            &origin(),
        )
        .await
        .unwrap();
}
#[tokio::test]
async fn legacy_text_requires_confirmation_and_confirmation_preserves_authored_fields() {
    let store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
    let s = snapshot(Uuid::new_v4());
    store.save_snapshot(&s).await.unwrap();
    let a = annotation(s.source_id);
    store.save_annotation(&a).await.unwrap();
    assert_eq!(
        store.knowledge_states(s.source_id).await.unwrap()[0].status,
        KnowledgeStatus::PendingReview
    );
    assert!(
        store
            .confirmed_annotations(s.source_id)
            .await
            .unwrap()
            .is_empty()
    );
    confirm(&store, &s, &a).await;
    let saved = &store.confirmed_annotations(s.source_id).await.unwrap()[0];
    assert_eq!(saved.tags, a.tags);
    assert_eq!(saved.owner, a.owner);
    assert!(saved.is_core);
    assert_eq!(saved.description, a.description);
}
#[tokio::test]
async fn concurrent_edits_and_stale_structure_cannot_be_overwritten() {
    let store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
    let mut s = snapshot(Uuid::new_v4());
    store.save_snapshot(&s).await.unwrap();
    let mut a = annotation(s.source_id);
    store.save_annotation(&a).await.unwrap();
    let version = annotation_version(Some(&a));
    let basis = KnowledgeBasis::from_tables(&s, std::slice::from_ref(&a.object_key), &[]);
    a.owner = Some("New owner".into());
    store.save_annotation(&a).await.unwrap();
    assert!(
        store
            .confirm_knowledge(
                Uuid::new_v4(),
                s.source_id,
                &a.object_key,
                &version,
                &basis,
                "new text",
                &origin()
            )
            .await
            .is_err()
    );
    s.id = Uuid::new_v4();
    s.captured_at = Utc::now();
    s.schemas[0].tables[0].comment = Some("new evidence".into());
    s.canonicalize().unwrap();
    store.save_snapshot(&s).await.unwrap();
    assert!(
        store
            .confirm_knowledge(
                Uuid::new_v4(),
                s.source_id,
                &a.object_key,
                &annotation_version(Some(&a)),
                &basis,
                "new text",
                &origin()
            )
            .await
            .is_err()
    );
    assert_eq!(store.list_annotations(s.source_id).await.unwrap()[0], a);
}
#[tokio::test]
async fn unrelated_changes_and_same_text_import_preserve_only_existing_valid_confirmation() {
    let a_store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
    let b_store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
    let mut s = snapshot(Uuid::new_v4());
    let a = annotation(s.source_id);
    for store in [&a_store, &b_store] {
        store.save_snapshot(&s).await.unwrap();
        store.save_annotation(&a).await.unwrap();
    }
    confirm(&a_store, &s, &a).await;
    // Same text from another machine changes timestamps, never imports local confirmation.
    let mut received = a.clone();
    received.updated_at = Utc::now();
    for store in [&a_store, &b_store] {
        store.save_annotation(&received).await.unwrap();
    }
    assert_eq!(
        a_store.knowledge_states(s.source_id).await.unwrap()[0].status,
        KnowledgeStatus::Confirmed
    );
    assert_eq!(
        b_store.knowledge_states(s.source_id).await.unwrap()[0].status,
        KnowledgeStatus::PendingReview
    );
    s.id = Uuid::new_v4();
    s.captured_at = Utc::now();
    s.schemas[0].tables[1].comment = Some("unrelated".into());
    s.canonicalize().unwrap();
    a_store.save_snapshot(&s).await.unwrap();
    assert_eq!(
        a_store.knowledge_states(s.source_id).await.unwrap()[0].status,
        KnowledgeStatus::Confirmed
    );
    s.id = Uuid::new_v4();
    s.captured_at = Utc::now();
    s.schemas[0].tables[0].comment = Some("related".into());
    s.canonicalize().unwrap();
    a_store.save_snapshot(&s).await.unwrap();
    assert_eq!(
        a_store.knowledge_states(s.source_id).await.unwrap()[0].status,
        KnowledgeStatus::PendingReview
    );
    a_store.save_annotation(&received).await.unwrap();
    assert_eq!(
        a_store.knowledge_states(s.source_id).await.unwrap()[0].status,
        KnowledgeStatus::PendingReview
    );
}
#[tokio::test]
async fn deleting_and_recreating_same_named_object_never_revives_old_confirmation() {
    let store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
    let original = snapshot(Uuid::new_v4());
    store.save_snapshot(&original).await.unwrap();
    let a = annotation(original.source_id);
    store.save_annotation(&a).await.unwrap();
    confirm(&store, &original, &a).await;
    let mut deleted = original.clone();
    deleted.id = Uuid::new_v4();
    deleted.captured_at = Utc::now();
    deleted.schemas[0].tables.remove(0);
    deleted.canonicalize().unwrap();
    store.save_snapshot(&deleted).await.unwrap();
    assert_eq!(
        store.knowledge_states(original.source_id).await.unwrap()[0].status,
        KnowledgeStatus::Unavailable
    );
    let mut restored = original.clone();
    restored.id = Uuid::new_v4();
    restored.captured_at = Utc::now();
    restored.schemas[0].tables[1].comment = Some("new collection".into());
    restored.canonicalize().unwrap();
    store.save_snapshot(&restored).await.unwrap();
    assert_eq!(
        store.knowledge_states(original.source_id).await.unwrap()[0].status,
        KnowledgeStatus::PendingReview
    );
}
#[tokio::test]
async fn repeated_confirmation_is_idempotent_and_edit_then_revert_does_not_restore_validity() {
    let store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
    let s = snapshot(Uuid::new_v4());
    store.save_snapshot(&s).await.unwrap();
    let mut a = annotation(s.source_id);
    store.save_annotation(&a).await.unwrap();
    let version = annotation_version(Some(&a));
    let basis = KnowledgeBasis::from_tables(&s, std::slice::from_ref(&a.object_key), &[]);
    let id = Uuid::new_v4();
    let one = store
        .confirm_knowledge(
            id,
            s.source_id,
            &a.object_key,
            &version,
            &basis,
            "May be a record",
            &origin(),
        )
        .await
        .unwrap();
    let two = store
        .confirm_knowledge(
            id,
            s.source_id,
            &a.object_key,
            &version,
            &basis,
            "May be a record",
            &origin(),
        )
        .await
        .unwrap();
    assert_eq!(one, two);
    a.description = Some("Edited external text".into());
    store.save_annotation(&a).await.unwrap();
    store.save_annotation(&one).await.unwrap();
    assert_eq!(
        store.knowledge_states(s.source_id).await.unwrap()[0].status,
        KnowledgeStatus::PendingReview
    );
}

#[tokio::test]
async fn dependent_team_notes_downgrade_and_circular_confirmation_is_rejected() {
    use semantic_model::knowledge::digest;
    let store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
    let s = snapshot(Uuid::new_v4());
    store.save_snapshot(&s).await.unwrap();
    let a = annotation(s.source_id);
    let mut b = a.clone();
    b.object_key = ObjectKey::table("public", "other");
    b.description = Some("Supporting team statement".into());
    store.save_annotation(&a).await.unwrap();
    store.save_annotation(&b).await.unwrap();
    confirm(&store, &s, &b).await;
    let b_record = store
        .knowledge_states(s.source_id)
        .await
        .unwrap()
        .into_iter()
        .find(|state| state.object_key == b.object_key)
        .unwrap()
        .confirmation
        .unwrap();
    let mut basis =
        KnowledgeBasis::from_tables(&s, &[a.object_key.clone(), b.object_key.clone()], &[]);
    basis
        .notes
        .push((b.object_key.clone(), b_record.id, digest(&b.description)));
    store
        .confirm_knowledge(
            Uuid::new_v4(),
            s.source_id,
            &a.object_key,
            &annotation_version(Some(&a)),
            &basis,
            a.description.as_deref().unwrap(),
            &origin(),
        )
        .await
        .unwrap();
    let a_record = store
        .knowledge_states(s.source_id)
        .await
        .unwrap()
        .into_iter()
        .find(|state| state.object_key == a.object_key)
        .unwrap()
        .confirmation
        .unwrap();
    let mut reverse =
        KnowledgeBasis::from_tables(&s, &[a.object_key.clone(), b.object_key.clone()], &[]);
    reverse.notes.push((
        a.object_key.clone(),
        a_record.id,
        a_record.description_digest,
    ));
    let b_current = store
        .list_annotations(s.source_id)
        .await
        .unwrap()
        .into_iter()
        .find(|v| v.object_key == b.object_key)
        .unwrap();
    assert!(
        store
            .confirm_knowledge(
                Uuid::new_v4(),
                s.source_id,
                &b.object_key,
                &annotation_version(Some(&b_current)),
                &reverse,
                "Circular dependency",
                &origin()
            )
            .await
            .is_err()
    );
    b.description = Some("Changed by another author".into());
    store.save_annotation(&b).await.unwrap();
    assert!(
        store
            .knowledge_states(s.source_id)
            .await
            .unwrap()
            .iter()
            .all(|state| state.status == KnowledgeStatus::PendingReview)
    );
}

#[tokio::test]
async fn relationship_bookkeeping_preserves_confirmation_but_structural_edits_never_revive_it() {
    use schema_model::{
        LogicalRelationship, LogicalRelationshipOrigin, LogicalRelationshipStatus,
        RelationshipCardinality, RelationshipEndpoint,
    };
    let store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
    let s = snapshot(Uuid::new_v4());
    store.save_snapshot(&s).await.unwrap();
    let a = annotation(s.source_id);
    store.save_annotation(&a).await.unwrap();
    let mut relationship = LogicalRelationship {
        id: Uuid::new_v4(),
        source_id: s.source_id,
        name: "Relationship".into(),
        source: RelationshipEndpoint::new("public", "orders", vec!["id".into()]),
        target: RelationshipEndpoint::new("public", "other", vec!["id".into()]),
        cardinality: RelationshipCardinality::Unspecified,
        status: LogicalRelationshipStatus::Active,
        origin: LogicalRelationshipOrigin::Manual,
        note: None,
        evidence: vec![],
        created_at: Utc::now(),
        updated_at: Utc::now(),
    };
    store
        .save_logical_relationship(&relationship)
        .await
        .unwrap();
    let basis = KnowledgeBasis::from_tables(
        &s,
        &[a.object_key.clone(), ObjectKey::table("public", "other")],
        std::slice::from_ref(&relationship),
    );
    store
        .confirm_knowledge(
            Uuid::new_v4(),
            s.source_id,
            &a.object_key,
            &annotation_version(Some(&a)),
            &basis,
            a.description.as_deref().unwrap(),
            &origin(),
        )
        .await
        .unwrap();
    relationship.updated_at += chrono::Duration::seconds(1);
    relationship.name = "New display label".into();
    relationship.note = Some("Unconfirmed free text".into());
    store
        .save_logical_relationship(&relationship)
        .await
        .unwrap();
    assert_eq!(
        store.knowledge_states(s.source_id).await.unwrap()[0].status,
        KnowledgeStatus::Confirmed
    );
    relationship.status = LogicalRelationshipStatus::Disabled;
    store
        .save_logical_relationship(&relationship)
        .await
        .unwrap();
    // Reverting before any read still must not silently restore confirmation.
    relationship.status = LogicalRelationshipStatus::Active;
    store
        .save_logical_relationship(&relationship)
        .await
        .unwrap();
    assert_eq!(
        store.knowledge_states(s.source_id).await.unwrap()[0].status,
        KnowledgeStatus::PendingReview
    );
}

async fn confirmed_fixture() -> (LocalSnapshotStore, DatabaseSnapshot) {
    let store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
    let s = snapshot(Uuid::new_v4());
    store.save_snapshot(&s).await.unwrap();
    let a = annotation(s.source_id);
    store.save_annotation(&a).await.unwrap();
    confirm(&store, &s, &a).await;
    (store, s)
}
fn backup(s: DatabaseSnapshot, a: ObjectAnnotation) -> snapshot_store::PortableModelBackup {
    snapshot_store::PortableModelBackup {
        format_version: 1,
        exported_at: Utc::now().to_rfc3339(),
        source_id: s.source_id,
        source_profile: None,
        source_settings: settings_model::DataSourceSettings::defaults_for(s.source_id),
        snapshots: vec![s],
        annotations: vec![a],
        change_sets: vec![],
        domain_groups: vec![],
        saved_views: vec![],
        layouts: vec![],
        provenance: vec![],
        lineage: vec![],
        logical_relationships: vec![],
        ignored_relationship_inferences: vec![],
    }
}
fn profile(source: Uuid) -> schema_model::DataSourceProfile {
    schema_model::DataSourceProfile {
        id: source,
        display_name: "Original".into(),
        host: "old.example".into(),
        port: 5432,
        database: "app".into(),
        username: "reader".into(),
        database_type: DatabaseType::PostgreSql,
        ssl_mode: schema_model::SslMode::Prefer,
        security: schema_model::ConnectionSecurity::default(),
        created_at: Utc::now(),
        updated_at: Utc::now(),
    }
}
#[tokio::test]
async fn history_deletion_is_durable_without_an_intervening_knowledge_read() {
    let (store, mut s) = confirmed_fixture().await;
    store
        .delete_source_data(s.source_id, false, true, false)
        .await
        .unwrap();
    s.id = Uuid::new_v4();
    s.captured_at = Utc::now();
    store.save_snapshot(&s).await.unwrap();
    assert_eq!(
        store.knowledge_states(s.source_id).await.unwrap()[0].status,
        KnowledgeStatus::PendingReview
    );
}
#[tokio::test]
async fn portable_structure_changes_remain_invalid_after_restore_without_a_read() {
    for restore_via_import in [false, true] {
        let (store, s) = confirmed_fixture().await;
        let a = store.list_annotations(s.source_id).await.unwrap().remove(0);
        // An unchanged import and retention of the current model preserve local proof.
        store
            .import_portable_model(&backup(s.clone(), a.clone()))
            .await
            .unwrap();
        store
            .prune_snapshots(s.source_id, Some(1), None, false)
            .await
            .unwrap();
        assert_eq!(
            store.knowledge_states(s.source_id).await.unwrap()[0].status,
            KnowledgeStatus::Confirmed
        );
        let mut missing = s.clone();
        missing.id = Uuid::new_v4();
        missing.captured_at = Utc::now();
        missing.schemas[0].tables.retain(|t| t.key != a.object_key);
        missing.canonicalize().unwrap();
        store
            .import_portable_model(&backup(missing, a.clone()))
            .await
            .unwrap();
        // Deliberately do not read validity between the two mutations.
        let mut restored = s.clone();
        restored.id = Uuid::new_v4();
        restored.captured_at = Utc::now();
        restored.schemas[0]
            .tables
            .iter_mut()
            .find(|t| t.key.name == "other")
            .unwrap()
            .comment = Some("unrelated".into());
        restored.canonicalize().unwrap();
        if restore_via_import {
            store
                .import_portable_model(&backup(restored, a))
                .await
                .unwrap();
        } else {
            store.save_snapshot(&restored).await.unwrap();
        }
        assert_eq!(
            store.knowledge_states(s.source_id).await.unwrap()[0].status,
            KnowledgeStatus::PendingReview
        );
    }
}
#[tokio::test]
async fn connection_identity_changes_invalidate_confirmation_and_prepared_basis() {
    for field in ["host", "port", "database", "username", "type"] {
        let store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
        let s = snapshot(Uuid::new_v4());
        let original = profile(s.source_id);
        store.save_verified_source(&original, &s).await.unwrap();
        let a = annotation(s.source_id);
        store.save_annotation(&a).await.unwrap();
        confirm(&store, &s, &a).await;
        let previous = store.knowledge_states(s.source_id).await.unwrap()[0]
            .confirmation
            .clone()
            .unwrap();
        let mut renamed = original.clone();
        renamed.display_name = "Renamed".into();
        renamed.updated_at = Utc::now();
        renamed.ssl_mode = schema_model::SslMode::Require;
        store.save_data_source(&renamed).await.unwrap();
        assert_eq!(
            store.knowledge_states(s.source_id).await.unwrap()[0].status,
            KnowledgeStatus::Confirmed
        );
        let mut changed = renamed;
        match field {
            "host" => changed.host = "replacement.example".into(),
            "port" => changed.port += 1,
            "database" => changed.database = "replacement".into(),
            "username" => changed.username = "different-reader".into(),
            _ => changed.database_type = DatabaseType::MySql,
        }
        // Identical snapshot/fingerprint must not preserve confirmation on a different endpoint.
        store.save_verified_source(&changed, &s).await.unwrap();
        let current = store.list_annotations(s.source_id).await.unwrap().remove(0);
        assert!(
            store
                .confirm_knowledge(
                    Uuid::new_v4(),
                    s.source_id,
                    &current.object_key,
                    &annotation_version(Some(&current)),
                    &previous.basis,
                    "Stale draft",
                    &origin()
                )
                .await
                .is_err()
        );
        // Reverting the connection without a validity read cannot revive the old record.
        store.save_data_source(&original).await.unwrap();
        assert_eq!(
            store.knowledge_states(s.source_id).await.unwrap()[0].status,
            KnowledgeStatus::PendingReview
        );
    }
}

#[tokio::test]
async fn unchanged_capture_returns_persisted_current_id_and_allows_review_after_identity_change() {
    let store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
    let s = snapshot(Uuid::new_v4());
    let original = profile(s.source_id);
    store.save_verified_source(&original, &s).await.unwrap();
    let a = annotation(s.source_id);
    store.save_annotation(&a).await.unwrap();
    confirm(&store, &s, &a).await;
    let mut repeated = s.clone();
    repeated.id = Uuid::new_v4();
    repeated.captured_at = s.captured_at + chrono::Duration::seconds(1);
    let unchanged = store.save_captured_snapshot(&repeated).await.unwrap();
    assert!(!unchanged.stored);
    assert_eq!(unchanged.snapshot, s);
    assert!(unchanged.change_set.is_none());
    assert_eq!(
        store.knowledge_states(s.source_id).await.unwrap()[0].status,
        KnowledgeStatus::Confirmed
    );
    let mut candidate = original;
    candidate.host = "replacement.example".into();
    let accepted = store
        .save_verified_source(&candidate, &repeated)
        .await
        .unwrap();
    assert!(!accepted.stored);
    assert_eq!(
        store.get_snapshot(accepted.snapshot.id).await.unwrap(),
        Some(s.clone())
    );
    assert_eq!(
        store.latest_snapshot(s.source_id).await.unwrap(),
        Some(accepted.snapshot.clone())
    );
    assert_eq!(
        store.list_snapshots(s.source_id).await.unwrap()[0].id,
        accepted.snapshot.id
    );
    assert_eq!(
        store.knowledge_states(s.source_id).await.unwrap()[0].status,
        KnowledgeStatus::PendingReview
    );
    let current = store.list_annotations(s.source_id).await.unwrap().remove(0);
    let mut basis =
        KnowledgeBasis::from_tables(&accepted.snapshot, std::slice::from_ref(&a.object_key), &[]);
    basis.source_identity = Some(semantic_model::knowledge::source_identity(Some(&candidate)));
    store
        .confirm_knowledge(
            Uuid::new_v4(),
            s.source_id,
            &a.object_key,
            &annotation_version(Some(&current)),
            &basis,
            "Reviewed on the replacement database",
            &origin(),
        )
        .await
        .unwrap();
    assert_eq!(
        store.knowledge_states(s.source_id).await.unwrap()[0].status,
        KnowledgeStatus::Confirmed
    );
    assert_eq!(store.list_snapshots(s.source_id).await.unwrap().len(), 1);
    assert_eq!(store.pending_sync().await.unwrap().len(), 1);
}

#[tokio::test]
async fn return_to_prior_structure_is_a_new_current_capture_with_history_and_outbox() {
    let store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
    let first = snapshot(Uuid::new_v4());
    let original = profile(first.source_id);
    store.save_verified_source(&original, &first).await.unwrap();
    let a = annotation(first.source_id);
    store.save_annotation(&a).await.unwrap();
    confirm(&store, &first, &a).await;
    let mut middle = first.clone();
    middle.id = Uuid::new_v4();
    middle.captured_at = first.captured_at + chrono::Duration::seconds(1);
    middle.schemas[0]
        .tables
        .iter_mut()
        .find(|t| t.key == a.object_key)
        .unwrap()
        .columns
        .push(schema_model::ColumnDefinition {
            name: "temporary_field".into(),
            ordinal_position: 1,
            formatted_type: "text".into(),
            type_schema: "pg_catalog".into(),
            type_name: "text".into(),
            nullable: true,
            default_value: None,
            identity: None,
            generated: false,
            comment: None,
        });
    middle.canonicalize().unwrap();
    let middle_capture = store.save_captured_snapshot(&middle).await.unwrap();
    let mut restored = first.clone();
    restored.id = Uuid::new_v4();
    restored.captured_at = first.captured_at + chrono::Duration::seconds(2);
    let mut candidate = original;
    candidate.host = "replacement.example".into();
    let accepted = store
        .save_verified_source(&candidate, &restored)
        .await
        .unwrap();
    assert!(accepted.stored);
    assert_eq!(accepted.snapshot, restored);
    assert_eq!(
        store.latest_snapshot(first.source_id).await.unwrap(),
        Some(restored.clone())
    );
    assert_eq!(
        store.get_snapshot(first.id).await.unwrap(),
        Some(first.clone())
    );
    assert_eq!(
        store.list_snapshots(first.source_id).await.unwrap().len(),
        3
    );
    let change = accepted.change_set.unwrap();
    assert_eq!(change.before_snapshot_id, middle.id);
    assert_eq!(change.after_snapshot_id, restored.id);
    assert!(!change.operations.is_empty());
    assert_eq!(
        store.knowledge_states(first.source_id).await.unwrap()[0].status,
        KnowledgeStatus::PendingReview
    );
    let queue = store.pending_sync().await.unwrap();
    assert_eq!(queue.len(), 3);
    assert!(
        queue
            .iter()
            .any(|event| event.payload["snapshot"]["id"] == restored.id.to_string())
    );
    let mut duplicate = restored.clone();
    duplicate.id = Uuid::new_v4();
    duplicate.captured_at += chrono::Duration::seconds(1);
    let unchanged = store.save_captured_snapshot(&duplicate).await.unwrap();
    assert!(!unchanged.stored);
    assert_eq!(unchanged.snapshot.id, restored.id);
    assert_eq!(store.pending_sync().await.unwrap(), queue);
    // Repeated fingerprints keep distinct immutable IDs and valid portable history references.
    let mut portable = backup(restored.clone(), a);
    portable.source_profile = Some(candidate);
    portable.snapshots = vec![first, middle, restored.clone()];
    portable.change_sets = vec![middle_capture.change_set.unwrap(), change];
    let receiver = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
    receiver.import_portable_model(&portable).await.unwrap();
    assert_eq!(
        receiver.latest_snapshot(portable.source_id).await.unwrap(),
        Some(restored)
    );
    assert_eq!(
        receiver
            .list_snapshots(portable.source_id)
            .await
            .unwrap()
            .len(),
        3
    );
    assert_eq!(
        receiver.knowledge_states(portable.source_id).await.unwrap()[0].status,
        KnowledgeStatus::PendingReview
    );
}

#[tokio::test]
async fn version_four_migration_preserves_history_proof_and_foreign_keys() {
    let path = std::env::temp_dir().join(format!("nodal-v4-history-{}.sqlite", Uuid::new_v4()));
    let store = LocalSnapshotStore::open_path(&path).await.unwrap();
    let first = snapshot(Uuid::new_v4());
    let source = profile(first.source_id);
    store.save_verified_source(&source, &first).await.unwrap();
    let a = annotation(first.source_id);
    store.save_annotation(&a).await.unwrap();
    confirm(&store, &first, &a).await;
    let proof = store.knowledge_states(first.source_id).await.unwrap()[0]
        .confirmation
        .clone();
    let mut second = first.clone();
    second.id = Uuid::new_v4();
    second.captured_at += chrono::Duration::seconds(1);
    second.schemas[0]
        .tables
        .iter_mut()
        .find(|t| t.key.name == "other")
        .unwrap()
        .comment = Some("Unrelated change".into());
    second.canonicalize().unwrap();
    let capture = store.save_captured_snapshot(&second).await.unwrap();
    let before_history = store.list_snapshots(first.source_id).await.unwrap();
    let before_queue = store.pending_sync().await.unwrap();
    let db = sqlx::SqlitePool::connect(&format!("sqlite:{}", path.display()))
        .await
        .unwrap();
    // Reproduce v4's full-history uniqueness with populated, referenced snapshots.
    sqlx::query("CREATE UNIQUE INDEX v4_fingerprint ON schema_snapshots(source_id,fingerprint)")
        .execute(&db)
        .await
        .unwrap();
    sqlx::query("PRAGMA user_version=4")
        .execute(&db)
        .await
        .unwrap();
    db.close().await;
    store.close().await;
    let migrated = LocalSnapshotStore::open_path(&path).await.unwrap();
    assert!(path.with_extension("pre-v4.bak").exists());
    assert_eq!(
        migrated.list_snapshots(first.source_id).await.unwrap(),
        before_history
    );
    assert_eq!(
        migrated.get_snapshot(first.id).await.unwrap(),
        Some(first.clone())
    );
    assert_eq!(migrated.pending_sync().await.unwrap(), before_queue);
    let state = migrated
        .knowledge_states(first.source_id)
        .await
        .unwrap()
        .remove(0);
    assert_eq!(state.status, KnowledgeStatus::Confirmed);
    assert_eq!(state.confirmation, proof);
    let mut invalid = capture.change_set.unwrap();
    invalid.id = Uuid::new_v4();
    invalid.after_snapshot_id = Uuid::new_v4();
    assert!(migrated.save_change_set(&invalid).await.is_err());
    let mut returned = first;
    returned.id = Uuid::new_v4();
    returned.captured_at = second.captured_at + chrono::Duration::seconds(1);
    assert!(
        migrated
            .save_captured_snapshot(&returned)
            .await
            .unwrap()
            .stored
    );
    assert_eq!(
        migrated.latest_snapshot(returned.source_id).await.unwrap(),
        Some(returned.clone())
    );
    migrated.close().await;
    let reopened = LocalSnapshotStore::open_path(&path).await.unwrap();
    assert_eq!(
        reopened.latest_snapshot(returned.source_id).await.unwrap(),
        Some(returned)
    );
    reopened.close().await;
    std::fs::remove_file(&path).unwrap();
    std::fs::remove_file(path.with_extension("pre-v4.bak")).unwrap();
}

#[tokio::test]
async fn failed_history_migration_rolls_back_without_dropping_existing_records() {
    let path = std::env::temp_dir().join(format!("nodal-v4-invalid-{}.sqlite", Uuid::new_v4()));
    let store = LocalSnapshotStore::open_path(&path).await.unwrap();
    let snapshot = snapshot(Uuid::new_v4());
    store.save_snapshot(&snapshot).await.unwrap();
    let db = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect(&format!("sqlite:{}", path.display()))
        .await
        .unwrap();
    sqlx::query("PRAGMA foreign_keys=OFF")
        .execute(&db)
        .await
        .unwrap();
    sqlx::query("CREATE UNIQUE INDEX v4_fingerprint ON schema_snapshots(source_id,fingerprint)")
        .execute(&db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO schema_change_sets VALUES ('broken','missing','missing','now','{}')")
        .execute(&db)
        .await
        .unwrap();
    sqlx::query("PRAGMA user_version=4")
        .execute(&db)
        .await
        .unwrap();
    store.close().await;
    assert!(LocalSnapshotStore::open_path(&path).await.is_err());
    assert_eq!(
        sqlx::query_scalar::<_, i64>("PRAGMA user_version")
            .fetch_one(&db)
            .await
            .unwrap(),
        4
    );
    let stored: String = sqlx::query_scalar("SELECT payload_json FROM schema_snapshots WHERE id=?")
        .bind(snapshot.id.to_string())
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_str::<DatabaseSnapshot>(&stored).unwrap(),
        snapshot
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM sqlite_master WHERE name='v4_fingerprint'"
        )
        .fetch_one(&db)
        .await
        .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM schema_change_sets")
            .fetch_one(&db)
            .await
            .unwrap(),
        1
    );
    db.close().await;
    std::fs::remove_file(&path).unwrap();
    std::fs::remove_file(path.with_extension("pre-v4.bak")).unwrap();
}
#[tokio::test]
async fn failed_verified_storage_transaction_preserves_profile_snapshot_and_confirmation() {
    for (table, operation) in [
        ("schema_snapshots", "INSERT"),
        ("schema_change_sets", "INSERT"),
        ("sync_queue", "INSERT"),
        ("schema_snapshots", "DELETE"),
    ] {
        let path = std::env::temp_dir().join(format!("nodal-knowledge-{}.sqlite", Uuid::new_v4()));
        let store = LocalSnapshotStore::open_path(&path).await.unwrap();
        let s = snapshot(Uuid::new_v4());
        let original = profile(s.source_id);
        store.save_verified_source(&original, &s).await.unwrap();
        let a = annotation(s.source_id);
        store.save_annotation(&a).await.unwrap();
        confirm(&store, &s, &a).await;
        let mut settings = settings_model::DataSourceSettings::defaults_for(s.source_id);
        settings.storage.retention = settings_model::RetentionPolicy::Count;
        settings.storage.retention_value = 1;
        settings.storage.preserve_high_risk = false;
        store.save_data_source_settings(&settings).await.unwrap();
        let queued = store.pending_sync().await.unwrap();
        let db = sqlx::SqlitePool::connect(&format!("sqlite:{}", path.display()))
            .await
            .unwrap();
        sqlx::query(sqlx::AssertSqlSafe(format!("CREATE TRIGGER fail_capture BEFORE {operation} ON {table} BEGIN SELECT RAISE(ABORT, 'test persistence failure'); END"))).execute(&db).await.unwrap();
        let mut changed = original.clone();
        changed.host = "replacement.example".into();
        let mut next = s.clone();
        next.id = Uuid::new_v4();
        next.captured_at = Utc::now();
        next.database.version = "18".into();
        next.canonicalize().unwrap();
        assert!(
            store.save_verified_source(&changed, &next).await.is_err(),
            "{operation} {table}"
        );
        assert_eq!(
            store.get_data_source(s.source_id).await.unwrap(),
            Some(original)
        );
        assert_eq!(
            store
                .latest_snapshot(s.source_id)
                .await
                .unwrap()
                .unwrap()
                .id,
            s.id
        );
        assert_eq!(store.pending_sync().await.unwrap(), queued);
        assert_eq!(
            store.knowledge_states(s.source_id).await.unwrap()[0].status,
            KnowledgeStatus::Confirmed
        );
        db.close().await;
        store.close().await;
        std::fs::remove_file(path).unwrap();
    }
}
#[tokio::test]
async fn dotted_schema_independent_objects_are_unavailable_and_cannot_be_confirmed() {
    use schema_model::{EnumDefinition, ObjectKind, ViewDefinition};
    use semantic_model::knowledge::owning_table;
    let store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
    let mut s = snapshot(Uuid::new_v4());
    let view = ObjectKey::new(ObjectKind::View, "public.orders", "reporting_view");
    let enumeration = ObjectKey::new(ObjectKind::Enum, "public.orders", "status");
    s.schemas.push(SchemaDefinition {
        name: "public.orders".into(),
        tables: vec![],
        views: vec![ViewDefinition {
            key: view.clone(),
            definition: "SELECT 1".into(),
            materialized: false,
            comment: None,
        }],
        enums: vec![EnumDefinition {
            key: enumeration.clone(),
            values: vec!["ok".into()],
        }],
    });
    s.canonicalize().unwrap();
    store.save_snapshot(&s).await.unwrap();
    for key in [
        view,
        enumeration,
        ObjectKey::new(ObjectKind::Schema, "public.orders", "public.orders"),
    ] {
        assert!(semantic_model::known_object_keys(&s).contains(&key));
        assert_eq!(owning_table(&s, &key), None);
        let mut a = annotation(s.source_id);
        a.object_key = key.clone();
        store.save_annotation(&a).await.unwrap();
        assert!(
            store
                .confirm_knowledge(
                    Uuid::new_v4(),
                    s.source_id,
                    &key,
                    &annotation_version(Some(&a)),
                    &KnowledgeBasis::from_tables(&s, &[ObjectKey::table("public", "orders")], &[]),
                    "Independent object",
                    &origin()
                )
                .await
                .is_err()
        );
    }
    assert!(
        store
            .knowledge_states(s.source_id)
            .await
            .unwrap()
            .iter()
            .all(|s| s.status == KnowledgeStatus::Unavailable)
    );
}
