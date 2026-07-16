use std::collections::{BTreeMap, BTreeSet};

use project_model::{
    EdgeCertainty, EdgeEvidence, ProjectEdge, ProjectEdgeKind, ProjectNode, ProjectNodeKind,
    ReviewStatus,
};
use schema_model::{DatabaseSnapshot, ObjectKey};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    AnalysisBatch, AnalysisError, CodeAnalyzer, SourceDocument, add_node, file_name, known_tables,
    validate_document_path,
};

#[derive(Debug, Default)]
pub struct PrismaSchemaAnalyzer;

impl CodeAnalyzer for PrismaSchemaAnalyzer {
    fn id(&self) -> &'static str {
        "prisma-schema-v1"
    }

    fn supports(&self, document: &SourceDocument) -> bool {
        document.language.eq_ignore_ascii_case("prisma")
            || document
                .relative_path
                .rsplit_once('.')
                .is_some_and(|(_, extension)| extension.eq_ignore_ascii_case("prisma"))
    }

    fn analyze(
        &self,
        project_id: Uuid,
        scan_id: Uuid,
        document: &SourceDocument,
        snapshot: &DatabaseSnapshot,
    ) -> Result<AnalysisBatch, AnalysisError> {
        validate_document_path(document)?;
        let known = known_tables(snapshot);
        let models = prisma_models(&document.contents);
        let file_id =
            ProjectNode::stable_id(project_id, ProjectNodeKind::File, &document.relative_path);
        let mut nodes = vec![ProjectNode {
            id: file_id.clone(),
            project_id,
            kind: ProjectNodeKind::File,
            name: file_name(&document.relative_path).into(),
            qualified_name: document.relative_path.clone(),
            relative_path: Some(document.relative_path.clone()),
            line: Some(1),
            database_object: None,
            attributes: BTreeMap::from([("language".into(), "prisma".into())]),
        }];
        let mut ids = BTreeSet::from([file_id.clone()]);
        let mut edges = Vec::new();
        for model in models {
            let table_name = model.mapped_table.as_deref().unwrap_or(&model.name);
            let Some(table) = match_table(table_name, &known) else {
                continue;
            };
            let model_id = ProjectNode::stable_id(
                project_id,
                ProjectNodeKind::OrmModel,
                &format!("{}#{}", document.relative_path, model.name),
            );
            let table_id = ProjectNode::stable_id(
                project_id,
                ProjectNodeKind::Table,
                &format!("{}.{}", table.schema, table.name),
            );
            add_node(
                &mut nodes,
                &mut ids,
                ProjectNode {
                    id: model_id.clone(),
                    project_id,
                    kind: ProjectNodeKind::OrmModel,
                    name: model.name.clone(),
                    qualified_name: format!("Prisma.{}", model.name),
                    relative_path: Some(document.relative_path.clone()),
                    line: Some(model.line),
                    database_object: None,
                    attributes: BTreeMap::from([("framework".into(), "prisma".into())]),
                },
            );
            add_node(
                &mut nodes,
                &mut ids,
                ProjectNode {
                    id: table_id.clone(),
                    project_id,
                    kind: ProjectNodeKind::Table,
                    name: table.name.clone(),
                    qualified_name: format!("{}.{}", table.schema, table.name),
                    relative_path: None,
                    line: None,
                    database_object: Some(table),
                    attributes: BTreeMap::new(),
                },
            );
            edges.push(prisma_edge(
                project_id,
                scan_id,
                &file_id,
                &model_id,
                ProjectEdgeKind::Contains,
                document,
                model.line,
                "Prisma model declared in this schema",
            ));
            edges.push(prisma_edge(
                project_id,
                scan_id,
                &model_id,
                &table_id,
                ProjectEdgeKind::MapsTo,
                document,
                model.line,
                if model.mapped_table.is_some() {
                    "Prisma @@map declares this table mapping"
                } else {
                    "Prisma model name matches this table"
                },
            ));
        }
        nodes.sort_by(|left, right| left.id.cmp(&right.id));
        edges.sort_by(|left, right| left.id.cmp(&right.id));
        edges.dedup_by(|left, right| left.id == right.id);
        Ok(AnalysisBatch {
            nodes,
            edges,
            diagnostics: vec![],
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PrismaModel {
    name: String,
    mapped_table: Option<String>,
    line: u32,
}

fn prisma_models(source: &str) -> Vec<PrismaModel> {
    let mut models = Vec::new();
    let mut current: Option<PrismaModel> = None;
    let mut depth = 0_i32;
    for (index, line) in source.lines().enumerate() {
        let trimmed = line.trim();
        if current.is_none() {
            if let Some(rest) = trimmed.strip_prefix("model ") {
                let name = rest
                    .split(|character: char| character.is_whitespace() || character == '{')
                    .next()
                    .unwrap_or("")
                    .trim();
                if !name.is_empty() {
                    current = Some(PrismaModel {
                        name: name.into(),
                        mapped_table: None,
                        line: u32::try_from(index + 1).unwrap_or(u32::MAX),
                    });
                    depth = brace_delta(trimmed);
                }
            }
            continue;
        }
        if let Some(model) = &mut current
            && let Some(mapping) = extract_quoted_argument(trimmed, "@@map")
        {
            model.mapped_table = Some(mapping);
        }
        depth += brace_delta(trimmed);
        if depth <= 0
            && let Some(model) = current.take()
        {
            models.push(model);
        }
    }
    if let Some(model) = current {
        models.push(model);
    }
    models
}

fn brace_delta(value: &str) -> i32 {
    let opens = value.chars().filter(|character| *character == '{').count();
    let closes = value.chars().filter(|character| *character == '}').count();
    i32::try_from(opens).unwrap_or(i32::MAX) - i32::try_from(closes).unwrap_or(i32::MAX)
}

fn extract_quoted_argument(value: &str, function: &str) -> Option<String> {
    let start = value.find(function)? + function.len();
    let value = value.get(start..)?.trim_start();
    let value = value.strip_prefix('(')?.trim_start();
    let quote = value.chars().next()?;
    if !matches!(quote, '\'' | '"') {
        return None;
    }
    let remainder = value.get(quote.len_utf8()..)?;
    let end = remainder.find(quote)?;
    Some(remainder.get(..end)?.to_owned())
}

fn match_table(name: &str, known: &BTreeMap<String, ObjectKey>) -> Option<ObjectKey> {
    known
        .get(&name.to_ascii_lowercase())
        .cloned()
        .or_else(|| known.get(&camel_to_snake(name)).cloned())
}

fn camel_to_snake(value: &str) -> String {
    let mut output = String::new();
    for (index, character) in value.chars().enumerate() {
        if character.is_uppercase() && index > 0 {
            output.push('_');
        }
        output.extend(character.to_lowercase());
    }
    output
}

#[allow(clippy::too_many_arguments)]
fn prisma_edge(
    project_id: Uuid,
    scan_id: Uuid,
    source_id: &str,
    target_id: &str,
    kind: ProjectEdgeKind,
    document: &SourceDocument,
    line: u32,
    explanation: &str,
) -> ProjectEdge {
    let analyzer = "prisma-schema-v1";
    ProjectEdge {
        id: ProjectEdge::stable_id(source_id, target_id, kind),
        source_id: source_id.into(),
        target_id: target_id.into(),
        kind,
        certainty: EdgeCertainty::Declared,
        review_status: ReviewStatus::NotRequired,
        evidence: vec![EdgeEvidence {
            id: hex::encode(Sha256::digest(
                format!("{}:{line}:{analyzer}:{explanation}", document.relative_path).as_bytes(),
            )),
            project_id,
            relative_path: document.relative_path.clone(),
            start_line: Some(line),
            end_line: Some(line),
            symbol: None,
            analyzer: analyzer.into(),
            excerpt_hash: None,
            explanation: Some(explanation.into()),
        }],
        scan_id,
    }
}

#[cfg(test)]
mod tests {
    use schema_model::{DatabaseInfo, DatabaseType, SchemaDefinition, TableDefinition};

    use super::*;

    fn snapshot() -> DatabaseSnapshot {
        let mut snapshot = DatabaseSnapshot::new(
            Uuid::new_v4(),
            DatabaseInfo {
                name: "app".into(),
                database_type: DatabaseType::PostgreSql,
                version: "17".into(),
            },
            vec![SchemaDefinition {
                name: "public".into(),
                tables: vec![TableDefinition::empty("public", "app_users")],
                views: vec![],
                enums: vec![],
            }],
        );
        snapshot.canonicalize().unwrap();
        snapshot
    }

    #[test]
    fn maps_prisma_models_only_to_existing_snapshot_tables() {
        let document = SourceDocument {
            relative_path: "prisma/schema.prisma".into(),
            language: "prisma".into(),
            contents: r#"
                model User {
                  id String @id
                  @@map("app_users")
                }
                model Missing { id String @id }
            "#
            .into(),
        };
        let result = PrismaSchemaAnalyzer
            .analyze(Uuid::new_v4(), Uuid::new_v4(), &document, &snapshot())
            .unwrap();
        assert!(
            result
                .edges
                .iter()
                .any(|edge| edge.kind == ProjectEdgeKind::MapsTo)
        );
        assert!(!result.nodes.iter().any(|node| node.name == "Missing"));
    }
}
