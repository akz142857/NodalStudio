//! Database-independent schema types shared by the desktop and cloud runtimes.

use std::cmp::Ordering;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

/// Errors produced while canonicalizing or fingerprinting a schema snapshot.
#[derive(Debug, Error)]
pub enum SchemaModelError {
    #[error("failed to serialize canonical schema: {0}")]
    Serialization(#[from] serde_json::Error),
}

/// A stable, database-qualified key for an object across snapshots.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectKey {
    pub kind: ObjectKind,
    pub schema: String,
    pub name: String,
}

impl ObjectKey {
    pub fn new(kind: ObjectKind, schema: impl Into<String>, name: impl Into<String>) -> Self {
        Self {
            kind,
            schema: schema.into(),
            name: name.into(),
        }
    }

    pub fn table(schema: impl Into<String>, name: impl Into<String>) -> Self {
        Self::new(ObjectKind::Table, schema, name)
    }

    #[must_use]
    pub fn child(&self, kind: ObjectKind, name: impl Into<String>) -> Self {
        Self {
            kind,
            schema: format!("{}.{}", self.schema, self.name),
            name: name.into(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ObjectKind {
    Schema,
    Table,
    View,
    Enum,
    Column,
    PrimaryKey,
    ForeignKey,
    Index,
    Constraint,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseInfo {
    pub name: String,
    pub database_type: DatabaseType,
    pub version: String,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DatabaseType {
    #[default]
    PostgreSql,
    MySql,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataSourceProfile {
    pub id: Uuid,
    pub display_name: String,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub username: String,
    #[serde(default)]
    pub database_type: DatabaseType,
    pub ssl_mode: SslMode,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SslMode {
    Disable,
    Prefer,
    Require,
    VerifyCa,
    VerifyFull,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseSnapshot {
    pub id: Uuid,
    pub source_id: Uuid,
    pub captured_at: DateTime<Utc>,
    pub fingerprint: String,
    pub database: DatabaseInfo,
    pub schemas: Vec<SchemaDefinition>,
}

impl DatabaseSnapshot {
    pub fn new(source_id: Uuid, database: DatabaseInfo, schemas: Vec<SchemaDefinition>) -> Self {
        Self {
            id: Uuid::new_v4(),
            source_id,
            captured_at: Utc::now(),
            fingerprint: String::new(),
            database,
            schemas,
        }
    }

    /// Sorts all unordered collections and derives a content-only SHA-256 fingerprint.
    ///
    /// # Errors
    ///
    /// Returns [`SchemaModelError::Serialization`] if the canonical model cannot be
    /// encoded as JSON before hashing.
    pub fn canonicalize(&mut self) -> Result<(), SchemaModelError> {
        for schema in &mut self.schemas {
            schema.canonicalize();
        }
        self.schemas
            .sort_by(|left, right| left.name.cmp(&right.name));

        let canonical = CanonicalSnapshot {
            database: &self.database,
            schemas: &self.schemas,
        };
        let bytes = serde_json::to_vec(&canonical)?;
        self.fingerprint = hex::encode(Sha256::digest(bytes));
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalSnapshot<'a> {
    database: &'a DatabaseInfo,
    schemas: &'a [SchemaDefinition],
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaDefinition {
    pub name: String,
    pub tables: Vec<TableDefinition>,
    pub views: Vec<ViewDefinition>,
    pub enums: Vec<EnumDefinition>,
}

impl SchemaDefinition {
    pub fn empty(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            tables: Vec::new(),
            views: Vec::new(),
            enums: Vec::new(),
        }
    }

    fn canonicalize(&mut self) {
        for table in &mut self.tables {
            table.canonicalize();
        }
        self.tables.sort_by(|left, right| left.key.cmp(&right.key));
        self.views.sort_by(|left, right| left.key.cmp(&right.key));
        self.enums.sort_by(|left, right| left.key.cmp(&right.key));
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableDefinition {
    pub key: ObjectKey,
    pub table_kind: TableKind,
    pub columns: Vec<ColumnDefinition>,
    pub primary_key: Option<PrimaryKeyDefinition>,
    pub foreign_keys: Vec<ForeignKeyDefinition>,
    pub indexes: Vec<IndexDefinition>,
    pub constraints: Vec<ConstraintDefinition>,
    pub comment: Option<String>,
}

impl TableDefinition {
    pub fn empty(schema: impl Into<String>, name: impl Into<String>) -> Self {
        Self {
            key: ObjectKey::table(schema, name),
            table_kind: TableKind::Ordinary,
            columns: Vec::new(),
            primary_key: None,
            foreign_keys: Vec::new(),
            indexes: Vec::new(),
            constraints: Vec::new(),
            comment: None,
        }
    }

    fn canonicalize(&mut self) {
        self.columns.sort_by(|left, right| {
            left.ordinal_position
                .cmp(&right.ordinal_position)
                .then_with(|| left.name.cmp(&right.name))
        });
        self.foreign_keys
            .sort_by(|left, right| left.name.cmp(&right.name));
        self.indexes
            .sort_by(|left, right| left.name.cmp(&right.name));
        self.constraints
            .sort_by(|left, right| left.name.cmp(&right.name));
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TableKind {
    Ordinary,
    Partitioned,
    Foreign,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnDefinition {
    pub name: String,
    pub ordinal_position: i32,
    pub formatted_type: String,
    pub type_schema: String,
    pub type_name: String,
    pub nullable: bool,
    pub default_value: Option<String>,
    pub identity: Option<IdentityKind>,
    pub generated: bool,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IdentityKind {
    Always,
    ByDefault,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrimaryKeyDefinition {
    pub name: String,
    pub columns: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeyDefinition {
    pub name: String,
    pub columns: Vec<String>,
    pub referenced_schema: String,
    pub referenced_table: String,
    pub referenced_columns: Vec<String>,
    pub on_update: ReferentialAction,
    pub on_delete: ReferentialAction,
    pub match_type: MatchType,
    pub deferrable: bool,
    pub initially_deferred: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReferentialAction {
    NoAction,
    Restrict,
    Cascade,
    SetNull,
    SetDefault,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MatchType {
    Simple,
    Full,
    Partial,
}

/// A field-level endpoint used by model-only relationships.
///
/// Unlike [`ForeignKeyDefinition`], this value is not a database constraint. It
/// deliberately uses stable schema/table/column names so it can be reattached
/// to future snapshots from the same data source.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationshipEndpoint {
    pub schema: String,
    pub table: String,
    pub columns: Vec<String>,
}

impl RelationshipEndpoint {
    #[must_use]
    pub fn new(schema: impl Into<String>, table: impl Into<String>, columns: Vec<String>) -> Self {
        Self {
            schema: schema.into(),
            table: table.into(),
            columns,
        }
    }

    pub fn canonicalize(&mut self) {
        self.schema = self.schema.trim().to_owned();
        self.table = self.table.trim().to_owned();
        self.columns = self
            .columns
            .drain(..)
            .map(|column| column.trim().to_owned())
            .filter(|column| !column.is_empty())
            .collect();
    }

    #[must_use]
    pub fn display_key(&self) -> String {
        format!("{}.{}[{}]", self.schema, self.table, self.columns.join(","))
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RelationshipCardinality {
    OneToOne,
    OneToMany,
    ManyToOne,
    ManyToMany,
    #[default]
    Unspecified,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LogicalRelationshipStatus {
    #[default]
    Active,
    Disabled,
    Orphaned,
    Conflicted,
    SupersededByPhysical,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LogicalRelationshipOrigin {
    #[default]
    Manual,
    ConfirmedInference,
    Imported,
}

/// A user-confirmed relationship stored by `Nodal Studio` without modifying the
/// connected database.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogicalRelationship {
    pub id: Uuid,
    pub source_id: Uuid,
    pub name: String,
    pub source: RelationshipEndpoint,
    pub target: RelationshipEndpoint,
    pub cardinality: RelationshipCardinality,
    pub status: LogicalRelationshipStatus,
    pub origin: LogicalRelationshipOrigin,
    pub note: Option<String>,
    #[serde(default)]
    pub evidence: Vec<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl LogicalRelationship {
    pub fn canonicalize(&mut self) {
        self.name = self.name.trim().to_owned();
        self.source.canonicalize();
        self.target.canonicalize();
        self.note = self
            .note
            .take()
            .map(|note| note.trim().to_owned())
            .filter(|note| !note.is_empty());
        self.evidence = self
            .evidence
            .drain(..)
            .map(|item| item.trim().to_owned())
            .filter(|item| !item.is_empty())
            .collect();
        self.evidence.sort();
        self.evidence.dedup();
    }

    #[must_use]
    pub fn relationship_key(&self) -> String {
        format!(
            "{}->{}",
            self.source.display_key(),
            self.target.display_key()
        )
    }
}

/// Records a dismissed inferred edge so subsequent scans do not repeatedly
/// present the same candidate.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IgnoredRelationshipInference {
    pub source_id: Uuid,
    pub relationship_key: String,
    pub ignored_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexDefinition {
    pub name: String,
    pub method: String,
    pub columns: Vec<String>,
    pub unique: bool,
    pub primary: bool,
    pub predicate: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConstraintDefinition {
    pub name: String,
    pub constraint_type: ConstraintType,
    pub definition: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConstraintType {
    Check,
    Unique,
    Exclusion,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewDefinition {
    pub key: ObjectKey,
    pub definition: String,
    pub materialized: bool,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnumDefinition {
    pub key: ObjectKey,
    pub values: Vec<String>,
}

impl Ord for ViewDefinition {
    fn cmp(&self, other: &Self) -> Ordering {
        self.key.cmp(&other.key)
    }
}

impl PartialOrd for ViewDefinition {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_snapshot() -> DatabaseSnapshot {
        let mut users = TableDefinition::empty("public", "users");
        users.columns = vec![
            ColumnDefinition {
                name: "email".into(),
                ordinal_position: 2,
                formatted_type: "text".into(),
                type_schema: "pg_catalog".into(),
                type_name: "text".into(),
                nullable: false,
                default_value: None,
                identity: None,
                generated: false,
                comment: None,
            },
            ColumnDefinition {
                name: "id".into(),
                ordinal_position: 1,
                formatted_type: "uuid".into(),
                type_schema: "pg_catalog".into(),
                type_name: "uuid".into(),
                nullable: false,
                default_value: Some("gen_random_uuid()".into()),
                identity: None,
                generated: false,
                comment: None,
            },
        ];

        DatabaseSnapshot::new(
            Uuid::nil(),
            DatabaseInfo {
                name: "app".into(),
                database_type: DatabaseType::PostgreSql,
                version: "17".into(),
            },
            vec![SchemaDefinition {
                name: "public".into(),
                tables: vec![users],
                views: Vec::new(),
                enums: Vec::new(),
            }],
        )
    }

    #[test]
    fn fingerprint_excludes_snapshot_identity_and_capture_time() {
        let mut first = sample_snapshot();
        let mut second = sample_snapshot();
        second.id = Uuid::new_v4();
        second.captured_at = first.captured_at + chrono::Duration::seconds(30);

        first.canonicalize().unwrap();
        second.canonicalize().unwrap();

        assert_eq!(first.fingerprint, second.fingerprint);
    }

    #[test]
    fn canonicalization_sorts_columns_by_ordinal_position() {
        let mut snapshot = sample_snapshot();
        snapshot.canonicalize().unwrap();

        let columns = &snapshot.schemas[0].tables[0].columns;
        assert_eq!(columns[0].name, "id");
        assert_eq!(columns[1].name, "email");
    }

    #[test]
    fn logical_relationship_has_a_stable_canonical_key() {
        let now = Utc::now();
        let mut relationship = LogicalRelationship {
            id: Uuid::new_v4(),
            source_id: Uuid::new_v4(),
            name: "  order owner  ".into(),
            source: RelationshipEndpoint::new(" public ", " orders ", vec![" user_id ".into()]),
            target: RelationshipEndpoint::new("public", "users", vec!["id".into()]),
            cardinality: RelationshipCardinality::ManyToOne,
            status: LogicalRelationshipStatus::Active,
            origin: LogicalRelationshipOrigin::Manual,
            note: Some("  business owner  ".into()),
            evidence: vec![" type match ".into(), "type match".into()],
            created_at: now,
            updated_at: now,
        };
        relationship.canonicalize();

        assert_eq!(relationship.name, "order owner");
        assert_eq!(relationship.note.as_deref(), Some("business owner"));
        assert_eq!(relationship.evidence, ["type match"]);
        assert_eq!(
            relationship.relationship_key(),
            "public.orders[user_id]->public.users[id]"
        );
    }
}
