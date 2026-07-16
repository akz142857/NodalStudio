use std::collections::{BTreeMap, BTreeSet};

use project_model::{
    EdgeCertainty, EdgeEvidence, ProjectEdge, ProjectEdgeKind, ProjectNode, ProjectNodeKind,
    ReviewStatus,
};
use schema_model::DatabaseSnapshot;
use sha2::{Digest, Sha256};
use tree_sitter::{Language, Node, Parser};
use uuid::Uuid;

use crate::{
    AnalysisBatch, AnalysisDiagnostic, AnalysisError, CodeAnalyzer, GenericSqlAnalyzer,
    SourceDocument, add_node, file_name, known_tables, validate_document_path,
};

macro_rules! language_analyzer {
    ($name:ident, $language:expr, $id:literal, $label:literal, [$($extension:literal),+]) => {
        #[derive(Debug, Default)]
        pub struct $name;

        impl CodeAnalyzer for $name {
            fn id(&self) -> &'static str { $id }

            fn supports(&self, document: &SourceDocument) -> bool {
                document.language.eq_ignore_ascii_case($label)
                    || document.relative_path.rsplit_once('.').is_some_and(|(_, extension)| {
                        matches!(extension.to_ascii_lowercase().as_str(), $($extension)|+)
                    })
            }

            fn analyze(
                &self,
                project_id: Uuid,
                scan_id: Uuid,
                document: &SourceDocument,
                snapshot: &DatabaseSnapshot,
            ) -> Result<AnalysisBatch, AnalysisError> {
                analyze_language(project_id, scan_id, document, snapshot, &$language.into(), self.id(), $label)
            }
        }
    };
}

language_analyzer!(
    RustAnalyzer,
    tree_sitter_rust::LANGUAGE,
    "rust-tree-sitter-v1",
    "rust",
    ["rs"]
);
language_analyzer!(
    JavaAnalyzer,
    tree_sitter_java::LANGUAGE,
    "java-tree-sitter-v1",
    "java",
    ["java"]
);
language_analyzer!(
    GoAnalyzer,
    tree_sitter_go::LANGUAGE,
    "go-tree-sitter-v1",
    "go",
    ["go"]
);
language_analyzer!(
    PythonAnalyzer,
    tree_sitter_python::LANGUAGE,
    "python-tree-sitter-v1",
    "python",
    ["py"]
);

fn analyze_language(
    project_id: Uuid,
    scan_id: Uuid,
    document: &SourceDocument,
    snapshot: &DatabaseSnapshot,
    language: &Language,
    analyzer: &'static str,
    language_name: &'static str,
) -> Result<AnalysisBatch, AnalysisError> {
    validate_document_path(document)?;
    let mut parser = Parser::new();
    parser
        .set_language(language)
        .map_err(|_| AnalysisError::ParserLanguage)?;
    let tree = parser
        .parse(&document.contents, None)
        .ok_or(AnalysisError::ParserFailed)?;
    let file_id =
        ProjectNode::stable_id(project_id, ProjectNodeKind::File, &document.relative_path);
    let mut batch = AnalysisBatch::default();
    let mut node_ids = BTreeSet::new();
    add_node(
        &mut batch.nodes,
        &mut node_ids,
        ProjectNode {
            id: file_id.clone(),
            project_id,
            kind: ProjectNodeKind::File,
            name: file_name(&document.relative_path).into(),
            qualified_name: document.relative_path.clone(),
            relative_path: Some(document.relative_path.clone()),
            line: Some(1),
            database_object: None,
            attributes: BTreeMap::from([("language".into(), language_name.into())]),
        },
    );
    if tree.root_node().has_error() {
        batch.diagnostics.push(AnalysisDiagnostic {
            relative_path: document.relative_path.clone(),
            line: None,
            message: format!("{language_name} parser recovered from syntax errors; only valid AST declarations were indexed."),
        });
    }
    collect_declarations(
        tree.root_node(),
        project_id,
        scan_id,
        document,
        analyzer,
        &file_id,
        &mut batch,
        &mut node_ids,
    );
    add_convention_mappings(
        project_id,
        scan_id,
        document,
        snapshot,
        analyzer,
        &file_id,
        &mut batch,
        &mut node_ids,
    );
    merge_embedded_sql(project_id, scan_id, document, snapshot, &mut batch)?;
    batch.nodes.sort_by(|left, right| left.id.cmp(&right.id));
    batch.nodes.dedup_by(|left, right| left.id == right.id);
    batch.edges.sort_by(|left, right| left.id.cmp(&right.id));
    batch.edges.dedup_by(|left, right| left.id == right.id);
    Ok(batch)
}

