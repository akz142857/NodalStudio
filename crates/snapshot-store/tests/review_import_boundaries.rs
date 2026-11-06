//! Regression coverage for untrusted portable imports.
use chrono::Utc;
use schema_model::{DataSourceProfile, DatabaseType, SslMode};
use semantic_model::DomainGroup;
use settings_model::DataSourceSettings;
use snapshot_store::{LocalSnapshotStore, PortableModelBackup};
use uuid::Uuid;

fn profile(id: Uuid, host: &str) -> DataSourceProfile {
    DataSourceProfile {
        id,
        display_name: "Existing source".into(),
        host: host.into(),
        port: 5432,
        database: "app".into(),
        username: "reader".into(),
        database_type: DatabaseType::PostgreSql,
        ssl_mode: SslMode::Disable,
        security: schema_model::ConnectionSecurity::default(),
        sqlite: None,
        created_at: Utc::now(),
        updated_at: Utc::now(),
    }
}

fn bundle(id: Uuid) -> PortableModelBackup {
    PortableModelBackup {
        format_version: 1,
        exported_at: Utc::now().to_rfc3339(),
        source_id: id,
        source_profile: Some(profile(id, "original.invalid")),
        source_settings: DataSourceSettings::defaults_for(id),
        snapshots: vec![],
        change_sets: vec![],
        annotations: vec![],
        domain_groups: vec![],
        saved_views: vec![],
        layouts: vec![],
        provenance: vec![],
        lineage: vec![],
        logical_relationships: vec![],
        ignored_relationship_inferences: vec![],
    }
}

#[tokio::test]
async fn importing_b_must_not_remove_a_domain_group() {
    let store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
    let a = Uuid::new_v4();
    let b = Uuid::new_v4();
    let original = DomainGroup {
        id: Uuid::new_v4(),
        source_id: a,
        name: "Source A work".into(),
        description: None,
        color: "#112233".into(),
        table_keys: vec![],
        updated_at: Utc::now(),
    };
    store.save_domain_group(&original).await.unwrap();
    let mut incoming = bundle(b);
    incoming.domain_groups.push(DomainGroup {
        source_id: b,
        name: "Imported B work".into(),
        ..original.clone()
    });
    incoming.source_settings.validate().unwrap();
    assert!(
        incoming
            .domain_groups
            .iter()
            .all(|g| g.source_id == incoming.source_id)
    );
    assert!(store.import_portable_model(&incoming).await.is_err());
    assert!(store.get_data_source(b).await.unwrap().is_none());
    assert!(
        store
            .save_domain_group(&incoming.domain_groups[0])
            .await
            .is_err()
    );
    assert_eq!(store.list_domain_groups(a).await.unwrap(), vec![original]);
}

#[tokio::test]
async fn portable_import_must_not_retarget_an_existing_credential_identity_for_auto_connect() {
    let store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
    let id = Uuid::new_v4();
    let profile_with_original_timestamps = profile(id, "original.invalid");
    let mut local_settings = DataSourceSettings::defaults_for(id);
    local_settings.ai.endpoint = "https://local-ai.invalid".into();
    local_settings.ai.credential_configured = true;
    local_settings.cloud.endpoint = "https://local-cloud.invalid".into();
    local_settings.cloud.credential_configured = true;
    store
        .save_data_source_settings(&local_settings)
        .await
        .unwrap();
    store
        .save_data_source(&profile_with_original_timestamps)
        .await
        .unwrap();
    let mut incoming = bundle(id);
    incoming.source_profile.as_mut().unwrap().host = "replacement.invalid".into();
    incoming.source_settings.refresh.auto_connect = true;
    incoming.source_settings.ai.endpoint = "https://replacement-ai.invalid".into();
    incoming.source_settings.cloud.endpoint = "https://replacement-cloud.invalid".into();
    incoming.source_settings.validate().unwrap();
    store.import_portable_model(&incoming).await.unwrap();
    let restored = store.get_data_source(id).await.unwrap().unwrap();
    let settings = store.get_data_source_settings(id).await.unwrap();
    assert_eq!(restored, profile_with_original_timestamps);
    assert!(!settings.refresh.auto_connect);
    assert_eq!(settings.ai, local_settings.ai);
    assert_eq!(settings.cloud, local_settings.cloud);
    assert_eq!(settings.git, local_settings.git);
}

