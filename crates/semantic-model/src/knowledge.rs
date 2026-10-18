//! Device-local confirmation evidence. Never embed this in portable annotations.
use crate::ObjectAnnotation;
use chrono::{DateTime, Utc};
use schema_model::{DatabaseSnapshot, LogicalRelationship, ObjectKey, ObjectKind};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

/// Hash canonical serializable local metadata.
/// # Panics
/// Panics if a caller passes a value unsupported by JSON serialization.
#[must_use]
pub fn digest(value: &impl Serialize) -> String {
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(value).expect("knowledge values serialize"))
    )
}
#[must_use]
pub fn annotation_version(annotation: Option<&ObjectAnnotation>) -> String {
    digest(&annotation)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeBasis {
    /// Device-local connection identity; never part of portable descriptions.
    #[serde(default)]
    pub source_identity: Option<String>,
    pub tables: Vec<(ObjectKey, String)>,
    pub relationships: Vec<(Uuid, String)>,
    pub notes: Vec<(ObjectKey, Uuid, String)>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeOrigin {
    pub kind: String,
    pub request_id: Option<Uuid>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub generated_at: Option<String>,
    pub evidence: serde_json::Value,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeConfirmation {
    pub id: Uuid,
    pub source_id: Uuid,
    pub object_key: ObjectKey,
    pub final_text: String,
    pub description_digest: String,
    pub snapshot_id: Uuid,
    pub fingerprint: String,
    pub confirmed_at: DateTime<Utc>,
    pub basis: KnowledgeBasis,
    pub origin: KnowledgeOrigin,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KnowledgeStatus {
    Confirmed,
    PendingReview,
    Unavailable,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeState {
    pub source_id: Uuid,
    pub object_key: ObjectKey,
    pub status: KnowledgeStatus,
    pub reason: String,
    pub confirmation: Option<KnowledgeConfirmation>,
}

/// Resolve an annotation to its collected table, without guessing missing objects.
#[must_use]
pub fn owning_table(snapshot: &DatabaseSnapshot, key: &ObjectKey) -> Option<ObjectKey> {
    if !matches!(
        key.kind,
        ObjectKind::Table
            | ObjectKind::Column
            | ObjectKind::PrimaryKey
            | ObjectKind::ForeignKey
            | ObjectKind::Index
            | ObjectKind::Constraint
    ) {
        return None;
    }
    let mut matches = snapshot
        .schemas
        .iter()
        .flat_map(|s| &s.tables)
        .filter(|t| match key.kind {
            ObjectKind::Table => &t.key == key,
            ObjectKind::Column => t
                .columns
                .iter()
                .any(|c| t.key.child(ObjectKind::Column, &c.name) == *key),
            ObjectKind::PrimaryKey => t
                .primary_key
                .as_ref()
                .is_some_and(|p| t.key.child(ObjectKind::PrimaryKey, &p.name) == *key),
            ObjectKind::ForeignKey => t
                .foreign_keys
                .iter()
                .any(|f| t.key.child(ObjectKind::ForeignKey, &f.name) == *key),
            ObjectKind::Index => t
                .indexes
                .iter()
                .any(|i| t.key.child(ObjectKind::Index, &i.name) == *key),
            ObjectKind::Constraint => t
                .constraints
                .iter()
                .any(|c| t.key.child(ObjectKind::Constraint, &c.name) == *key),
            _ => false,
        });
    let first = matches.next()?;
    if matches.next().is_some() {
        return None;
    }
    Some(first.key.clone())
}
#[must_use]
pub fn table_digest(snapshot: &DatabaseSnapshot, key: &ObjectKey) -> Option<String> {
    snapshot
        .schemas
        .iter()
        .flat_map(|s| &s.tables)
        .find(|t| &t.key == key)
        .map(|t| digest(&(snapshot.database.database_type, &snapshot.database.name, t)))
}
/// Excludes display labels, timestamps, TLS preferences and credentials.
#[must_use]
pub fn source_identity(profile: Option<&schema_model::DataSourceProfile>) -> String {
    digest(&profile.map(|p| (p.database_type, &p.host, p.port, &p.database, &p.username)))
}
/// Hash the relationship's structural meaning, excluding sync bookkeeping and free text.
#[must_use]
pub fn relationship_digest(relationship: &LogicalRelationship) -> String {
    digest(&(
        relationship.source_id,
        &relationship.source,
        &relationship.target,
        relationship.cardinality,
        relationship.status,
    ))
}
impl KnowledgeBasis {
    #[must_use]
    pub fn from_tables(
        snapshot: &DatabaseSnapshot,
        keys: &[ObjectKey],
        relationships: &[LogicalRelationship],
    ) -> Self {
        let mut keys = keys.to_vec();
        keys.sort();
        keys.dedup();
        let tables = keys
            .iter()
            .filter_map(|key| table_digest(snapshot, key).map(|d| (key.clone(), d)))
            .collect();
        let mut relations: Vec<_> = relationships
            .iter()
            .filter(|r| {
                keys.contains(&ObjectKey::table(&r.source.schema, &r.source.table))
                    && keys.contains(&ObjectKey::table(&r.target.schema, &r.target.table))
            })
            .map(|r| (r.id, relationship_digest(r)))
            .collect();
        relations.sort();
        Self {
            source_identity: None,
            tables,
            relationships: relations,
            notes: Vec::new(),
        }
    }
    #[must_use]
    pub fn structure_matches(
        &self,
        snapshot: &DatabaseSnapshot,
        relationships: &[LogicalRelationship],
    ) -> bool {
        !self.tables.is_empty()
            && self
                .tables
                .iter()
                .all(|(key, hash)| table_digest(snapshot, key).as_ref() == Some(hash))
            && self.relationships.iter().all(|(id, hash)| {
                relationships
                    .iter()
                    .any(|r| &r.id == id && &relationship_digest(r) == hash)
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use schema_model::{
        ConstraintDefinition, ConstraintType, DatabaseInfo, DatabaseType, SchemaDefinition,
        TableDefinition,
    };
    #[test]
    fn child_owner_requires_exact_membership_and_rejects_ambiguous_dotted_names() {
        let mut a = TableDefinition::empty("public", "orders.v2");
        let mut b = TableDefinition::empty("public.orders", "v2");
        let constraint = ConstraintDefinition {
            name: "business_rule".into(),
            constraint_type: ConstraintType::Check,
            definition: "CHECK (true)".into(),
        };
        b.constraints.push(constraint.clone());
        let key = b.key.child(ObjectKind::Constraint, &constraint.name);
        let mut snapshot = DatabaseSnapshot::new(
            Uuid::new_v4(),
            DatabaseInfo {
                name: "app".into(),
                database_type: DatabaseType::PostgreSql,
                version: "17".into(),
            },
            vec![SchemaDefinition {
                name: "public".into(),
                tables: vec![a.clone(), b.clone()],
                views: vec![],
                enums: vec![],
            }],
        );
        assert_eq!(owning_table(&snapshot, &key), Some(b.key.clone()));
        assert_eq!(owning_table(&snapshot, &a.key), Some(a.key.clone()));
        assert_eq!(
            owning_table(&snapshot, &a.key.child(ObjectKind::Column, "missing")),
            None
        );
        a.constraints.push(constraint);
        snapshot.schemas[0].tables[0] = a;
        assert_eq!(owning_table(&snapshot, &key), None);
    }
}
