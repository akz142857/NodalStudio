//! User-authored meaning layered on top of immutable physical database snapshots.

use std::collections::{BTreeMap, BTreeSet};

use chrono::{DateTime, Utc};
use schema_model::{DatabaseSnapshot, ObjectKey, ObjectKind};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectAnnotation {
    pub source_id: Uuid,
    pub object_key: ObjectKey,
    pub description: Option<String>,
    pub tags: Vec<String>,
    pub owner: Option<String>,
    pub is_core: bool,
    pub updated_at: DateTime<Utc>,
}

impl ObjectAnnotation {
    pub fn canonicalize(&mut self) {
        self.tags.sort();
        self.tags.dedup();
        self.description = normalize_optional(self.description.take());
        self.owner = normalize_optional(self.owner.take());
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DomainGroup {
    pub id: Uuid,
    pub source_id: Uuid,
    pub name: String,
    pub description: Option<String>,
    pub color: String,
    pub table_keys: Vec<ObjectKey>,
    pub updated_at: DateTime<Utc>,
}

impl DomainGroup {
    pub fn canonicalize(&mut self) {
        self.table_keys.sort();
        self.table_keys.dedup();
        self.description = normalize_optional(self.description.take());
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedView {
    pub id: Uuid,
    pub source_id: Uuid,
    pub name: String,
    pub root_table_keys: Vec<ObjectKey>,
    pub relationship_depth: u8,
    pub updated_at: DateTime<Utc>,
}

impl SavedView {
    pub fn canonicalize(&mut self) {
        self.root_table_keys.sort();
        self.root_table_keys.dedup();
        self.relationship_depth = self.relationship_depth.min(3);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasPosition {
    pub x: f64,
    pub y: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasLayout {
    pub source_id: Uuid,
    pub view_id: Option<Uuid>,
    pub positions: BTreeMap<String, CanvasPosition>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReattachmentResult {
    pub attached_annotations: Vec<ObjectAnnotation>,
    pub orphaned_annotations: Vec<ObjectAnnotation>,
    pub attached_groups: Vec<DomainGroup>,
}

/// Separates semantic metadata that still points at physical objects from orphaned data.
pub fn reattach_semantics(
    snapshot: &DatabaseSnapshot,
    annotations: Vec<ObjectAnnotation>,
    groups: Vec<DomainGroup>,
) -> ReattachmentResult {
    let known = known_object_keys(snapshot);
    let (attached_annotations, orphaned_annotations) = annotations
        .into_iter()
        .partition(|annotation| known.contains(&annotation.object_key));
    let attached_groups = groups
        .into_iter()
        .map(|mut group| {
            group.table_keys.retain(|key| known.contains(key));
            group
        })
        .collect();
    ReattachmentResult {
        attached_annotations,
        orphaned_annotations,
        attached_groups,
    }
}

/// Returns every physical object key that can carry semantic metadata.
pub fn known_object_keys(snapshot: &DatabaseSnapshot) -> BTreeSet<ObjectKey> {
    let mut keys = BTreeSet::new();
    for schema in &snapshot.schemas {
        keys.insert(ObjectKey::new(
            ObjectKind::Schema,
            &schema.name,
            &schema.name,
        ));
        for table in &schema.tables {
            keys.insert(table.key.clone());
            for column in &table.columns {
                keys.insert(table.key.child(ObjectKind::Column, &column.name));
            }
            if let Some(primary_key) = &table.primary_key {
                keys.insert(table.key.child(ObjectKind::PrimaryKey, &primary_key.name));
            }
            for foreign_key in &table.foreign_keys {
                keys.insert(table.key.child(ObjectKind::ForeignKey, &foreign_key.name));
            }
            for index in &table.indexes {
                keys.insert(table.key.child(ObjectKind::Index, &index.name));
            }
            for constraint in &table.constraints {
                keys.insert(table.key.child(ObjectKind::Constraint, &constraint.name));
            }
        }
        keys.extend(schema.views.iter().map(|view| view.key.clone()));
        keys.extend(schema.enums.iter().map(|item| item.key.clone()));
    }
    keys
}

fn normalize_optional(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_owned())
    })
}

#[cfg(test)]
mod tests {
    use schema_model::{DatabaseInfo, DatabaseType, SchemaDefinition, TableDefinition};

    use super::*;

    fn snapshot() -> DatabaseSnapshot {
        DatabaseSnapshot::new(
            Uuid::nil(),
            DatabaseInfo {
                name: "app".into(),
                database_type: DatabaseType::PostgreSql,
                version: "17".into(),
            },
            vec![SchemaDefinition {
                name: "public".into(),
                tables: vec![TableDefinition::empty("public", "users")],
                views: Vec::new(),
                enums: Vec::new(),
            }],
        )
    }

    #[test]
    fn reattaches_existing_objects_and_preserves_orphans() {
        let source_id = Uuid::nil();
        let annotations = vec![
            ObjectAnnotation {
                source_id,
                object_key: ObjectKey::table("public", "users"),
                description: Some("Accounts".into()),
                tags: vec!["identity".into()],
                owner: None,
                is_core: true,
                updated_at: Utc::now(),
            },
            ObjectAnnotation {
                source_id,
                object_key: ObjectKey::table("public", "removed"),
                description: Some("Legacy".into()),
                tags: Vec::new(),
                owner: None,
                is_core: false,
                updated_at: Utc::now(),
            },
        ];

        let result = reattach_semantics(&snapshot(), annotations, Vec::new());

        assert_eq!(result.attached_annotations.len(), 1);
        assert_eq!(result.orphaned_annotations.len(), 1);
        assert_eq!(result.orphaned_annotations[0].object_key.name, "removed");
    }

    #[test]
    fn canonicalizes_user_entered_semantics() {
        let mut annotation = ObjectAnnotation {
            source_id: Uuid::nil(),
            object_key: ObjectKey::table("public", "users"),
            description: Some("  User accounts  ".into()),
            tags: vec!["identity".into(), "core".into(), "identity".into()],
            owner: Some("   ".into()),
            is_core: true,
            updated_at: Utc::now(),
        };

        annotation.canonicalize();

        assert_eq!(annotation.description.as_deref(), Some("User accounts"));
        assert_eq!(annotation.tags, ["core", "identity"]);
        assert_eq!(annotation.owner, None);
    }
}
