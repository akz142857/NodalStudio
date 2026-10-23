//! Stage-one table understanding. The model cannot author structural facts or navigation targets.

use std::collections::{BTreeMap, BTreeSet};

use schema_model::{
    DatabaseSnapshot, LogicalRelationship, LogicalRelationshipStatus, ObjectKey, ObjectKind,
    TableDefinition,
};
use semantic_model::DomainGroup;
use serde::{Deserialize, Serialize};

pub const MAX_TABLES: usize = 20;
pub const MAX_COLUMNS: usize = 1_000;
pub const MAX_EVIDENCE: usize = 2_000;
pub const MAX_CONTEXT_BYTES: usize = 131_072;
pub const MAX_QUESTION_CHARS: usize = 2_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SendScope {
    CurrentTable,
    OneHop,
    Domain,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Evidence {
    pub id: String,
    pub table_key: ObjectKey,
    pub object_key: ObjectKey,
    pub kind: String,
    pub label: String,
    pub detail: String,
    pub columns: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableContext {
    pub version: u8,
    pub target: ObjectKey,
    pub focus_column: Option<String>,
    pub scope: SendScope,
    pub dialect: schema_model::DatabaseType,
    pub tables: Vec<ObjectKey>,
    pub evidence: Vec<Evidence>,
    pub coverage: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Interpretation {
    pub text: String,
    pub evidence_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelUnderstanding {
    pub schema_version: u8,
    pub summary: Option<Interpretation>,
    pub interpretations: Vec<Interpretation>,
    pub unknowns: Vec<String>,
}

/// Builds an allowlisted, budgeted context without annotations, connection identity or rows.
///
/// # Errors
/// Rejects missing targets/domains/fields and an oversized target; never silently truncates it.
#[allow(clippy::too_many_arguments, clippy::too_many_lines)]
pub fn build_context(
    snapshot: &DatabaseSnapshot,
    target: &ObjectKey,
    focus_column: Option<&str>,
    scope: SendScope,
    domain: Option<&DomainGroup>,
    logical: &[LogicalRelationship],
    include_comments: bool,
) -> Result<TableContext, String> {
    let tables: BTreeMap<_, _> = snapshot
        .schemas
        .iter()
        .flat_map(|s| &s.tables)
        .map(|t| (t.key.clone(), t))
        .collect();
    let selected = tables
        .get(target)
        .ok_or("Select a table in the current snapshot.")?;
    if focus_column.is_some_and(|name| !selected.columns.iter().any(|c| c.name == name)) {
        return Err("The selected column no longer exists.".into());
    }
    let active: Vec<_> = logical
        .iter()
        .filter(|r| {
            r.source_id == snapshot.source_id && r.status == LogicalRelationshipStatus::Active
        })
        .filter(|r| {
            endpoints_exist(
                &tables,
                &r.source.schema,
                &r.source.table,
                &r.source.columns,
                &r.target.schema,
                &r.target.table,
                &r.target.columns,
            )
        })
        .collect();
    let mut neighbours = BTreeSet::from([target.clone()]);
    for table in tables.values() {
        for fk in &table.foreign_keys {
            let other = ObjectKey::table(&fk.referenced_schema, &fk.referenced_table);
            if endpoints_exist(
                &tables,
                &table.key.schema,
                &table.key.name,
                &fk.columns,
                &fk.referenced_schema,
                &fk.referenced_table,
                &fk.referenced_columns,
            ) {
                if &table.key == target {
                    neighbours.insert(other);
                } else if &other == target {
                    neighbours.insert(table.key.clone());
                }
            }
        }
    }
    for relation in &active {
        let from = ObjectKey::table(&relation.source.schema, &relation.source.table);
        let to = ObjectKey::table(&relation.target.schema, &relation.target.table);
        if &from == target {
            neighbours.insert(to);
        } else if &to == target {
            neighbours.insert(from);
        }
    }
    let allowed = match scope {
        SendScope::CurrentTable => BTreeSet::from([target.clone()]),
        SendScope::OneHop => neighbours,
        SendScope::Domain => {
            let group = domain.filter(|g| g.source_id == snapshot.source_id && g.table_keys.contains(target))
                .ok_or("Select one business domain containing this table. Domains are never combined automatically.")?;
            // Single-table task: only relevant direct neighbours, intersected with the chosen domain.
            neighbours
                .into_iter()
                .filter(|key| group.table_keys.contains(key))
                .collect()
        }
    };
    let mut keys = vec![target.clone()];
    keys.extend(allowed.iter().filter(|key| *key != target).cloned());
    let mut context = TableContext {
        version: 1, target: target.clone(), focus_column: focus_column.map(str::to_owned), scope,
        dialect: snapshot.database.database_type, tables: Vec::new(), evidence: Vec::new(),
        coverage: vec![
            "Snapshot metadata only; no application rows or execution behavior were inspected.".into(),
            "Unreviewed annotations are excluded. Eligible locally confirmed team statements, when enabled, are labelled separately.".into(),
            "Business grain, state meanings, units and workflow remain unverified unless independently supported.".into(),
        ],
    };
    if scope == SendScope::Domain {
        context.coverage.push("Only the target and its direct neighbours inside the explicitly selected domain are included.".into());
    }
    let mut columns = 0;
    for key in keys {
        let table = tables[&key];
        if context.tables.len() == MAX_TABLES || columns + table.columns.len() > MAX_COLUMNS {
            if &key == target {
                return Err(
                    "This table exceeds the 1,000-column AI context budget. No request was sent."
                        .into(),
                );
            }
            context.coverage.push("Some neighbours were omitted by the table/column budget; this is a partial context.".into());
            break;
        }
        columns += table.columns.len();
        context.tables.push(key);
    }
    let (evidence, omitted_relations) =
        selected_evidence(snapshot, &context.tables, logical, include_comments)?;
    context.evidence = evidence;
    if omitted_relations {
        context.coverage.push("Some relationships are outside the permitted scope or lack complete endpoints; their names and mappings are not sent.".into());
    }
    context.coverage.sort();
    context.coverage.dedup();
    if context.evidence.len() > MAX_EVIDENCE || json(&context)?.len() > MAX_CONTEXT_BYTES {
        return Err("The selected context exceeds the AI evidence/128 KiB budget. Use Current table scope or disable comments; no request was sent.".into());
    }
    Ok(context)
}

/// Collect only evidence whose objects and relationship endpoints are in `keys`.
/// Shared by single-table and discovery requests; never includes saved annotations.
///
/// # Errors
/// Rejects absent tables and evidence that cannot be serialized.
pub fn selected_evidence(
    snapshot: &DatabaseSnapshot,
    keys: &[ObjectKey],
    logical: &[LogicalRelationship],
    include_comments: bool,
) -> Result<(Vec<Evidence>, bool), String> {
    let tables: BTreeMap<_, _> = snapshot
        .schemas
        .iter()
        .flat_map(|s| &s.tables)
        .map(|t| (t.key.clone(), t))
        .collect();
    if keys.iter().any(|key| !tables.contains_key(key)) {
        return Err("An evidence table is no longer available.".into());
    }
    let active = logical
        .iter()
        .filter(|r| {
            r.source_id == snapshot.source_id && r.status == LogicalRelationshipStatus::Active
        })
        .filter(|r| {
            endpoints_exist(
                &tables,
                &r.source.schema,
                &r.source.table,
                &r.source.columns,
                &r.target.schema,
                &r.target.table,
                &r.target.columns,
            )
        });
    let mut evidence = Vec::new();
    let included: BTreeSet<_> = keys.iter().cloned().collect();
    let mut omitted_relations = false;
    for key in keys.iter().cloned() {
        let table = tables[&key];
        add_table_evidence(&mut evidence, table, include_comments)?;
        for fk in &table.foreign_keys {
            let other = ObjectKey::table(&fk.referenced_schema, &fk.referenced_table);
            if included.contains(&other)
                && endpoints_exist(
                    &tables,
                    &key.schema,
                    &key.name,
                    &fk.columns,
                    &fk.referenced_schema,
                    &fk.referenced_table,
                    &fk.referenced_columns,
                )
            {
                add_evidence(
                    &mut evidence,
                    &key,
                    ObjectKind::ForeignKey,
                    &fk.name,
                    "physicalRelationship",
                    json(fk)?,
                    fk.columns.clone(),
                );
            } else {
                omitted_relations = true;
            }
        }
    }
    for relation in active {
        let from = ObjectKey::table(&relation.source.schema, &relation.source.table);
        let to = ObjectKey::table(&relation.target.schema, &relation.target.table);
        if included.contains(&from) && included.contains(&to) {
            // User-authored relationship notes/evidence are not confirmed knowledge.
            let detail = json(
                &serde_json::json!({"source":relation.source,"target":relation.target,"kind":"model-only logical relationship; not a database constraint"}),
            )?;
            add_evidence(
                &mut evidence,
                &from,
                ObjectKind::Table,
                &from.name,
                "logicalRelationship",
                detail,
                relation.source.columns.clone(),
            );
        } else if included.contains(&from) || included.contains(&to) {
            omitted_relations = true;
        }
    }
    Ok((evidence, omitted_relations))
}

#[allow(clippy::too_many_arguments)]
fn endpoints_exist(
    tables: &BTreeMap<ObjectKey, &TableDefinition>,
    from_schema: &str,
    from: &str,
    cols: &[String],
    to_schema: &str,
    to: &str,
    refs: &[String],
) -> bool {
    !cols.is_empty()
        && cols.len() == refs.len()
        && tables
            .get(&ObjectKey::table(from_schema, from))
            .is_some_and(|t| {
                cols.iter()
                    .all(|name| t.columns.iter().any(|c| &c.name == name))
            })
        && tables
            .get(&ObjectKey::table(to_schema, to))
            .is_some_and(|t| {
                refs.iter()
                    .all(|name| t.columns.iter().any(|c| &c.name == name))
            })
}

fn json(value: &impl Serialize) -> Result<String, String> {
    serde_json::to_string(value).map_err(|_| "Unable to serialize table evidence.".into())
}

fn add_table_evidence(
    evidence: &mut Vec<Evidence>,
    table: &TableDefinition,
    comments: bool,
) -> Result<(), String> {
    add_evidence(
        evidence,
        &table.key,
        ObjectKind::Table,
        &table.key.name,
        "table",
        json(
            &serde_json::json!({"kind":table.table_kind,"columnCount":table.columns.len(),"hasPrimaryKey":table.primary_key.is_some()}),
        )?,
        vec![],
    );
    if comments && let Some(comment) = &table.comment {
        add_evidence(
            evidence,
            &table.key,
            ObjectKind::Table,
            &table.key.name,
            "databaseComment",
            comment.clone(),
            vec![],
        );
    }
    for column in &table.columns {
        let mut column = column.clone();
        if !comments {
            column.comment = None;
        }
        add_evidence(
            evidence,
            &table.key,
            ObjectKind::Column,
            &column.name,
            "column",
            json(&column)?,
            vec![column.name.clone()],
        );
    }
    if let Some(pk) = &table.primary_key {
        add_evidence(
            evidence,
            &table.key,
            ObjectKind::PrimaryKey,
            &pk.name,
            "primaryKey",
            json(pk)?,
            pk.columns.clone(),
        );
    }
    for index in &table.indexes {
        add_evidence(
            evidence,
            &table.key,
            ObjectKind::Index,
            &index.name,
            "index",
            json(index)?,
            index.columns.clone(),
        );
    }
    for constraint in &table.constraints {
        add_evidence(
            evidence,
            &table.key,
            ObjectKind::Constraint,
            &constraint.name,
            "constraint",
            json(constraint)?,
            vec![],
        );
    }
    Ok(())
}

fn add_evidence(
    evidence: &mut Vec<Evidence>,
    table: &ObjectKey,
    kind: ObjectKind,
    name: &str,
    category: &str,
    detail: String,
    columns: Vec<String>,
) {
    evidence.push(Evidence {
        id: format!("e{}", evidence.len() + 1),
        table_key: table.clone(),
        object_key: if kind == ObjectKind::Table {
            table.clone()
        } else {
            table.child(kind, name)
        },
        kind: category.into(),
        label: format!("{}.{} · {name}", table.schema, table.name),
        detail,
        columns,
    });
}

/// Parses untrusted model output. Evidence IDs can reference only the exact sent context.
///
/// # Errors
/// Rejects unknown fields, fabricated IDs, missing evidence, and excessive output.
pub fn validate_model_output(
    text: &str,
    context: &TableContext,
) -> Result<ModelUnderstanding, String> {
    if text.len() > 65_536 {
        return Err("Model response exceeds 64 KiB.".into());
    }
    let result: ModelUnderstanding = serde_json::from_str(text).map_err(|_| "The model returned invalid structured output. Retry with a model that follows the displayed JSON contract.".to_owned())?;
    let known: BTreeSet<_> = context.evidence.iter().map(|e| e.id.as_str()).collect();
    if result.schema_version != 2
        || result.summary.is_none()
        || result.interpretations.len() > 3
        || result.unknowns.len() > 3
        || result
            .summary
            .iter()
            .chain(&result.interpretations)
            .any(|claim| {
                claim.text.trim().is_empty()
                    || claim.text.chars().count() > 600
                    || claim.evidence_ids.is_empty()
                    || claim.evidence_ids.len() > 20
                    || claim
                        .evidence_ids
                        .iter()
                        .any(|id| !known.contains(id.as_str()))
            })
        || result
            .unknowns
            .iter()
            .any(|s| s.trim().is_empty() || s.chars().count() > 150)
        || result
            .interpretations
            .iter()
            .any(|claim| claim.text.chars().count() > 250)
    {
        return Err("The model returned unsupported evidence or exceeded the answer limits. No claims were accepted.".into());
    }
    Ok(result)
}

pub fn offline_understanding() -> ModelUnderstanding {
    ModelUnderstanding {
        schema_version: 2,
        summary: None,
        interpretations: Vec::new(),
        unknowns: Vec::new(),
    }
}

/// Append only locally verified team statements whose complete basis fits the send scope.
/// # Errors
/// Rejects evidence/context budget overflow rather than sending an implicit summary.
pub fn append_confirmed_notes(
    snapshot: &DatabaseSnapshot,
    tables: &[ObjectKey],
    evidence: &mut Vec<Evidence>,
    states: &[semantic_model::knowledge::KnowledgeState],
) -> Result<bool, String> {
    use semantic_model::knowledge::{KnowledgeStatus, owning_table};
    let mut omitted = false;
    for state in states
        .iter()
        .filter(|s| s.status == KnowledgeStatus::Confirmed && s.source_id == snapshot.source_id)
    {
        let Some(record) = &state.confirmation else {
            continue;
        };
        let Some(table) = owning_table(snapshot, &state.object_key) else {
            continue;
        };
        if !tables.contains(&table) {
            continue;
        }
        if record
            .basis
            .tables
            .iter()
            .any(|(key, _)| !tables.contains(key))
        {
            omitted = true;
            continue;
        }
        evidence.push(Evidence {
            id: format!("e{}", evidence.len() + 1), table_key: table,
            object_key: state.object_key.clone(), kind: "teamStatement".into(),
            label: format!("{}.{} · confirmed team statement", state.object_key.schema, state.object_key.name),
            detail: json(&serde_json::json!({"text": record.final_text,"confirmationId":record.id,"descriptionDigest":record.description_digest,"confirmedAt":record.confirmed_at,"status":"confirmed on this device; not a database fact"}))?,
            columns: if state.object_key.kind == ObjectKind::Column { vec![state.object_key.name.clone()] } else { vec![] },
        });
    }
    if evidence.len() > MAX_EVIDENCE || json(evidence)?.len() > MAX_CONTEXT_BYTES {
        return Err("Confirmed team statements exceed the context budget. Narrow the scope or disable confirmed semantics.".into());
    }
    Ok(omitted)
}