#[tokio::test]
async fn unknown_network_sources_import_as_offline_models_without_service_bindings() {
    let store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
    let id = Uuid::new_v4();
    let mut incoming = bundle(id);
    incoming.source_settings.refresh.auto_connect = true;
    incoming.source_settings.ai.endpoint = "https://untrusted.invalid".into();
    incoming.source_settings.cloud.endpoint = "https://untrusted.invalid".into();
    store.import_portable_model(&incoming).await.unwrap();
    let profile = store.get_data_source(id).await.unwrap().unwrap();
    assert!(profile.host.is_empty());
    assert!(profile.username.is_empty());
    assert_eq!(profile.port, 0);
    assert_eq!(profile.database, "app");
    assert_eq!(
        profile.security,
        schema_model::ConnectionSecurity::default()
    );
    let settings = store.get_data_source_settings(id).await.unwrap();
    assert!(!settings.refresh.auto_connect);
    assert_eq!(settings.ai, settings_model::AiSettings::default());
    assert_eq!(settings.cloud, settings_model::CloudSettings::default());
}

fn snapshot(source_id: Uuid) -> schema_model::DatabaseSnapshot {
    let mut snapshot = schema_model::DatabaseSnapshot::new(
        source_id,
        schema_model::DatabaseInfo {
            name: "app".into(),
            database_type: DatabaseType::PostgreSql,
            version: "17".into(),
        },
        vec![],
    );
    snapshot.canonicalize().unwrap();
    snapshot
}

#[tokio::test]
async fn global_object_collisions_and_foreign_view_references_reject_the_whole_import() {
    use schema_model::LogicalRelationship;
    use semantic_model::{CanvasLayout, SavedView};
    let store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
    let a = Uuid::new_v4();
    let b = Uuid::new_v4();
    let snap = snapshot(a);
    store.save_snapshot(&snap).await.unwrap();
    let view = SavedView {
        id: Uuid::new_v4(),
        source_id: a,
        name: "A".into(),
        root_table_keys: vec![],
        relationship_depth: 1,
        updated_at: Utc::now(),
    };
    store.save_view(&view).await.unwrap();
    let relation = relationship(a);
    store.save_logical_relationship(&relation).await.unwrap();
    let change = schema_diff::diff_snapshots(&snap, &snap);
    store.save_change_set(&change).await.unwrap();
    for kind in 0..5 {
        let mut incoming = bundle(b);
        match kind {
            0 => incoming.snapshots.push(schema_model::DatabaseSnapshot {
                source_id: b,
                ..snap.clone()
            }),
            1 => incoming.saved_views.push(SavedView {
                source_id: b,
                ..view.clone()
            }),
            2 => incoming.logical_relationships.push(LogicalRelationship {
                source_id: b,
                ..relation.clone()
            }),
            3 => {
                let own = snapshot(b);
                incoming.change_sets.push(schema_diff::SchemaChangeSet {
                    before_snapshot_id: own.id,
                    after_snapshot_id: own.id,
                    ..change.clone()
                });
                incoming.snapshots.push(own);
            }
            _ => incoming.layouts.push(CanvasLayout {
                source_id: b,
                view_id: Some(view.id),
                positions: std::collections::BTreeMap::default(),
                viewport: None,
                updated_at: Utc::now(),
            }),
        }
        assert!(
            store.import_portable_model(&incoming).await.is_err(),
            "case {kind}"
        );
        assert!(store.get_data_source(b).await.unwrap().is_none());
        assert!(store.list_snapshots(b).await.unwrap().is_empty());
    }
    assert!(
        store
            .save_view(&SavedView {
                source_id: b,
                ..view.clone()
            })
            .await
            .is_err()
    );
    assert!(
        store
            .save_logical_relationship(&LogicalRelationship {
                source_id: b,
                ..relation.clone()
            })
            .await
            .is_err()
    );
    assert_eq!(store.list_views(a).await.unwrap(), vec![view]);
    assert_eq!(
        store.list_logical_relationships(a).await.unwrap(),
        vec![relation]
    );
    assert_eq!(store.get_snapshot(snap.id).await.unwrap().unwrap(), snap);
    assert_eq!(
        store.change_sets_for_snapshot(snap.id).await.unwrap(),
        vec![change]
    );
}

fn relationship(source_id: Uuid) -> schema_model::LogicalRelationship {
    use schema_model::{
        LogicalRelationshipOrigin, LogicalRelationshipStatus, RelationshipCardinality,
        RelationshipEndpoint,
    };
    schema_model::LogicalRelationship {
        id: Uuid::new_v4(),
        source_id,
        name: "A".into(),
        source: RelationshipEndpoint::new("public", "orders", vec!["user_id".into()]),
        target: RelationshipEndpoint::new("public", "users", vec!["id".into()]),
        cardinality: RelationshipCardinality::ManyToOne,
        status: LogicalRelationshipStatus::Active,
        origin: LogicalRelationshipOrigin::Manual,
        note: None,
        evidence: vec![],
        created_at: Utc::now(),
        updated_at: Utc::now(),
    }
}