#[allow(clippy::too_many_arguments)]
fn collect_declarations(
    node: Node<'_>,
    project_id: Uuid,
    scan_id: Uuid,
    document: &SourceDocument,
    analyzer: &str,
    file_id: &str,
    batch: &mut AnalysisBatch,
    node_ids: &mut BTreeSet<String>,
) {
    if is_declaration(node.kind())
        && let Some(name_node) = node.child_by_field_name("name")
        && let Ok(name) = name_node.utf8_text(document.contents.as_bytes())
    {
        let kind = symbol_kind(name, node.kind());
        let identity = format!("{}#{name}", document.relative_path);
        let id = ProjectNode::stable_id(project_id, kind, &identity);
        add_node(
            &mut batch.nodes,
            node_ids,
            ProjectNode {
                id: id.clone(),
                project_id,
                kind,
                name: name.into(),
                qualified_name: identity,
                relative_path: Some(document.relative_path.clone()),
                line: Some(line(node)),
                database_object: None,
                attributes: BTreeMap::new(),
            },
        );
        batch.edges.push(make_edge(
            project_id,
            scan_id,
            document,
            analyzer,
            file_id,
            &id,
            ProjectEdgeKind::Contains,
            node,
            "Tree-sitter declaration is contained by this file",
        ));
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_declarations(
            child, project_id, scan_id, document, analyzer, file_id, batch, node_ids,
        );
    }
}

fn is_declaration(kind: &str) -> bool {
    matches!(
        kind,
        "function_item"
            | "struct_item"
            | "enum_item"
            | "trait_item"
            | "class_declaration"
            | "interface_declaration"
            | "method_declaration"
            | "function_declaration"
            | "method_definition"
            | "function_definition"
            | "class_definition"
    )
}

fn symbol_kind(name: &str, syntax_kind: &str) -> ProjectNodeKind {
    if name.ends_with("Service") || name.ends_with("_service") {
        ProjectNodeKind::Service
    } else if name.ends_with("Repository") || name.ends_with("_repository") {
        ProjectNodeKind::Repository
    } else if syntax_kind.contains("class") || syntax_kind == "struct_item" {
        ProjectNodeKind::OrmModel
    } else {
        ProjectNodeKind::Symbol
    }
}

#[allow(clippy::too_many_arguments)]
fn add_convention_mappings(
    project_id: Uuid,
    scan_id: Uuid,
    document: &SourceDocument,
    snapshot: &DatabaseSnapshot,
    analyzer: &str,
    file_id: &str,
    batch: &mut AnalysisBatch,
    node_ids: &mut BTreeSet<String>,
) {
    let source = document.contents.to_ascii_lowercase();
    for table in known_tables(snapshot).into_values() {
        if !has_table_declaration(&source, &table.name) {
            continue;
        }
        let identity = format!("{}.{}", table.schema, table.name);
        let table_id = ProjectNode::stable_id(project_id, ProjectNodeKind::Table, &identity);
        add_node(
            &mut batch.nodes,
            node_ids,
            ProjectNode {
                id: table_id.clone(),
                project_id,
                kind: ProjectNodeKind::Table,
                name: table.name.clone(),
                qualified_name: identity,
                relative_path: None,
                line: None,
                database_object: Some(table),
                attributes: BTreeMap::new(),
            },
        );
        batch.edges.push(make_file_edge(
            project_id,
            scan_id,
            document,
            analyzer,
            file_id,
            &table_id,
            ProjectEdgeKind::MapsTo,
            "Framework table declaration maps this file to an existing database table",
        ));
    }
}

fn has_table_declaration(source: &str, table: &str) -> bool {
    let quoted = [format!("\"{table}\""), format!("'{table}'")];
    let marker = source.contains("@table")
        || source.contains("__tablename__")
        || source.contains("table_name")
        || source.contains(".table(")
        || source.contains("table(");
    marker && quoted.iter().any(|value| source.contains(value))
}

fn merge_embedded_sql(
    project_id: Uuid,
    scan_id: Uuid,
    document: &SourceDocument,
    snapshot: &DatabaseSnapshot,
    batch: &mut AnalysisBatch,
) -> Result<(), AnalysisError> {
    let masked = quoted_sql_only(&document.contents);
    if masked.trim().is_empty() {
        return Ok(());
    }
    let sql_document = SourceDocument {
        relative_path: document.relative_path.clone(),
        language: "sql".into(),
        contents: masked,
    };
    let sql = GenericSqlAnalyzer.analyze(project_id, scan_id, &sql_document, snapshot)?;
    batch.nodes.extend(sql.nodes);
    batch.edges.extend(sql.edges);
    batch.diagnostics.extend(sql.diagnostics);
    Ok(())
}

fn quoted_sql_only(source: &str) -> String {
    let mut output = source
        .bytes()
        .map(|byte| if byte == b'\n' { b'\n' } else { b' ' })
        .collect::<Vec<_>>();
    let bytes = source.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        let quote = bytes[index];
        if !matches!(quote, b'\'' | b'"' | b'`') {
            index += 1;
            continue;
        }
        let start = index + 1;
        index = start;
        while index < bytes.len() && bytes[index] != quote {
            if bytes[index] == b'\\' {
                index += 1;
            }
            index += 1;
        }
        let end = index.min(bytes.len());
        let fragment = source[start..end].to_ascii_lowercase();
        if ["select ", "insert ", "update ", "delete "]
            .iter()
            .any(|keyword| fragment.contains(keyword))
        {
            for (offset, byte) in bytes[start..end].iter().enumerate() {
                output[start + offset] = *byte;
            }
            if end < output.len() {
                output[end] = b';';
            }
        }
        index = end.saturating_add(1);
    }
    String::from_utf8(output).unwrap_or_default()
}

