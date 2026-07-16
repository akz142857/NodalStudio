//! Privacy-bounded schema context selection and provider-independent explanations.

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use schema_diff::SchemaChangeSet;
use schema_model::{DatabaseSnapshot, ObjectKey, TableDefinition};
use semantic_model::{DomainGroup, ObjectAnnotation};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaContext {
    pub target: String,
    pub tables: Vec<ContextTable>,
    pub recent_change: Option<SchemaChangeSet>,
    pub policy: ContextPolicy,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextTable {
    pub key: ObjectKey,
    pub columns: Vec<String>,
    pub primary_key: Vec<String>,
    pub outgoing_relations: Vec<String>,
    pub comment: Option<String>,
    pub annotation: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextPolicy {
    pub relationship_depth: u8,
    pub credentials_included: bool,
    pub row_data_included: bool,
    pub complete_schema_included: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Explanation {
    pub provider: String,
    pub model: Option<String>,
    pub generated_at: Option<String>,
    pub title: String,
    pub explanation: String,
    pub evidence: Vec<String>,
    pub candidate_annotation: Option<String>,
    pub context_policy: ContextPolicy,
}

pub trait AiProvider: Send + Sync {
    fn id(&self) -> &'static str;
    fn explain(&self, context: &SchemaContext, question: Option<&str>) -> Explanation;
}

/// Deterministic local provider. It never performs network access and makes only
/// structural inferences that are explicitly backed by the returned evidence.
pub struct OfflineSchemaProvider;

impl AiProvider for OfflineSchemaProvider {
    fn id(&self) -> &'static str {
        "offline-schema"
    }

    fn explain(&self, context: &SchemaContext, question: Option<&str>) -> Explanation {
        let table_count = context.tables.len();
        let column_count: usize = context.tables.iter().map(|table| table.columns.len()).sum();
        let relation_count: usize = context
            .tables
            .iter()
            .map(|table| table.outgoing_relations.len())
            .sum();
        let target = context
            .tables
            .first()
            .map_or(context.target.as_str(), |table| table.key.name.as_str());
        let question_note = question
            .filter(|value| !value.trim().is_empty())
            .map_or(String::new(), |value| {
                format!(" 针对问题“{}”，", value.trim())
            });
        let explanation = format!(
            "{target}{question_note}离线分析了 {table_count} 张相关表、{column_count} 个字段和 {relation_count} 条外键关系。目标对象位于该关系邻域的中心；具体业务含义仍需由团队结合代码与业务确认。"
        );
        let evidence = context
            .tables
            .iter()
            .take(8)
            .map(|table| {
                format!(
                    "{}.{}：{} 个字段，{} 条出向关系",
                    table.key.schema,
                    table.key.name,
                    table.columns.len(),
                    table.outgoing_relations.len()
                )
            })
            .collect();
        Explanation {
            provider: self.id().to_owned(),
            model: None,
            generated_at: None,
            title: format!("{target} 的结构解释"),
            explanation,
            evidence,
            candidate_annotation: context.tables.first().map(|table| {
                format!(
                    "{} 表包含 {} 个字段，并与 {} 个表存在直接外键关系。其业务职责为结构推断，需人工确认。",
                    table.key.name,
                    table.columns.len(),
                    table.outgoing_relations.len()
                )
            }),
            context_policy: context.policy.clone(),
        }
    }
}

pub fn table_context(
    snapshot: &DatabaseSnapshot,
    target: &ObjectKey,
    depth: u8,
    annotations: &[ObjectAnnotation],
) -> Option<SchemaContext> {
    let depth = depth.min(2);
    let tables = table_map(snapshot);
    if !tables.contains_key(target) {
        return None;
    }
    let graph = relation_graph(&tables);
    let selected = breadth_first_keys(target, depth, &graph);
    let complete_schema_included = selected.len() == tables.len();
    Some(SchemaContext {
        target: format!("{}.{}", target.schema, target.name),
        tables: selected
            .iter()
            .filter_map(|key| tables.get(key))
            .map(|table| context_table(table, annotations))
            .collect(),
        recent_change: None,
        policy: ContextPolicy {
            relationship_depth: depth,
            credentials_included: false,
            row_data_included: false,
            complete_schema_included,
        },
    })
}

pub fn domain_context(
    snapshot: &DatabaseSnapshot,
    group: &DomainGroup,
    annotations: &[ObjectAnnotation],
) -> SchemaContext {
    let tables = table_map(snapshot);
    SchemaContext {
        target: group.name.clone(),
        tables: group
            .table_keys
            .iter()
            .filter_map(|key| tables.get(key))
            .map(|table| context_table(table, annotations))
            .collect(),
        recent_change: None,
        policy: ContextPolicy {
            relationship_depth: 0,
            credentials_included: false,
            row_data_included: false,
            complete_schema_included: group.table_keys.len() == tables.len(),
        },
    }
}

pub fn change_context(
    snapshot: &DatabaseSnapshot,
    change: &SchemaChangeSet,
    annotations: &[ObjectAnnotation],
) -> SchemaContext {
    let tables = table_map(snapshot);
    let changed_keys: BTreeSet<_> = change
        .operations
        .iter()
        .map(|operation| ObjectKey::table(&operation.object.schema, table_name(&operation.object)))
        .collect();
    SchemaContext {
        target: format!("ChangeSet {}", change.id),
        tables: changed_keys
            .iter()
            .filter_map(|key| tables.get(key))
            .map(|table| context_table(table, annotations))
            .collect(),
        recent_change: Some(change.clone()),
        policy: ContextPolicy {
            relationship_depth: 0,
            credentials_included: false,
            row_data_included: false,
            complete_schema_included: false,
        },
    }
}

fn table_name(key: &ObjectKey) -> &str {
    key.schema
        .rsplit_once('.')
        .map_or(key.name.as_str(), |(_, name)| name)
}

fn table_map(snapshot: &DatabaseSnapshot) -> BTreeMap<ObjectKey, &TableDefinition> {
    snapshot
        .schemas
        .iter()
        .flat_map(|schema| &schema.tables)
        .map(|table| (table.key.clone(), table))
        .collect()
}

fn relation_graph(
    tables: &BTreeMap<ObjectKey, &TableDefinition>,
) -> BTreeMap<ObjectKey, BTreeSet<ObjectKey>> {
    let mut graph = BTreeMap::new();
    for (key, table) in tables {
        graph.entry(key.clone()).or_insert_with(BTreeSet::new);
        for foreign_key in &table.foreign_keys {
            let other = ObjectKey::table(
                &foreign_key.referenced_schema,
                &foreign_key.referenced_table,
            );
            if tables.contains_key(&other) {
                graph.entry(key.clone()).or_default().insert(other.clone());
                graph.entry(other).or_default().insert(key.clone());
            }
        }
    }
    graph
}

fn breadth_first_keys(
    start: &ObjectKey,
    depth: u8,
    graph: &BTreeMap<ObjectKey, BTreeSet<ObjectKey>>,
) -> BTreeSet<ObjectKey> {
    let mut selected = BTreeSet::from([start.clone()]);
    let mut queue = VecDeque::from([(start.clone(), 0_u8)]);
    while let Some((key, current_depth)) = queue.pop_front() {
        if current_depth >= depth {
            continue;
        }
        for neighbour in graph.get(&key).into_iter().flatten() {
            if selected.insert(neighbour.clone()) {
                queue.push_back((neighbour.clone(), current_depth + 1));
            }
        }
    }
    selected
}

fn context_table(table: &TableDefinition, annotations: &[ObjectAnnotation]) -> ContextTable {
    ContextTable {
        key: table.key.clone(),
        columns: table
            .columns
            .iter()
            .map(|column| format!("{}: {}", column.name, column.formatted_type))
            .collect(),
        primary_key: table
            .primary_key
            .as_ref()
            .map_or_else(Vec::new, |key| key.columns.clone()),
        outgoing_relations: table
            .foreign_keys
            .iter()
            .map(|key| format!("{}.{}", key.referenced_schema, key.referenced_table))
            .collect(),
        comment: table.comment.clone(),
        annotation: annotations
            .iter()
            .find(|annotation| annotation.object_key == table.key)
            .and_then(|annotation| annotation.description.clone()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use schema_model::{
        DatabaseInfo, DatabaseType, ForeignKeyDefinition, MatchType, ReferentialAction,
        SchemaDefinition,
    };
    use uuid::Uuid;

    fn snapshot() -> DatabaseSnapshot {
        let mut users = TableDefinition::empty("public", "users");
        let mut orders = TableDefinition::empty("public", "orders");
        orders.foreign_keys.push(ForeignKeyDefinition {
            name: "orders_user_id_fkey".into(),
            columns: vec!["user_id".into()],
            referenced_schema: "public".into(),
            referenced_table: "users".into(),
            referenced_columns: vec!["id".into()],
            on_update: ReferentialAction::NoAction,
            on_delete: ReferentialAction::NoAction,
            match_type: MatchType::Simple,
            deferrable: false,
            initially_deferred: false,
        });
        users.comment = Some("Accounts".into());
        DatabaseSnapshot::new(
            Uuid::new_v4(),
            DatabaseInfo {
                name: "app".into(),
                database_type: DatabaseType::PostgreSql,
                version: "17".into(),
            },
            vec![SchemaDefinition {
                name: "public".into(),
                tables: vec![users, orders],
                views: vec![],
                enums: vec![],
            }],
        )
    }

    #[test]
    fn selects_only_bounded_relationship_neighbourhood() {
        let context = table_context(&snapshot(), &ObjectKey::table("public", "users"), 1, &[])
            .expect("target exists");
        assert_eq!(context.tables.len(), 2);
        assert!(!context.policy.credentials_included);
        assert!(!context.policy.row_data_included);
    }

    #[test]
    fn offline_provider_marks_candidate_as_inference() {
        let context = table_context(&snapshot(), &ObjectKey::table("public", "orders"), 0, &[])
            .expect("target exists");
        let explanation = OfflineSchemaProvider.explain(&context, None);
        assert!(
            explanation
                .candidate_annotation
                .expect("candidate")
                .contains("需人工确认")
        );
    }
}
