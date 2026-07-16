//! Structural diffing between two canonical database snapshots.

use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use schema_model::{
    ColumnDefinition, ConstraintDefinition, DatabaseSnapshot, EnumDefinition, ForeignKeyDefinition,
    IndexDefinition, ObjectKey, ObjectKind, PrimaryKeyDefinition, TableDefinition, ViewDefinition,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaChangeSet {
    pub id: Uuid,
    pub before_snapshot_id: Uuid,
    pub after_snapshot_id: Uuid,
    pub created_at: DateTime<Utc>,
    pub operations: Vec<SchemaOperation>,
    pub risk_summary: RiskSummary,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaOperation {
    pub operation_type: OperationType,
    pub object: ObjectKey,
    pub risk: RiskLevel,
    pub before: Option<String>,
    pub after: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OperationType {
    AddTable,
    DropTable,
    AddColumn,
    DropColumn,
    RenameColumn,
    AlterColumn,
    AddPrimaryKey,
    DropPrimaryKey,
    AddForeignKey,
    DropForeignKey,
    AddIndex,
    DropIndex,
    AddConstraint,
    DropConstraint,
    AddView,
    DropView,
    AlterView,
    AddEnum,
    DropEnum,
    AlterEnum,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RiskLevel {
    Informational,
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RiskSummary {
    pub informational: usize,
    pub low: usize,
    pub medium: usize,
    pub high: usize,
}

impl RiskSummary {
    fn record(&mut self, level: RiskLevel) {
        match level {
            RiskLevel::Informational => self.informational += 1,
            RiskLevel::Low => self.low += 1,
            RiskLevel::Medium => self.medium += 1,
            RiskLevel::High => self.high += 1,
        }
    }
}

pub fn diff_snapshots(before: &DatabaseSnapshot, after: &DatabaseSnapshot) -> SchemaChangeSet {
    let before_tables = table_map(before);
    let after_tables = table_map(after);
    let mut operations = Vec::new();

    for (key, table) in &after_tables {
        match before_tables.get(key) {
            None => operations.push(SchemaOperation {
                operation_type: OperationType::AddTable,
                object: (*key).clone(),
                risk: RiskLevel::Low,
                before: None,
                after: Some(table_summary(table)),
            }),
            Some(previous) => diff_table(previous, table, &mut operations),
        }
    }

    for (key, table) in &before_tables {
        if !after_tables.contains_key(key) {
            operations.push(SchemaOperation {
                operation_type: OperationType::DropTable,
                object: (*key).clone(),
                risk: RiskLevel::High,
                before: Some(table_summary(table)),
                after: None,
            });
        }
    }

    diff_views(before, after, &mut operations);
    diff_enums(before, after, &mut operations);

    operations.sort_by(|left, right| {
        left.object.cmp(&right.object).then_with(|| {
            operation_order(left.operation_type).cmp(&operation_order(right.operation_type))
        })
    });

    let mut risk_summary = RiskSummary::default();
    for operation in &operations {
        risk_summary.record(operation.risk);
    }

    SchemaChangeSet {
        id: Uuid::new_v4(),
        before_snapshot_id: before.id,
        after_snapshot_id: after.id,
        created_at: Utc::now(),
        operations,
        risk_summary,
    }
}

fn diff_views(
    before: &DatabaseSnapshot,
    after: &DatabaseSnapshot,
    operations: &mut Vec<SchemaOperation>,
) {
    let before_views = view_map(before);
    let after_views = view_map(after);
    for (key, current) in &after_views {
        match before_views.get(key) {
            None => operations.push(SchemaOperation {
                operation_type: OperationType::AddView,
                object: (*key).clone(),
                risk: RiskLevel::Low,
                before: None,
                after: Some(view_summary(current)),
            }),
            Some(previous) if *previous != *current => operations.push(SchemaOperation {
                operation_type: OperationType::AlterView,
                object: (*key).clone(),
                risk: RiskLevel::Medium,
                before: Some(view_summary(previous)),
                after: Some(view_summary(current)),
            }),
            Some(_) => {}
        }
    }
    for (key, previous) in &before_views {
        if !after_views.contains_key(key) {
            operations.push(SchemaOperation {
                operation_type: OperationType::DropView,
                object: (*key).clone(),
                risk: RiskLevel::Medium,
                before: Some(view_summary(previous)),
                after: None,
            });
        }
    }
}

fn diff_enums(
    before: &DatabaseSnapshot,
    after: &DatabaseSnapshot,
    operations: &mut Vec<SchemaOperation>,
) {
    let before_enums = enum_map(before);
    let after_enums = enum_map(after);
    for (key, current) in &after_enums {
        match before_enums.get(key) {
            None => operations.push(SchemaOperation {
                operation_type: OperationType::AddEnum,
                object: (*key).clone(),
                risk: RiskLevel::Low,
                before: None,
                after: Some(enum_summary(current)),
            }),
            Some(previous) if *previous != *current => operations.push(SchemaOperation {
                operation_type: OperationType::AlterEnum,
                object: (*key).clone(),
                risk: if previous
                    .values
                    .iter()
                    .all(|value| current.values.contains(value))
                {
                    RiskLevel::Medium
                } else {
                    RiskLevel::High
                },
                before: Some(enum_summary(previous)),
                after: Some(enum_summary(current)),
            }),
            Some(_) => {}
        }
    }
    for (key, previous) in &before_enums {
        if !after_enums.contains_key(key) {
            operations.push(SchemaOperation {
                operation_type: OperationType::DropEnum,
                object: (*key).clone(),
                risk: RiskLevel::High,
                before: Some(enum_summary(previous)),
                after: None,
            });
        }
    }
}

fn diff_table(
    before: &TableDefinition,
    after: &TableDefinition,
    operations: &mut Vec<SchemaOperation>,
) {
    diff_columns(before, after, operations);
    diff_primary_key(before, after, operations);
    diff_named_objects(
        &before.key,
        ObjectKind::ForeignKey,
        &before.foreign_keys,
        &after.foreign_keys,
        OperationType::AddForeignKey,
        OperationType::DropForeignKey,
        RiskLevel::High,
        operations,
    );
    diff_named_objects(
        &before.key,
        ObjectKind::Index,
        &before.indexes,
        &after.indexes,
        OperationType::AddIndex,
        OperationType::DropIndex,
        RiskLevel::Medium,
        operations,
    );
    diff_named_objects(
        &before.key,
        ObjectKind::Constraint,
        &before.constraints,
        &after.constraints,
        OperationType::AddConstraint,
        OperationType::DropConstraint,
        RiskLevel::High,
        operations,
    );
}

fn table_map(snapshot: &DatabaseSnapshot) -> BTreeMap<&ObjectKey, &TableDefinition> {
    snapshot
        .schemas
        .iter()
        .flat_map(|schema| &schema.tables)
        .map(|table| (&table.key, table))
        .collect()
}

fn view_map(snapshot: &DatabaseSnapshot) -> BTreeMap<&ObjectKey, &ViewDefinition> {
    snapshot
        .schemas
        .iter()
        .flat_map(|schema| &schema.views)
        .map(|view| (&view.key, view))
        .collect()
}

fn enum_map(snapshot: &DatabaseSnapshot) -> BTreeMap<&ObjectKey, &EnumDefinition> {
    snapshot
        .schemas
        .iter()
        .flat_map(|schema| &schema.enums)
        .map(|item| (&item.key, item))
        .collect()
}

fn diff_columns(
    before: &TableDefinition,
    after: &TableDefinition,
    operations: &mut Vec<SchemaOperation>,
) {
    let before_columns: BTreeMap<&str, &ColumnDefinition> = before
        .columns
        .iter()
        .map(|column| (column.name.as_str(), column))
        .collect();
    let after_columns: BTreeMap<&str, &ColumnDefinition> = after
        .columns
        .iter()
        .map(|column| (column.name.as_str(), column))
        .collect();

    for (name, column) in &after_columns {
        let object = before.key.child(ObjectKind::Column, *name);
        match before_columns.get(name) {
            Some(previous) if *previous != *column => operations.push(SchemaOperation {
                operation_type: OperationType::AlterColumn,
                object,
                risk: altered_column_risk(previous, column),
                before: Some(column_summary(previous)),
                after: Some(column_summary(column)),
            }),
            Some(_) | None => {}
        }
    }

    let removed = before_columns
        .iter()
        .filter(|(name, _)| !after_columns.contains_key(*name))
        .map(|(name, column)| (*name, *column))
        .collect::<Vec<_>>();
    let added = after_columns
        .iter()
        .filter(|(name, _)| !before_columns.contains_key(*name))
        .map(|(name, column)| (*name, *column))
        .collect::<Vec<_>>();
    let renames = removed
        .iter()
        .filter_map(|(old_name, old_column)| {
            let candidates = added
                .iter()
                .filter(|(_, new_column)| same_column_structure(old_column, new_column))
                .collect::<Vec<_>>();
            let candidate = candidates.first().filter(|_| candidates.len() == 1)?;
            let reverse_matches = removed
                .iter()
                .filter(|(_, candidate_old)| same_column_structure(candidate_old, candidate.1))
                .count();
            (reverse_matches == 1).then_some((*old_name, candidate.0))
        })
        .collect::<Vec<_>>();

    for (old_name, new_name) in &renames {
        let old_column = before_columns[old_name];
        let new_column = after_columns[new_name];
        operations.push(SchemaOperation {
            operation_type: OperationType::RenameColumn,
            object: before.key.child(ObjectKind::Column, *old_name),
            risk: RiskLevel::High,
            before: Some(format!("{old_name}: {}", column_summary(old_column))),
            after: Some(format!("{new_name}: {}", column_summary(new_column))),
        });
    }

    for (name, column) in &added {
        if !renames.iter().any(|(_, new_name)| new_name == name) {
            operations.push(SchemaOperation {
                operation_type: OperationType::AddColumn,
                object: after.key.child(ObjectKind::Column, *name),
                risk: if column.nullable || column.default_value.is_some() {
                    RiskLevel::Low
                } else {
                    RiskLevel::Medium
                },
                before: None,
                after: Some(column_summary(column)),
            });
        }
    }

    for (name, column) in &before_columns {
        if !after_columns.contains_key(name)
            && !renames.iter().any(|(old_name, _)| old_name == name)
        {
            operations.push(SchemaOperation {
                operation_type: OperationType::DropColumn,
                object: before.key.child(ObjectKind::Column, *name),
                risk: RiskLevel::High,
                before: Some(column_summary(column)),
                after: None,
            });
        }
    }
}

fn same_column_structure(left: &ColumnDefinition, right: &ColumnDefinition) -> bool {
    left.formatted_type == right.formatted_type
        && left.type_schema == right.type_schema
        && left.type_name == right.type_name
        && left.nullable == right.nullable
        && left.default_value == right.default_value
        && left.identity == right.identity
        && left.generated == right.generated
        && left.comment == right.comment
}

fn altered_column_risk(before: &ColumnDefinition, after: &ColumnDefinition) -> RiskLevel {
    if before.formatted_type != after.formatted_type || (before.nullable && !after.nullable) {
        RiskLevel::High
    } else if before.default_value != after.default_value {
        RiskLevel::Medium
    } else {
        RiskLevel::Low
    }
}

fn diff_primary_key(
    before: &TableDefinition,
    after: &TableDefinition,
    operations: &mut Vec<SchemaOperation>,
) {
    if before.primary_key == after.primary_key {
        return;
    }
    if let Some(primary_key) = &before.primary_key {
        operations.push(SchemaOperation {
            operation_type: OperationType::DropPrimaryKey,
            object: before.key.child(ObjectKind::PrimaryKey, &primary_key.name),
            risk: RiskLevel::High,
            before: Some(primary_key.summary()),
            after: None,
        });
    }
    if let Some(primary_key) = &after.primary_key {
        operations.push(SchemaOperation {
            operation_type: OperationType::AddPrimaryKey,
            object: after.key.child(ObjectKind::PrimaryKey, &primary_key.name),
            risk: RiskLevel::Medium,
            before: None,
            after: Some(primary_key.summary()),
        });
    }
}

trait NamedSchemaObject {
    fn name(&self) -> &str;
    fn summary(&self) -> String;
}

impl NamedSchemaObject for PrimaryKeyDefinition {
    fn name(&self) -> &str {
        &self.name
    }

    fn summary(&self) -> String {
        self.columns.join(", ")
    }
}

impl NamedSchemaObject for ForeignKeyDefinition {
    fn name(&self) -> &str {
        &self.name
    }

    fn summary(&self) -> String {
        format!(
            "({}) -> {}.{}({})",
            self.columns.join(", "),
            self.referenced_schema,
            self.referenced_table,
            self.referenced_columns.join(", ")
        )
    }
}

impl NamedSchemaObject for IndexDefinition {
    fn name(&self) -> &str {
        &self.name
    }

    fn summary(&self) -> String {
        format!("{} ({})", self.method, self.columns.join(", "))
    }
}

impl NamedSchemaObject for ConstraintDefinition {
    fn name(&self) -> &str {
        &self.name
    }

    fn summary(&self) -> String {
        self.definition.clone()
    }
}

#[allow(clippy::too_many_arguments)]
fn diff_named_objects<T: NamedSchemaObject + Eq>(
    table_key: &ObjectKey,
    object_kind: ObjectKind,
    before: &[T],
    after: &[T],
    add_operation: OperationType,
    drop_operation: OperationType,
    drop_risk: RiskLevel,
    operations: &mut Vec<SchemaOperation>,
) {
    let before_objects: BTreeMap<&str, &T> =
        before.iter().map(|item| (item.name(), item)).collect();
    let after_objects: BTreeMap<&str, &T> = after.iter().map(|item| (item.name(), item)).collect();

    for (name, previous) in &before_objects {
        match after_objects.get(name) {
            None => operations.push(SchemaOperation {
                operation_type: drop_operation,
                object: table_key.child(object_kind, *name),
                risk: drop_risk,
                before: Some(previous.summary()),
                after: None,
            }),
            Some(current) if *previous != *current => {
                operations.push(SchemaOperation {
                    operation_type: drop_operation,
                    object: table_key.child(object_kind, *name),
                    risk: drop_risk,
                    before: Some(previous.summary()),
                    after: None,
                });
                operations.push(SchemaOperation {
                    operation_type: add_operation,
                    object: table_key.child(object_kind, *name),
                    risk: RiskLevel::Low,
                    before: None,
                    after: Some(current.summary()),
                });
            }
            Some(_) => {}
        }
    }

    for (name, current) in &after_objects {
        if !before_objects.contains_key(name) {
            operations.push(SchemaOperation {
                operation_type: add_operation,
                object: table_key.child(object_kind, *name),
                risk: RiskLevel::Low,
                before: None,
                after: Some(current.summary()),
            });
        }
    }
}

fn table_summary(table: &TableDefinition) -> String {
    format!("{} columns", table.columns.len())
}

fn column_summary(column: &ColumnDefinition) -> String {
    format!(
        "{}{}",
        column.formatted_type,
        if column.nullable {
            " nullable"
        } else {
            " not null"
        }
    )
}

fn view_summary(view: &ViewDefinition) -> String {
    format!(
        "{}: {}",
        if view.materialized {
            "materialized view"
        } else {
            "view"
        },
        view.definition
    )
}

fn enum_summary(item: &EnumDefinition) -> String {
    item.values.join(", ")
}

const fn operation_order(operation: OperationType) -> u8 {
    match operation {
        OperationType::AddTable => 0,
        OperationType::DropTable => 1,
        OperationType::AddColumn => 2,
        OperationType::DropColumn => 3,
        OperationType::RenameColumn => 4,
        OperationType::AlterColumn => 5,
        OperationType::AddPrimaryKey => 6,
        OperationType::DropPrimaryKey => 7,
        OperationType::AddForeignKey => 8,
        OperationType::DropForeignKey => 9,
        OperationType::AddIndex => 10,
        OperationType::DropIndex => 11,
        OperationType::AddConstraint => 12,
        OperationType::DropConstraint => 13,
        OperationType::AddView => 14,
        OperationType::DropView => 15,
        OperationType::AlterView => 16,
        OperationType::AddEnum => 17,
        OperationType::DropEnum => 18,
        OperationType::AlterEnum => 19,
    }
}

#[cfg(test)]
mod tests {
    use schema_model::{
        DatabaseInfo, DatabaseType, EnumDefinition, IndexDefinition, ObjectKey, ObjectKind,
        SchemaDefinition, TableDefinition,
    };

    use super::*;

    fn snapshot_with_table(table: TableDefinition) -> DatabaseSnapshot {
        DatabaseSnapshot::new(
            Uuid::nil(),
            DatabaseInfo {
                name: "app".into(),
                database_type: DatabaseType::PostgreSql,
                version: "17".into(),
            },
            vec![SchemaDefinition {
                name: "public".into(),
                tables: vec![table],
                views: Vec::new(),
                enums: Vec::new(),
            }],
        )
    }

    fn column(name: &str, nullable: bool) -> ColumnDefinition {
        ColumnDefinition {
            name: name.into(),
            ordinal_position: 1,
            formatted_type: "text".into(),
            type_schema: "pg_catalog".into(),
            type_name: "text".into(),
            nullable,
            default_value: None,
            identity: None,
            generated: false,
            comment: None,
        }
    }

    #[test]
    fn detects_added_and_dropped_tables() {
        let before = snapshot_with_table(TableDefinition::empty("public", "users"));
        let after = snapshot_with_table(TableDefinition::empty("public", "accounts"));

        let changes = diff_snapshots(&before, &after);

        assert_eq!(changes.operations.len(), 2);
        assert!(changes.operations.iter().any(|change| {
            change.operation_type == OperationType::DropTable && change.risk == RiskLevel::High
        }));
        assert!(
            changes
                .operations
                .iter()
                .any(|change| change.operation_type == OperationType::AddTable)
        );
    }

    #[test]
    fn making_a_column_not_null_is_high_risk() {
        let mut before_table = TableDefinition::empty("public", "users");
        before_table.columns.push(column("email", true));
        let mut after_table = before_table.clone();
        after_table.columns[0].nullable = false;

        let changes = diff_snapshots(
            &snapshot_with_table(before_table),
            &snapshot_with_table(after_table),
        );

        assert_eq!(changes.operations.len(), 1);
        assert_eq!(
            changes.operations[0].operation_type,
            OperationType::AlterColumn
        );
        assert_eq!(changes.operations[0].risk, RiskLevel::High);
    }

    #[test]
    fn detects_an_unambiguous_column_rename() {
        let mut before_table = TableDefinition::empty("public", "users");
        before_table.columns.push(column("display_name", false));
        let mut after_table = before_table.clone();
        after_table.columns[0].name = "full_name".into();

        let changes = diff_snapshots(
            &snapshot_with_table(before_table),
            &snapshot_with_table(after_table),
        );

        assert_eq!(changes.operations.len(), 1);
        assert_eq!(
            changes.operations[0].operation_type,
            OperationType::RenameColumn
        );
        assert_eq!(changes.operations[0].object.name, "display_name");
        assert!(
            changes.operations[0]
                .after
                .as_deref()
                .is_some_and(|summary| summary.starts_with("full_name:"))
        );
    }

    #[test]
    fn keeps_add_and_drop_when_a_column_rename_is_ambiguous() {
        let mut before_table = TableDefinition::empty("public", "users");
        before_table.columns.push(column("first_name", false));
        before_table.columns.push(column("last_name", false));
        let mut after_table = TableDefinition::empty("public", "users");
        after_table.columns.push(column("given_name", false));
        after_table.columns.push(column("family_name", false));

        let changes = diff_snapshots(
            &snapshot_with_table(before_table),
            &snapshot_with_table(after_table),
        );

        assert_eq!(changes.operations.len(), 4);
        assert!(
            !changes
                .operations
                .iter()
                .any(|operation| operation.operation_type == OperationType::RenameColumn)
        );
    }

    #[test]
    fn dropping_an_index_is_medium_risk() {
        let mut before_table = TableDefinition::empty("public", "users");
        before_table.indexes.push(IndexDefinition {
            name: "users_email_idx".into(),
            method: "btree".into(),
            columns: vec!["email".into()],
            unique: false,
            primary: false,
            predicate: None,
        });
        let after_table = TableDefinition::empty("public", "users");

        let changes = diff_snapshots(
            &snapshot_with_table(before_table),
            &snapshot_with_table(after_table),
        );

        assert_eq!(changes.operations.len(), 1);
        assert_eq!(
            changes.operations[0].operation_type,
            OperationType::DropIndex
        );
        assert_eq!(changes.operations[0].risk, RiskLevel::Medium);
    }

    #[test]
    fn removing_an_enum_value_is_high_risk() {
        let before = DatabaseSnapshot::new(
            Uuid::nil(),
            DatabaseInfo {
                name: "app".into(),
                database_type: DatabaseType::PostgreSql,
                version: "17".into(),
            },
            vec![SchemaDefinition {
                name: "public".into(),
                tables: Vec::new(),
                views: Vec::new(),
                enums: vec![EnumDefinition {
                    key: ObjectKey::new(ObjectKind::Enum, "public", "status"),
                    values: vec!["draft".into(), "paid".into()],
                }],
            }],
        );
        let mut after = before.clone();
        after.id = Uuid::new_v4();
        after.schemas[0].enums[0].values = vec!["paid".into()];

        let changes = diff_snapshots(&before, &after);

        assert_eq!(changes.operations.len(), 1);
        assert_eq!(
            changes.operations[0].operation_type,
            OperationType::AlterEnum
        );
        assert_eq!(changes.operations[0].risk, RiskLevel::High);
    }
}
