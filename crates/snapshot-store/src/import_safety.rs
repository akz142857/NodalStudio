//! Portable data cannot transfer ownership of existing local records.
use crate::{PortableModelBackup, SnapshotStoreError};
use sqlx::SqliteConnection;
use std::collections::BTreeSet;
use uuid::Uuid;

fn conflict() -> SnapshotStoreError {
    SnapshotStoreError::ReviewConflict(
        "The backup contains conflicting object ownership or references; nothing was imported."
            .into(),
    )
}

pub(super) async fn validate(
    connection: &mut SqliteConnection,
    bundle: &PortableModelBackup,
) -> Result<(), SnapshotStoreError> {
    let source = bundle.source_id;
    if bundle.source_settings.source_id != source
        || bundle
            .source_profile
            .as_ref()
            .is_some_and(|p| p.id != source)
        || bundle.annotations.iter().any(|a| a.source_id != source)
        || bundle.layouts.iter().any(|l| l.source_id != source)
        || bundle
            .ignored_relationship_inferences
            .iter()
            .any(|i| i.source_id != source)
    {
        return Err(conflict());
    }
    for (query, objects) in [
        (
            "SELECT source_id FROM schema_snapshots WHERE id = ?",
            bundle
                .snapshots
                .iter()
                .map(|v| (v.id, v.source_id))
                .collect::<Vec<_>>(),
        ),
        (
            "SELECT source_id FROM domain_groups WHERE id = ?",
            bundle
                .domain_groups
                .iter()
                .map(|v| (v.id, v.source_id))
                .collect(),
        ),
        (
            "SELECT source_id FROM saved_views WHERE id = ?",
            bundle
                .saved_views
                .iter()
                .map(|v| (v.id, v.source_id))
                .collect(),
        ),
        (
            "SELECT source_id FROM logical_relationships WHERE id = ?",
            bundle
                .logical_relationships
                .iter()
                .map(|v| (v.id, v.source_id))
                .collect(),
        ),
    ] {
        let mut seen = BTreeSet::new();
        for (id, owner) in objects {
            if owner != source || !seen.insert(id) {
                return Err(conflict());
            }
            let existing: Option<String> = sqlx::query_scalar(query)
                .bind(id.to_string())
                .fetch_optional(&mut *connection)
                .await?;
            if existing.is_some_and(|owner| owner != source.to_string()) {
                return Err(conflict());
            }
        }
    }
    validate_changes(connection, bundle).await?;
    for layout in &bundle.layouts {
        if let Some(id) = layout.view_id {
            if bundle.saved_views.iter().any(|v| v.id == id) {
                continue;
            }
            let owner: Option<String> =
                sqlx::query_scalar("SELECT source_id FROM saved_views WHERE id = ?")
                    .bind(id.to_string())
                    .fetch_optional(&mut *connection)
                    .await?;
            if owner.as_deref() != Some(source.to_string().as_str()) {
                return Err(conflict());
            }
        }
    }
    Ok(())
}

async fn validate_changes(
    connection: &mut SqliteConnection,
    bundle: &PortableModelBackup,
) -> Result<(), SnapshotStoreError> {
    let source = bundle.source_id;
    let snapshots: BTreeSet<Uuid> = bundle.snapshots.iter().map(|s| s.id).collect();
    let mut changes = BTreeSet::new();
    for change in &bundle.change_sets {
        if !changes.insert(change.id)
            || !snapshots.contains(&change.before_snapshot_id)
            || !snapshots.contains(&change.after_snapshot_id)
        {
            return Err(conflict());
        }
        let owners: Option<(String, String)> = sqlx::query_as("SELECT b.source_id, a.source_id FROM schema_change_sets c JOIN schema_snapshots b ON b.id = c.before_snapshot_id JOIN schema_snapshots a ON a.id = c.after_snapshot_id WHERE c.id = ?")
            .bind(change.id.to_string()).fetch_optional(&mut *connection).await?;
        if owners.is_some_and(|(before, after)| {
            before != source.to_string() || after != source.to_string()
        }) {
            return Err(conflict());
        }
    }
    if bundle
        .provenance
        .iter()
        .any(|p| !changes.contains(&p.change_set_id))
    {
        return Err(conflict());
    }
    Ok(())
}
