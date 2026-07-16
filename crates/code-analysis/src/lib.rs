//! Deterministic, evidence-producing code and SQL analysis adapters.

use std::collections::{BTreeMap, BTreeSet};

use project_model::{
    EdgeCertainty, EdgeEvidence, ProjectEdge, ProjectEdgeKind, ProjectNode, ProjectNodeKind,
    ReviewStatus,
};
use schema_model::{DatabaseSnapshot, ObjectKey};
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

mod polyglot;
mod prisma;
mod typescript;

pub use polyglot::{GoAnalyzer, JavaAnalyzer, PythonAnalyzer, RustAnalyzer};
pub use prisma::PrismaSchemaAnalyzer;
pub use typescript::TypeScriptAnalyzer;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceDocument {
    pub relative_path: String,
    pub language: String,
    pub contents: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct AnalysisBatch {
    pub nodes: Vec<ProjectNode>,
    pub edges: Vec<ProjectEdge>,
    pub diagnostics: Vec<AnalysisDiagnostic>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AnalysisDiagnostic {
    pub relative_path: String,
    pub line: Option<u32>,
    pub message: String,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum AnalysisError {
    #[error("source document path must be relative")]
    AbsoluteDocumentPath,
    #[error("the syntax parser could not load the requested language")]
    ParserLanguage,
    #[error("the syntax parser did not produce a tree")]
    ParserFailed,
}

pub trait CodeAnalyzer {
    fn id(&self) -> &'static str;
    fn supports(&self, document: &SourceDocument) -> bool;

    /// Analyzes one document into normalized graph nodes, edges, and evidence.
    ///
    /// # Errors
    ///
    /// Returns an error when the document violates the local-project path boundary.
    fn analyze(
        &self,
        project_id: Uuid,
        scan_id: Uuid,
        document: &SourceDocument,
        snapshot: &DatabaseSnapshot,
    ) -> Result<AnalysisBatch, AnalysisError>;
}

#[derive(Debug, Default)]
pub struct GenericSqlAnalyzer;

impl CodeAnalyzer for GenericSqlAnalyzer {
    fn id(&self) -> &'static str {
        "generic-sql-v1"
    }

    fn supports(&self, document: &SourceDocument) -> bool {
        document.language.eq_ignore_ascii_case("sql")
            || document
                .relative_path
                .rsplit_once('.')
                .is_some_and(|(_, extension)| extension.eq_ignore_ascii_case("sql"))
    }

    fn analyze(
        &self,
        project_id: Uuid,
        scan_id: Uuid,
        document: &SourceDocument,
        snapshot: &DatabaseSnapshot,
    ) -> Result<AnalysisBatch, AnalysisError> {
        validate_document_path(document)?;
        let known_tables = known_tables(snapshot);
        let known_columns = known_columns(snapshot);
        let statements = sql_statements(&document.contents);
        let file_id =
            ProjectNode::stable_id(project_id, ProjectNodeKind::File, &document.relative_path);
        let mut batch = AnalysisBatch::default();
        let mut node_ids = BTreeSet::new();
        add_node(
            &mut batch.nodes,
            &mut node_ids,
            source_file_node(project_id, document, &file_id),
        );

        for (index, statement) in statements.iter().enumerate() {
            let relations = statement_relations(statement, &known_tables);
            if relations.is_empty() {
                continue;
            }
            let query_identity = format!("{}#{}", document.relative_path, index + 1);
            let node_kind = if is_migration_operation(&statement.operation) {
                ProjectNodeKind::Migration
            } else {
                ProjectNodeKind::Query
            };
            let query_id = ProjectNode::stable_id(project_id, node_kind, &query_identity);
            add_node(
                &mut batch.nodes,
                &mut node_ids,
                ProjectNode {
                    id: query_id.clone(),
                    project_id,
                    kind: node_kind,
                    name: format!(
                        "{} {}",
                        if node_kind == ProjectNodeKind::Migration {
                            "Migration"
                        } else {
                            "Query"
                        },
                        index + 1
                    ),
                    qualified_name: query_identity,
                    relative_path: Some(document.relative_path.clone()),
                    line: Some(statement.start_line),
                    database_object: None,
                    attributes: BTreeMap::from([("operation".into(), statement.operation.clone())]),
                },
            );
            batch.edges.push(edge(
                scan_id,
                &file_id,
                &query_id,
                ProjectEdgeKind::Contains,
                evidence(
                    project_id,
                    self.id(),
                    document,
                    statement,
                    "SQL statement declared in this file",
                ),
            ));
            add_sql_object_relations(
                project_id,
                scan_id,
                self.id(),
                document,
                statement,
                &query_id,
                &relations,
                &known_tables,
                &known_columns,
                &mut batch,
                &mut node_ids,
            );
        }
        batch.nodes.sort_by(|left, right| left.id.cmp(&right.id));
        batch.edges.sort_by(|left, right| left.id.cmp(&right.id));
        batch.edges.dedup_by(|left, right| left.id == right.id);
        Ok(batch)
    }
}

/// Runs every compatible analyzer and merges stable graph identifiers.
///
/// # Errors
///
/// Returns the first adapter error for an unsafe document path.
pub fn analyze_documents(
    project_id: Uuid,
    scan_id: Uuid,
    documents: &[SourceDocument],
    snapshot: &DatabaseSnapshot,
) -> Result<AnalysisBatch, AnalysisError> {
    let analyzers: [&dyn CodeAnalyzer; 7] = [
        &GenericSqlAnalyzer,
        &TypeScriptAnalyzer,
        &PrismaSchemaAnalyzer,
        &RustAnalyzer,
        &JavaAnalyzer,
        &GoAnalyzer,
        &PythonAnalyzer,
    ];
    let mut merged = AnalysisBatch::default();
    for document in documents {
        for analyzer in analyzers
            .iter()
            .filter(|analyzer| analyzer.supports(document))
        {
            let batch = analyzer.analyze(project_id, scan_id, document, snapshot)?;
            merged.nodes.extend(batch.nodes);
            merged.edges.extend(batch.edges);
            merged.diagnostics.extend(batch.diagnostics);
        }
    }
    merged.nodes.sort_by(|left, right| left.id.cmp(&right.id));
    merged.nodes.dedup_by(|left, right| left.id == right.id);
    merged.edges.sort_by(|left, right| left.id.cmp(&right.id));
    merged.edges.dedup_by(|left, right| left.id == right.id);
    Ok(merged)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Token {
    value: String,
    line: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SqlStatement {
    tokens: Vec<Token>,
    start_line: u32,
    end_line: u32,
    operation: String,
    excerpt_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TableRelation {
    table: ObjectKey,
    kind: ProjectEdgeKind,
    explanation: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ColumnRelation {
    column: ObjectKey,
    kind: ProjectEdgeKind,
}

#[allow(clippy::too_many_arguments)]
fn add_sql_object_relations(
    project_id: Uuid,
    scan_id: Uuid,
    analyzer: &str,
    document: &SourceDocument,
    statement: &SqlStatement,
    query_id: &str,
    relations: &[TableRelation],
    known_tables: &BTreeMap<String, ObjectKey>,
    known_columns: &BTreeMap<ObjectKey, BTreeSet<String>>,
    batch: &mut AnalysisBatch,
    node_ids: &mut BTreeSet<String>,
) {
    for relation in relations {
        let identity = format!("{}.{}", relation.table.schema, relation.table.name);
        let id = ProjectNode::stable_id(project_id, ProjectNodeKind::Table, &identity);
        add_node(
            &mut batch.nodes,
            node_ids,
            ProjectNode {
                id: id.clone(),
                project_id,
                kind: ProjectNodeKind::Table,
                name: relation.table.name.clone(),
                qualified_name: identity,
                relative_path: None,
                line: None,
                database_object: Some(relation.table.clone()),
                attributes: BTreeMap::new(),
            },
        );
        batch.edges.push(edge(
            scan_id,
            query_id,
            &id,
            relation.kind,
            evidence(
                project_id,
                analyzer,
                document,
                statement,
                relation.explanation,
            ),
        ));
    }
    for relation in statement_columns(statement, relations, known_tables, known_columns) {
        let identity = format!("{}.{}", relation.column.schema, relation.column.name);
        let id = ProjectNode::stable_id(project_id, ProjectNodeKind::Column, &identity);
        add_node(
            &mut batch.nodes,
            node_ids,
            ProjectNode {
                id: id.clone(),
                project_id,
                kind: ProjectNodeKind::Column,
                name: relation.column.name.clone(),
                qualified_name: identity,
                relative_path: None,
                line: None,
                database_object: Some(relation.column),
                attributes: BTreeMap::new(),
            },
        );
        batch.edges.push(edge(
            scan_id,
            query_id,
            &id,
            relation.kind,
            evidence(
                project_id,
                analyzer,
                document,
                statement,
                "SQL parser tokens reference this database column",
            ),
        ));
    }
}

fn sql_statements(sql: &str) -> Vec<SqlStatement> {
    tokenize(sql)
        .split(|token| token.value == ";")
        .filter(|tokens| !tokens.is_empty())
        .map(|tokens| {
            let operation = tokens.first().map_or_else(
                || "unknown".into(),
                |token| token.value.to_ascii_lowercase(),
            );
            let excerpt = tokens
                .iter()
                .map(|token| token.value.as_str())
                .collect::<Vec<_>>()
                .join(" ");
            SqlStatement {
                start_line: tokens.first().map_or(1, |token| token.line),
                end_line: tokens.last().map_or(1, |token| token.line),
                operation,
                excerpt_hash: hex::encode(Sha256::digest(excerpt.as_bytes())),
                tokens: tokens.to_vec(),
            }
        })
        .collect()
}

fn statement_relations(
    statement: &SqlStatement,
    known_tables: &BTreeMap<String, ObjectKey>,
) -> Vec<TableRelation> {
    let lower: Vec<_> = statement
        .tokens
        .iter()
        .map(|token| token.value.to_ascii_lowercase())
        .collect();
    let mut relations = Vec::new();
    for (index, keyword) in lower.iter().enumerate() {
        let (kind, explanation) = match keyword.as_str() {
            "update" => (ProjectEdgeKind::Writes, "UPDATE writes this table"),
            "into" if lower.first().is_some_and(|value| value == "insert") => {
                (ProjectEdgeKind::Writes, "INSERT writes this table")
            }
            "from" if lower.first().is_some_and(|value| value == "delete") => {
                (ProjectEdgeKind::Writes, "DELETE writes this table")
            }
            "from" => (ProjectEdgeKind::Reads, "SELECT reads this table"),
            "join" => (ProjectEdgeKind::Joins, "JOIN relates this table"),
            "table"
                if index == 1
                    && lower.first().is_some_and(|value| {
                        matches!(value.as_str(), "create" | "alter" | "drop")
                    }) =>
            {
                (ProjectEdgeKind::Changes, "DDL changes this table")
            }
            _ => continue,
        };
        if let Some(table) = table_after(&statement.tokens, index + 1, known_tables) {
            relations.push(TableRelation {
                table,
                kind,
                explanation,
            });
        }
    }
    relations.sort_by(|left, right| {
        left.table
            .cmp(&right.table)
            .then_with(|| format!("{:?}", left.kind).cmp(&format!("{:?}", right.kind)))
    });
    relations.dedup_by(|left, right| left.table == right.table && left.kind == right.kind);
    relations
}

fn is_migration_operation(operation: &str) -> bool {
    matches!(operation, "create" | "alter" | "drop" | "truncate")
}

fn statement_columns(
    statement: &SqlStatement,
    relations: &[TableRelation],
    known_tables: &BTreeMap<String, ObjectKey>,
    known_columns: &BTreeMap<ObjectKey, BTreeSet<String>>,
) -> Vec<ColumnRelation> {
    let aliases = statement_table_aliases(statement, known_tables);
    let mut columns = Vec::new();
    for (index, token) in statement.tokens.iter().enumerate() {
        let name = token.value.to_ascii_lowercase();
        let qualified_table = index
            .checked_sub(2)
            .filter(|_| {
                statement
                    .tokens
                    .get(index - 1)
                    .is_some_and(|item| item.value == ".")
            })
            .and_then(|prefix| aliases.get(&statement.tokens[prefix].value.to_ascii_lowercase()));
        let matching = relations
            .iter()
            .filter(|relation| qualified_table.is_none_or(|table| *table == relation.table))
            .filter(|relation| {
                known_columns
                    .get(&relation.table)
                    .is_some_and(|items| items.contains(&name))
            })
            .collect::<Vec<_>>();
        if matching.len() != 1
            || qualified_table.is_none()
                && (statement
                    .tokens
                    .get(index.wrapping_sub(1))
                    .is_some_and(|item| item.value == ".")
                    || statement
                        .tokens
                        .get(index + 1)
                        .is_some_and(|item| item.value == "."))
        {
            continue;
        }
        let table = &matching[0].table;
        columns.push(ColumnRelation {
            column: table.child(
                schema_model::ObjectKind::Column,
                token.value.trim_matches('"'),
            ),
            kind: if matches!(
                matching[0].kind,
                ProjectEdgeKind::Writes | ProjectEdgeKind::Changes
            ) {
                matching[0].kind
            } else {
                ProjectEdgeKind::Reads
            },
        });
    }
    columns.sort_by(|left, right| {
        left.column
            .cmp(&right.column)
            .then_with(|| format!("{:?}", left.kind).cmp(&format!("{:?}", right.kind)))
    });
    columns.dedup();
    columns
}

fn statement_table_aliases(
    statement: &SqlStatement,
    known_tables: &BTreeMap<String, ObjectKey>,
) -> BTreeMap<String, ObjectKey> {
    let mut aliases = BTreeMap::new();
    for index in 0..statement.tokens.len() {
        if !matches!(
            statement.tokens[index].value.to_ascii_lowercase().as_str(),
            "from" | "join" | "update" | "into"
        ) {
            continue;
        }
        let Some(table) = table_after(&statement.tokens, index + 1, known_tables) else {
            continue;
        };
        aliases.insert(table.name.to_ascii_lowercase(), table.clone());
        let table_end = if statement
            .tokens
            .get(index + 2)
            .is_some_and(|token| token.value == ".")
        {
            index + 3
        } else {
            index + 1
        };
        let alias_index = if statement
            .tokens
            .get(table_end + 1)
            .is_some_and(|token| token.value.eq_ignore_ascii_case("as"))
        {
            table_end + 2
        } else {
            table_end + 1
        };
        if let Some(alias) = statement
            .tokens
            .get(alias_index)
            .map(|token| token.value.to_ascii_lowercase())
            .filter(|value| {
                !matches!(
                    value.as_str(),
                    "set" | "where" | "join" | "on" | "order" | "group" | "limit" | "," | "(" | ")"
                )
            })
        {
            aliases.insert(alias, table);
        }
    }
    aliases
}

fn table_after(
    tokens: &[Token],
    index: usize,
    known_tables: &BTreeMap<String, ObjectKey>,
) -> Option<ObjectKey> {
    let first = tokens.get(index)?.value.trim_matches('"');
    if first == "(" {
        return None;
    }
    let candidate = if tokens
        .get(index + 1)
        .is_some_and(|token| token.value == ".")
    {
        format!(
            "{}.{}",
            first,
            tokens.get(index + 2)?.value.trim_matches('"')
        )
    } else {
        first.to_owned()
    };
    known_tables.get(&candidate.to_ascii_lowercase()).cloned()
}

pub(crate) fn known_tables(snapshot: &DatabaseSnapshot) -> BTreeMap<String, ObjectKey> {
    let mut tables = BTreeMap::new();
    for table in snapshot.schemas.iter().flat_map(|schema| &schema.tables) {
        tables.insert(
            format!("{}.{}", table.key.schema, table.key.name).to_ascii_lowercase(),
            table.key.clone(),
        );
        tables
            .entry(table.key.name.to_ascii_lowercase())
            .or_insert_with(|| table.key.clone());
    }
    tables
}

fn known_columns(snapshot: &DatabaseSnapshot) -> BTreeMap<ObjectKey, BTreeSet<String>> {
    snapshot
        .schemas
        .iter()
        .flat_map(|schema| &schema.tables)
        .map(|table| {
            (
                table.key.clone(),
                table
                    .columns
                    .iter()
                    .map(|column| column.name.to_ascii_lowercase())
                    .collect(),
            )
        })
        .collect()
}

pub(crate) fn add_node(
    nodes: &mut Vec<ProjectNode>,
    ids: &mut BTreeSet<String>,
    node: ProjectNode,
) {
    if ids.insert(node.id.clone()) {
        nodes.push(node);
    }
}

fn edge(
    scan_id: Uuid,
    source_id: &str,
    target_id: &str,
    kind: ProjectEdgeKind,
    evidence: EdgeEvidence,
) -> ProjectEdge {
    ProjectEdge {
        id: ProjectEdge::stable_id(source_id, target_id, kind),
        source_id: source_id.into(),
        target_id: target_id.into(),
        kind,
        certainty: EdgeCertainty::Declared,
        review_status: ReviewStatus::NotRequired,
        evidence: vec![evidence],
        scan_id,
    }
}

fn evidence(
    project_id: Uuid,
    analyzer: &str,
    document: &SourceDocument,
    statement: &SqlStatement,
    explanation: &str,
) -> EdgeEvidence {
    EdgeEvidence {
        id: hex::encode(Sha256::digest(
            format!(
                "{}:{}:{}:{}",
                document.relative_path, statement.start_line, analyzer, explanation
            )
            .as_bytes(),
        )),
        project_id,
        relative_path: document.relative_path.clone(),
        start_line: Some(statement.start_line),
        end_line: Some(statement.end_line),
        symbol: None,
        analyzer: analyzer.into(),
        excerpt_hash: Some(statement.excerpt_hash.clone()),
        explanation: Some(explanation.into()),
    }
}

pub(crate) fn file_name(relative_path: &str) -> &str {
    relative_path.rsplit('/').next().unwrap_or(relative_path)
}

fn source_file_node(project_id: Uuid, document: &SourceDocument, file_id: &str) -> ProjectNode {
    ProjectNode {
        id: file_id.into(),
        project_id,
        kind: ProjectNodeKind::File,
        name: file_name(&document.relative_path).to_owned(),
        qualified_name: document.relative_path.clone(),
        relative_path: Some(document.relative_path.clone()),
        line: Some(1),
        database_object: None,
        attributes: BTreeMap::from([("language".into(), "sql".into())]),
    }
}

pub(crate) fn validate_document_path(document: &SourceDocument) -> Result<(), AnalysisError> {
    if std::path::Path::new(&document.relative_path).is_absolute()
        || document.relative_path.split('/').any(|part| part == "..")
    {
        return Err(AnalysisError::AbsoluteDocumentPath);
    }
    Ok(())
}

fn tokenize(sql: &str) -> Vec<Token> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut current_line = 1_u32;
    let mut token_line = 1_u32;
    let mut chars = sql.chars().peekable();
    let mut single_quote = false;
    let mut double_quote = false;
    let mut line_comment = false;
    let mut block_comment = false;

    while let Some(character) = chars.next() {
        if character == '\n' {
            current_line += 1;
            line_comment = false;
        }
        if line_comment {
            continue;
        }
        if block_comment {
            if character == '*' && chars.peek() == Some(&'/') {
                chars.next();
                block_comment = false;
            }
            continue;
        }
        if single_quote {
            if character == '\'' {
                if chars.peek() == Some(&'\'') {
                    chars.next();
                } else {
                    single_quote = false;
                }
            }
            continue;
        }
        if character == '-' && chars.peek() == Some(&'-') {
            push_token(&mut tokens, &mut current, token_line);
            chars.next();
            line_comment = true;
            continue;
        }
        if character == '/' && chars.peek() == Some(&'*') {
            push_token(&mut tokens, &mut current, token_line);
            chars.next();
            block_comment = true;
            continue;
        }
        if character == '\'' && !double_quote {
            push_token(&mut tokens, &mut current, token_line);
            single_quote = true;
            continue;
        }
        if character == '"' {
            if current.is_empty() {
                token_line = current_line;
            }
            double_quote = !double_quote;
            continue;
        }
        if double_quote || character.is_alphanumeric() || matches!(character, '_' | '$') {
            if current.is_empty() {
                token_line = current_line;
            }
            current.push(character);
            continue;
        }
        push_token(&mut tokens, &mut current, token_line);
        if matches!(character, ';' | '.' | '(' | ')' | ',') {
            tokens.push(Token {
                value: character.to_string(),
                line: current_line,
            });
        }
    }
    push_token(&mut tokens, &mut current, token_line);
    tokens
}

fn push_token(tokens: &mut Vec<Token>, current: &mut String, line: u32) {
    if !current.is_empty() {
        tokens.push(Token {
            value: std::mem::take(current),
            line,
        });
    }
}

#[cfg(test)]
mod tests {
    use schema_model::{
        ColumnDefinition, DatabaseInfo, DatabaseType, SchemaDefinition, TableDefinition,
    };

    use super::*;

    fn snapshot() -> DatabaseSnapshot {
        let column = |name: &str, ordinal_position: i32| ColumnDefinition {
            name: name.into(),
            ordinal_position,
            formatted_type: "text".into(),
            type_schema: "pg_catalog".into(),
            type_name: "text".into(),
            nullable: true,
            default_value: None,
            identity: None,
            generated: false,
            comment: None,
        };
        let mut orders = TableDefinition::empty("public", "orders");
        orders.columns = vec![
            column("id", 1),
            column("customer_id", 2),
            column("status", 3),
        ];
        let mut customers = TableDefinition::empty("public", "customers");
        customers.columns = vec![column("id", 1), column("name", 2)];
        let mut snapshot = DatabaseSnapshot::new(
            Uuid::new_v4(),
            DatabaseInfo {
                name: "shop".into(),
                database_type: DatabaseType::PostgreSql,
                version: "17".into(),
            },
            vec![SchemaDefinition {
                name: "public".into(),
                tables: vec![orders, customers],
                views: vec![],
                enums: vec![],
            }],
        );
        snapshot.canonicalize().unwrap();
        snapshot
    }

    #[test]
    fn extracts_reads_joins_and_writes_with_line_evidence() {
        let document = SourceDocument {
            relative_path: "queries/orders.sql".into(),
            language: "sql".into(),
            contents: "-- list\nSELECT * FROM public.orders o JOIN customers c ON c.id=o.customer_id;\nUPDATE orders SET status='paid';".into(),
        };
        let result = GenericSqlAnalyzer
            .analyze(Uuid::new_v4(), Uuid::new_v4(), &document, &snapshot())
            .unwrap();
        let kinds: Vec<_> = result.edges.iter().map(|edge| edge.kind).collect();
        assert!(kinds.contains(&ProjectEdgeKind::Reads));
        assert!(kinds.contains(&ProjectEdgeKind::Joins));
        assert!(kinds.contains(&ProjectEdgeKind::Writes));
        assert!(
            result
                .edges
                .iter()
                .all(|edge| edge.evidence[0].relative_path == "queries/orders.sql")
        );
    }

    #[test]
    fn extracts_unambiguous_and_alias_qualified_columns() {
        let document = SourceDocument { relative_path: "queries/columns.sql".into(), language: "sql".into(), contents: "SELECT o.status, c.name FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = 1;".into() };
        let result = GenericSqlAnalyzer
            .analyze(Uuid::new_v4(), Uuid::new_v4(), &document, &snapshot())
            .unwrap();
        let columns = result
            .nodes
            .iter()
            .filter(|node| node.kind == ProjectNodeKind::Column)
            .filter_map(|node| node.database_object.as_ref())
            .cloned()
            .collect::<BTreeSet<_>>();
        assert!(columns.contains(
            &ObjectKey::table("public", "orders").child(schema_model::ObjectKind::Column, "status")
        ));
        assert!(
            columns.contains(
                &ObjectKey::table("public", "customers")
                    .child(schema_model::ObjectKind::Column, "name")
            )
        );
        assert!(
            columns.contains(
                &ObjectKey::table("public", "orders")
                    .child(schema_model::ObjectKind::Column, "customer_id")
            )
        );
        assert!(columns.contains(
            &ObjectKey::table("public", "orders").child(schema_model::ObjectKind::Column, "id")
        ));
        assert!(columns.contains(
            &ObjectKey::table("public", "customers").child(schema_model::ObjectKind::Column, "id")
        ));
    }

    #[test]
    fn skips_ambiguous_unqualified_columns() {
        let document = SourceDocument {
            relative_path: "queries/ambiguous.sql".into(),
            language: "sql".into(),
            contents: "SELECT id FROM orders JOIN customers ON orders.customer_id = customers.id;"
                .into(),
        };
        let result = GenericSqlAnalyzer
            .analyze(Uuid::new_v4(), Uuid::new_v4(), &document, &snapshot())
            .unwrap();
        let id_columns = result
            .nodes
            .iter()
            .filter(|node| node.kind == ProjectNodeKind::Column && node.name == "id")
            .count();
        assert_eq!(
            id_columns, 1,
            "only customers.id is qualified; the unqualified SELECT id stays ambiguous"
        );
    }

    #[test]
    fn ignores_strings_comments_unknown_tables_and_unsafe_paths() {
        let document = SourceDocument {
            relative_path: "../outside.sql".into(),
            language: "sql".into(),
            contents: "SELECT 'FROM secrets'; -- FROM hidden\nSELECT * FROM missing;".into(),
        };
        assert_eq!(
            GenericSqlAnalyzer.analyze(Uuid::new_v4(), Uuid::new_v4(), &document, &snapshot()),
            Err(AnalysisError::AbsoluteDocumentPath)
        );
    }

    #[test]
    fn double_quoted_schema_and_table_identifiers_match_snapshot_objects() {
        let document = SourceDocument {
            relative_path: "quoted.sql".into(),
            language: "sql".into(),
            contents: "DELETE FROM \"public\".\"orders\" WHERE id = 1;".into(),
        };
        let result = GenericSqlAnalyzer
            .analyze(Uuid::new_v4(), Uuid::new_v4(), &document, &snapshot())
            .unwrap();
        assert!(
            result
                .edges
                .iter()
                .any(|edge| edge.kind == ProjectEdgeKind::Writes)
        );
    }

    #[test]
    fn represents_ddl_as_migration_changes() {
        let document = SourceDocument {
            relative_path: "migrations/002_orders.sql".into(),
            language: "sql".into(),
            contents: "ALTER TABLE public.orders ADD COLUMN note text;".into(),
        };
        let result = GenericSqlAnalyzer
            .analyze(Uuid::new_v4(), Uuid::new_v4(), &document, &snapshot())
            .unwrap();
        assert!(
            result
                .nodes
                .iter()
                .any(|node| node.kind == ProjectNodeKind::Migration)
        );
        assert!(
            result
                .edges
                .iter()
                .any(|edge| edge.kind == ProjectEdgeKind::Changes)
        );
    }
}