#[allow(clippy::too_many_arguments)]
fn make_file_edge(
    project_id: Uuid,
    scan_id: Uuid,
    document: &SourceDocument,
    analyzer: &str,
    source_id: &str,
    target_id: &str,
    kind: ProjectEdgeKind,
    explanation: &str,
) -> ProjectEdge {
    ProjectEdge {
        id: ProjectEdge::stable_id(source_id, target_id, kind),
        source_id: source_id.into(),
        target_id: target_id.into(),
        kind,
        certainty: EdgeCertainty::Convention,
        review_status: ReviewStatus::NotRequired,
        evidence: vec![EdgeEvidence {
            id: hex::encode(Sha256::digest(
                format!("{}:{analyzer}:{explanation}", document.relative_path).as_bytes(),
            )),
            project_id,
            relative_path: document.relative_path.clone(),
            start_line: Some(1),
            end_line: None,
            symbol: None,
            analyzer: analyzer.into(),
            excerpt_hash: Some(hex::encode(Sha256::digest(document.contents.as_bytes()))),
            explanation: Some(explanation.into()),
        }],
        scan_id,
    }
}

#[allow(clippy::too_many_arguments)]
fn make_edge(
    project_id: Uuid,
    scan_id: Uuid,
    document: &SourceDocument,
    analyzer: &str,
    source_id: &str,
    target_id: &str,
    kind: ProjectEdgeKind,
    node: Node<'_>,
    explanation: &str,
) -> ProjectEdge {
    ProjectEdge {
        id: ProjectEdge::stable_id(source_id, target_id, kind),
        source_id: source_id.into(),
        target_id: target_id.into(),
        kind,
        certainty: EdgeCertainty::Static,
        review_status: ReviewStatus::NotRequired,
        evidence: vec![EdgeEvidence {
            id: hex::encode(Sha256::digest(
                format!(
                    "{}:{}:{analyzer}:{explanation}",
                    document.relative_path,
                    line(node)
                )
                .as_bytes(),
            )),
            project_id,
            relative_path: document.relative_path.clone(),
            start_line: Some(line(node)),
            end_line: Some(u32::try_from(node.end_position().row).unwrap_or(u32::MAX) + 1),
            symbol: None,
            analyzer: analyzer.into(),
            excerpt_hash: node
                .utf8_text(document.contents.as_bytes())
                .ok()
                .map(|text| hex::encode(Sha256::digest(text.as_bytes()))),
            explanation: Some(explanation.into()),
        }],
        scan_id,
    }
}

fn line(node: Node<'_>) -> u32 {
    u32::try_from(node.start_position().row).unwrap_or(u32::MAX) + 1
}

#[cfg(test)]
mod tests {
    use schema_model::{
        DatabaseInfo, DatabaseSnapshot, DatabaseType, SchemaDefinition, TableDefinition,
    };

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
                tables: vec![TableDefinition::empty("public", "orders")],
                views: Vec::new(),
                enums: Vec::new(),
            }],
        )
    }

    #[test]
    fn adapters_extract_declarations_and_embedded_sql() {
        let fixtures: [(&dyn CodeAnalyzer, SourceDocument); 4] = [
            (
                &RustAnalyzer,
                SourceDocument {
                    relative_path: "src/orders.rs".into(),
                    language: "rust".into(),
                    contents: "fn list_orders() { sqlx::query(\"SELECT * FROM orders\"); }".into(),
                },
            ),
            (
                &JavaAnalyzer,
                SourceDocument {
                    relative_path: "src/OrderService.java".into(),
                    language: "java".into(),
                    contents:
                        "class OrderService { void list() { query(\"SELECT * FROM orders\"); } }"
                            .into(),
                },
            ),
            (
                &GoAnalyzer,
                SourceDocument {
                    relative_path: "orders.go".into(),
                    language: "go".into(),
                    contents: "package app\nfunc ListOrders() { db.Raw(\"SELECT * FROM orders\") }"
                        .into(),
                },
            ),
            (
                &PythonAnalyzer,
                SourceDocument {
                    relative_path: "orders.py".into(),
                    language: "python".into(),
                    contents: "def list_orders():\n    db.execute(\"SELECT * FROM orders\")".into(),
                },
            ),
        ];
        for (analyzer, document) in fixtures {
            let batch = analyzer
                .analyze(Uuid::nil(), Uuid::nil(), &document, &snapshot())
                .unwrap();
            assert!(
                batch
                    .nodes
                    .iter()
                    .any(|node| node.kind == ProjectNodeKind::Symbol)
            );
            assert!(
                batch
                    .edges
                    .iter()
                    .any(|edge| edge.kind == ProjectEdgeKind::Reads)
            );
        }
    }
}
