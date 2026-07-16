use std::collections::{BTreeMap, BTreeSet};

use project_model::{
    EdgeCertainty, EdgeEvidence, ProjectEdge, ProjectEdgeKind, ProjectNode, ProjectNodeKind,
    ReviewStatus,
};
use schema_model::{DatabaseSnapshot, ObjectKey};
use sha2::{Digest, Sha256};
use tree_sitter::{Node, Parser};
use uuid::Uuid;

use crate::{
    AnalysisBatch, AnalysisDiagnostic, AnalysisError, CodeAnalyzer, SourceDocument, add_node,
    file_name, known_tables, validate_document_path,
};

#[derive(Debug, Default)]
pub struct TypeScriptAnalyzer;

impl CodeAnalyzer for TypeScriptAnalyzer {
    fn id(&self) -> &'static str {
        "typescript-tree-sitter-v1"
    }

    fn supports(&self, document: &SourceDocument) -> bool {
        matches!(
            document.language.to_ascii_lowercase().as_str(),
            "typescript" | "javascript"
        ) || document
            .relative_path
            .rsplit_once('.')
            .is_some_and(|(_, extension)| {
                matches!(
                    extension.to_ascii_lowercase().as_str(),
                    "ts" | "tsx" | "mts" | "cts" | "js" | "jsx" | "mjs" | "cjs"
                )
            })
    }

    fn analyze(
        &self,
        project_id: Uuid,
        scan_id: Uuid,
        document: &SourceDocument,
        snapshot: &DatabaseSnapshot,
    ) -> Result<AnalysisBatch, AnalysisError> {
        validate_document_path(document)?;
        let mut parser = Parser::new();
        let language = if is_tsx(document) {
            tree_sitter_typescript::LANGUAGE_TSX
        } else {
            tree_sitter_typescript::LANGUAGE_TYPESCRIPT
        };
        parser
            .set_language(&language.into())
            .map_err(|_| AnalysisError::ParserLanguage)?;
        let tree = parser
            .parse(&document.contents, None)
            .ok_or(AnalysisError::ParserFailed)?;
        let mut state = TypeScriptState::new(project_id, scan_id, document, snapshot);
        if tree.root_node().has_error() {
            state.diagnostics.push(AnalysisDiagnostic {
                relative_path: document.relative_path.clone(),
                line: None,
                message: "TypeScript parser recovered from syntax errors; only valid AST nodes were indexed."
                    .into(),
            });
        }
        collect_entity_bindings(tree.root_node(), &mut state);
        collect_repository_bindings(tree.root_node(), &mut state);
        collect_symbols(tree.root_node(), None, &mut state);
        collect_calls(tree.root_node(), &mut state);
        state.finish()
    }
}

#[derive(Debug, Clone)]
struct SymbolInfo {
    id: String,
    name: String,
    qualified_name: String,
    kind: ProjectNodeKind,
    start_byte: usize,
    end_byte: usize,
}

struct TypeScriptState<'a> {
    project_id: Uuid,
    scan_id: Uuid,
    document: &'a SourceDocument,
    source: &'a [u8],
    analyzer: &'static str,
    known_tables: BTreeMap<String, ObjectKey>,
    file_id: String,
    nodes: Vec<ProjectNode>,
    node_ids: BTreeSet<String>,
    edges: Vec<ProjectEdge>,
    diagnostics: Vec<AnalysisDiagnostic>,
    symbols: Vec<SymbolInfo>,
    entity_tables: BTreeMap<String, ObjectKey>,
    repository_tables: BTreeMap<String, ObjectKey>,
    drizzle_tables: BTreeMap<String, ObjectKey>,
}

impl<'a> TypeScriptState<'a> {
    fn new(
        project_id: Uuid,
        scan_id: Uuid,
        document: &'a SourceDocument,
        snapshot: &DatabaseSnapshot,
    ) -> Self {
        let file_id =
            ProjectNode::stable_id(project_id, ProjectNodeKind::File, &document.relative_path);
        let file_node = ProjectNode {
            id: file_id.clone(),
            project_id,
            kind: ProjectNodeKind::File,
            name: file_name(&document.relative_path).into(),
            qualified_name: document.relative_path.clone(),
            relative_path: Some(document.relative_path.clone()),
            line: Some(1),
            database_object: None,
            attributes: BTreeMap::from([("language".into(), document.language.clone())]),
        };
        Self {
            project_id,
            scan_id,
            document,
            source: document.contents.as_bytes(),
            analyzer: "typescript-tree-sitter-v1",
            known_tables: known_tables(snapshot),
            file_id,
            nodes: vec![file_node],
            node_ids: BTreeSet::new(),
            edges: Vec::new(),
            diagnostics: Vec::new(),
            symbols: Vec::new(),
            entity_tables: BTreeMap::new(),
            repository_tables: BTreeMap::new(),
            drizzle_tables: BTreeMap::new(),
        }
    }

    fn finish(mut self) -> Result<AnalysisBatch, AnalysisError> {
        self.nodes.sort_by(|left, right| left.id.cmp(&right.id));
        self.nodes.dedup_by(|left, right| left.id == right.id);
        self.edges.sort_by(|left, right| left.id.cmp(&right.id));
        self.edges.dedup_by(|left, right| left.id == right.id);
        for edge in &self.edges {
            edge.validate().map_err(|_| AnalysisError::ParserFailed)?;
        }
        Ok(AnalysisBatch {
            nodes: self.nodes,
            edges: self.edges,
            diagnostics: self.diagnostics,
        })
    }

    fn text(&self, node: Node<'_>) -> &str {
        node.utf8_text(self.source).unwrap_or("")
    }

    fn add_symbol(
        &mut self,
        node: Node<'_>,
        name: &str,
        qualified_name: &str,
        kind: ProjectNodeKind,
        parent_id: Option<&str>,
    ) -> SymbolInfo {
        let id = ProjectNode::stable_id(
            self.project_id,
            kind,
            &format!("{}#{qualified_name}", self.document.relative_path),
        );
        add_node(
            &mut self.nodes,
            &mut self.node_ids,
            ProjectNode {
                id: id.clone(),
                project_id: self.project_id,
                kind,
                name: name.into(),
                qualified_name: qualified_name.into(),
                relative_path: Some(self.document.relative_path.clone()),
                line: Some(line_number(node)),
                database_object: None,
                attributes: BTreeMap::new(),
            },
        );
        self.edges.push(self.edge(
            parent_id.unwrap_or(&self.file_id),
            &id,
            ProjectEdgeKind::Contains,
            EdgeCertainty::Static,
            node,
            "AST declaration is contained by this source object",
        ));
        let info = SymbolInfo {
            id,
            name: name.into(),
            qualified_name: qualified_name.into(),
            kind,
            start_byte: node.start_byte(),
            end_byte: node.end_byte(),
        };
        self.symbols.push(info.clone());
        info
    }

    fn add_model_mapping(
        &mut self,
        node: Node<'_>,
        model_name: &str,
        table: &ObjectKey,
        framework: &str,
        certainty: EdgeCertainty,
    ) {
        let model_id = ProjectNode::stable_id(
            self.project_id,
            ProjectNodeKind::OrmModel,
            &format!("{}#{framework}.{model_name}", self.document.relative_path),
        );
        let table_id = self.add_table_node(table);
        add_node(
            &mut self.nodes,
            &mut self.node_ids,
            ProjectNode {
                id: model_id.clone(),
                project_id: self.project_id,
                kind: ProjectNodeKind::OrmModel,
                name: model_name.into(),
                qualified_name: format!("{framework}.{model_name}"),
                relative_path: Some(self.document.relative_path.clone()),
                line: Some(line_number(node)),
                database_object: None,
                attributes: BTreeMap::from([("framework".into(), framework.into())]),
            },
        );
        self.edges.push(self.edge(
            &self.file_id,
            &model_id,
            ProjectEdgeKind::Contains,
            EdgeCertainty::Static,
            node,
            "ORM model is declared in this source file",
        ));
        self.edges.push(self.edge(
            &model_id,
            &table_id,
            ProjectEdgeKind::MapsTo,
            certainty,
            node,
            "ORM declaration maps this model to the database table",
        ));
    }

    fn add_table_node(&mut self, table: &ObjectKey) -> String {
        let identity = format!("{}.{}", table.schema, table.name);
        let id = ProjectNode::stable_id(self.project_id, ProjectNodeKind::Table, &identity);
        add_node(
            &mut self.nodes,
            &mut self.node_ids,
            ProjectNode {
                id: id.clone(),
                project_id: self.project_id,
                kind: ProjectNodeKind::Table,
                name: table.name.clone(),
                qualified_name: identity,
                relative_path: None,
                line: None,
                database_object: Some(table.clone()),
                attributes: BTreeMap::new(),
            },
        );
        id
    }

    fn add_query_relation(
        &mut self,
        node: Node<'_>,
        table: &ObjectKey,
        kind: ProjectEdgeKind,
        framework: &str,
        explanation: &str,
    ) {
        let identity = format!(
            "{}#{}:{}:{kind:?}",
            self.document.relative_path,
            node.start_byte(),
            table.name
        );
        let query_id = ProjectNode::stable_id(self.project_id, ProjectNodeKind::Query, &identity);
        add_node(
            &mut self.nodes,
            &mut self.node_ids,
            ProjectNode {
                id: query_id.clone(),
                project_id: self.project_id,
                kind: ProjectNodeKind::Query,
                name: format!("{framework} query"),
                qualified_name: identity,
                relative_path: Some(self.document.relative_path.clone()),
                line: Some(line_number(node)),
                database_object: None,
                attributes: BTreeMap::from([("framework".into(), framework.into())]),
            },
        );
        let owner_id = self
            .containing_symbol(node.start_byte())
            .map_or_else(|| self.file_id.clone(), |symbol| symbol.id.clone());
        self.edges.push(self.edge(
            &owner_id,
            &query_id,
            if owner_id == self.file_id {
                ProjectEdgeKind::Contains
            } else {
                ProjectEdgeKind::Calls
            },
            EdgeCertainty::Static,
            node,
            "AST call belongs to this code symbol",
        ));
        let table_id = self.add_table_node(table);
        self.edges.push(self.edge(
            &query_id,
            &table_id,
            kind,
            EdgeCertainty::Convention,
            node,
            explanation,
        ));
    }

    fn containing_symbol(&self, byte: usize) -> Option<&SymbolInfo> {
        self.symbols
            .iter()
            .filter(|symbol| symbol.start_byte <= byte && byte < symbol.end_byte)
            .min_by_key(|symbol| symbol.end_byte - symbol.start_byte)
    }

    fn edge(
        &self,
        source_id: &str,
        target_id: &str,
        kind: ProjectEdgeKind,
        certainty: EdgeCertainty,
        node: Node<'_>,
        explanation: &str,
    ) -> ProjectEdge {
        let source_text = self.text(node);
        ProjectEdge {
            id: ProjectEdge::stable_id(source_id, target_id, kind),
            source_id: source_id.into(),
            target_id: target_id.into(),
            kind,
            certainty,
            review_status: ReviewStatus::NotRequired,
            evidence: vec![EdgeEvidence {
                id: hex::encode(Sha256::digest(
                    format!(
                        "{}:{}:{}:{explanation}",
                        self.document.relative_path,
                        line_number(node),
                        self.analyzer
                    )
                    .as_bytes(),
                )),
                project_id: self.project_id,
                relative_path: self.document.relative_path.clone(),
                start_line: Some(line_number(node)),
                end_line: Some(end_line_number(node)),
                symbol: self
                    .containing_symbol(node.start_byte())
                    .map(|symbol| symbol.qualified_name.clone()),
                analyzer: self.analyzer.into(),
                excerpt_hash: Some(hex::encode(Sha256::digest(source_text.as_bytes()))),
                explanation: Some(explanation.into()),
            }],
            scan_id: self.scan_id,
        }
    }
}

fn collect_entity_bindings(node: Node<'_>, state: &mut TypeScriptState<'_>) {
    if node.kind() == "class_declaration"
        && let Some(name_node) = node.child_by_field_name("name")
    {
        let class_name = state.text(name_node).to_owned();
        if let Some(table_name) = entity_table_name(state.text(node), &class_name)
            && let Some(table) = match_table(&table_name, &state.known_tables)
        {
            state
                .entity_tables
                .insert(class_name.clone(), table.clone());
            state.add_model_mapping(
                node,
                &class_name,
                &table,
                "typeorm",
                EdgeCertainty::Declared,
            );
        }
    }
    if node.kind() == "variable_declarator"
        && let (Some(name), Some(value)) = (
            node.child_by_field_name("name"),
            node.child_by_field_name("value"),
        )
    {
        let variable_name = state.text(name).to_owned();
        let compact = compact(state.text(value));
        if let Some(table_name) =
            call_argument(&compact, "pgTable").or_else(|| call_argument(&compact, "mysqlTable"))
            && let Some(table) = match_table(&table_name, &state.known_tables)
        {
            state
                .drizzle_tables
                .insert(variable_name.clone(), table.clone());
            state.add_model_mapping(
                node,
                &variable_name,
                &table,
                "drizzle",
                EdgeCertainty::Declared,
            );
        }
    }
    visit_children(node, |child| collect_entity_bindings(child, state));
}

fn collect_repository_bindings(node: Node<'_>, state: &mut TypeScriptState<'_>) {
    if node.kind() == "variable_declarator"
        && let (Some(name), Some(value)) = (
            node.child_by_field_name("name"),
            node.child_by_field_name("value"),
        )
    {
        let compact = compact(state.text(value));
        if let Some(entity) = call_argument(&compact, "getRepository")
            && let Some(table) = state.entity_tables.get(&entity).cloned()
        {
            state
                .repository_tables
                .insert(state.text(name).to_owned(), table);
        }
    }
    visit_children(node, |child| collect_repository_bindings(child, state));
}

fn collect_symbols(node: Node<'_>, class: Option<SymbolInfo>, state: &mut TypeScriptState<'_>) {
    let mut current_class = class;
    match node.kind() {
        "class_declaration" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                let name = state.text(name_node).to_owned();
                let kind = class_kind(&name, state.entity_tables.contains_key(&name));
                current_class = Some(state.add_symbol(node, &name, &name, kind, None));
            }
        }
        "method_definition" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                let name = state.text(name_node).to_owned();
                let qualified = current_class
                    .as_ref()
                    .map_or_else(|| name.clone(), |class| format!("{}.{}", class.name, name));
                let kind = current_class
                    .as_ref()
                    .map_or(ProjectNodeKind::Symbol, |class| class.kind);
                state.add_symbol(
                    node,
                    &name,
                    &qualified,
                    kind,
                    current_class.as_ref().map(|class| class.id.as_str()),
                );
            }
        }
        "function_declaration" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                let name = state.text(name_node).to_owned();
                state.add_symbol(node, &name, &name, ProjectNodeKind::Symbol, None);
            }
        }
        "variable_declarator" => {
            if let (Some(name), Some(value)) = (
                node.child_by_field_name("name"),
                node.child_by_field_name("value"),
            ) && matches!(value.kind(), "arrow_function" | "function_expression")
            {
                let name = state.text(name).to_owned();
                state.add_symbol(node, &name, &name, ProjectNodeKind::Symbol, None);
            }
        }
        _ => {}
    }
    visit_children(node, |child| {
        collect_symbols(child, current_class.clone(), state);
    });
}

fn collect_calls(node: Node<'_>, state: &mut TypeScriptState<'_>) {
    if node.kind() == "call_expression" {
        analyze_call(node, state);
    }
    visit_children(node, |child| collect_calls(child, state));
}

fn analyze_call(node: Node<'_>, state: &mut TypeScriptState<'_>) {
    let Some(function) = node.child_by_field_name("function") else {
        return;
    };
    let function_text = compact(state.text(function));
    let call_text = compact(state.text(node));
    if let Some((method, path)) = endpoint_call(&function_text, &call_text) {
        let endpoint_identity = format!("{method} {path}");
        let endpoint_id = ProjectNode::stable_id(
            state.project_id,
            ProjectNodeKind::Endpoint,
            &format!("{}#{endpoint_identity}", state.document.relative_path),
        );
        add_node(
            &mut state.nodes,
            &mut state.node_ids,
            ProjectNode {
                id: endpoint_id.clone(),
                project_id: state.project_id,
                kind: ProjectNodeKind::Endpoint,
                name: endpoint_identity.clone(),
                qualified_name: endpoint_identity,
                relative_path: Some(state.document.relative_path.clone()),
                line: Some(line_number(node)),
                database_object: None,
                attributes: BTreeMap::from([("method".into(), method)]),
            },
        );
        let handler = state
            .containing_symbol(node.start_byte())
            .map_or_else(|| state.file_id.clone(), |symbol| symbol.id.clone());
        state.edges.push(state.edge(
            &endpoint_id,
            &handler,
            ProjectEdgeKind::Handles,
            EdgeCertainty::Static,
            node,
            "Router call declares this endpoint in the containing symbol",
        ));
    }

    if let Some((table, kind, framework, explanation)) = orm_relation(
        &function_text,
        &call_text,
        &state.known_tables,
        &state.entity_tables,
        &state.repository_tables,
        &state.drizzle_tables,
    ) {
        state.add_query_relation(node, &table, kind, framework, explanation);
    }

    let called_name = function_text.rsplit('.').next().unwrap_or(&function_text);
    if !called_name.is_empty()
        && !function_text.contains('.')
        && let Some(target) = state
            .symbols
            .iter()
            .find(|symbol| symbol.name == called_name)
        && let Some(source) = state.containing_symbol(node.start_byte())
        && source.id != target.id
    {
        state.edges.push(state.edge(
            &source.id,
            &target.id,
            ProjectEdgeKind::Calls,
            EdgeCertainty::Static,
            node,
            "AST call resolves to a symbol declared in this file",
        ));
    }
}

fn orm_relation(
    function: &str,
    call: &str,
    known: &BTreeMap<String, ObjectKey>,
    entities: &BTreeMap<String, ObjectKey>,
    repositories: &BTreeMap<String, ObjectKey>,
    drizzle: &BTreeMap<String, ObjectKey>,
) -> Option<(ObjectKey, ProjectEdgeKind, &'static str, &'static str)> {
    if let Some(result) = prisma_relation(function, known) {
        return Some(result);
    }
    if let Some(table_name) = call_argument(call, ".from")
        && let Some(table) = drizzle
            .get(&table_name)
            .cloned()
            .or_else(|| match_table(&table_name, known))
    {
        return Some((
            table,
            ProjectEdgeKind::Reads,
            "drizzle",
            "Drizzle select().from() reads this table",
        ));
    }
    for (method, kind, explanation) in [
        (
            "insert",
            ProjectEdgeKind::Writes,
            "Drizzle insert writes this table",
        ),
        (
            "update",
            ProjectEdgeKind::Writes,
            "Drizzle update writes this table",
        ),
        (
            "delete",
            ProjectEdgeKind::Writes,
            "Drizzle delete writes this table",
        ),
    ] {
        if let Some(table_name) = call_argument(call, &format!(".{method}"))
            .or_else(|| call_argument(call, &format!("db.{method}")))
            && let Some(table) = drizzle
                .get(&table_name)
                .cloned()
                .or_else(|| match_table(&table_name, known))
        {
            return Some((table, kind, "drizzle", explanation));
        }
    }

    let operation = function.rsplit('.').next()?;
    let kind = typeorm_operation(operation)?;
    let owner = function.split('.').next().unwrap_or("");
    if let Some(table) = repositories.get(owner).cloned() {
        return Some((
            table,
            kind,
            "typeorm",
            "TypeORM Repository operation targets this entity table",
        ));
    }
    if let Some(entity) = call_argument(call, "getRepository")
        && let Some(table) = entities.get(&entity).cloned()
    {
        return Some((
            table,
            kind,
            "typeorm",
            "TypeORM getRepository operation targets this entity table",
        ));
    }
    None
}

fn prisma_relation(
    function: &str,
    known: &BTreeMap<String, ObjectKey>,
) -> Option<(ObjectKey, ProjectEdgeKind, &'static str, &'static str)> {
    let parts: Vec<_> = function.split('.').collect();
    let prisma = parts.iter().position(|part| *part == "prisma")?;
    let model = *parts.get(prisma + 1)?;
    let operation = *parts.get(prisma + 2)?;
    let kind = match operation {
        "findFirst" | "findMany" | "findUnique" | "count" | "aggregate" | "groupBy" => {
            ProjectEdgeKind::Reads
        }
        "create" | "createMany" | "update" | "updateMany" | "upsert" | "delete" | "deleteMany" => {
            ProjectEdgeKind::Writes
        }
        _ => return None,
    };
    Some((
        match_table(model, known)?,
        kind,
        "prisma",
        "Prisma Client model operation targets this table by framework convention",
    ))
}

fn typeorm_operation(operation: &str) -> Option<ProjectEdgeKind> {
    match operation {
        "find" | "findOne" | "findBy" | "count" | "query" => Some(ProjectEdgeKind::Reads),
        "save" | "insert" | "update" | "upsert" | "remove" | "delete" | "softDelete" => {
            Some(ProjectEdgeKind::Writes)
        }
        _ => None,
    }
}

fn endpoint_call(function: &str, call: &str) -> Option<(String, String)> {
    let method = function.rsplit('.').next()?.to_ascii_uppercase();
    if !matches!(method.as_str(), "GET" | "POST" | "PUT" | "PATCH" | "DELETE") {
        return None;
    }
    let path = first_quoted(call)?;
    path.starts_with('/').then_some((method, path))
}

fn entity_table_name(class_text: &str, class_name: &str) -> Option<String> {
    let decorator = class_text.find("@Entity")?;
    let after = class_text.get(decorator + "@Entity".len()..)?.trim_start();
    if !after.starts_with('(') {
        return Some(class_name.into());
    }
    first_quoted(after).or_else(|| Some(class_name.into()))
}

fn class_kind(name: &str, entity: bool) -> ProjectNodeKind {
    if entity {
        ProjectNodeKind::OrmModel
    } else if name.ends_with("Service") {
        ProjectNodeKind::Service
    } else if name.ends_with("Repository") {
        ProjectNodeKind::Repository
    } else {
        ProjectNodeKind::Symbol
    }
}

fn match_table(name: &str, known: &BTreeMap<String, ObjectKey>) -> Option<ObjectKey> {
    let lower = name.to_ascii_lowercase();
    known
        .get(&lower)
        .cloned()
        .or_else(|| known.get(&camel_to_snake(name)).cloned())
        .or_else(|| known.get(&format!("{}s", camel_to_snake(name))).cloned())
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

fn call_argument(source: &str, function: &str) -> Option<String> {
    let start = source.find(function)? + function.len();
    let after = source.get(start..)?.strip_prefix('(')?;
    if let Some(quoted) = first_quoted(after) {
        return Some(quoted);
    }
    let value = after.split([')', ',', '{', '}']).next()?.trim();
    (!value.is_empty()).then(|| {
        value
            .trim_matches(|character| character == '\'' || character == '"')
            .to_owned()
    })
}

fn first_quoted(source: &str) -> Option<String> {
    let (start, quote) = source
        .char_indices()
        .find(|(_, character)| matches!(character, '\'' | '"' | '`'))?;
    let remainder = source.get(start + quote.len_utf8()..)?;
    let end = remainder.find(quote)?;
    Some(remainder.get(..end)?.to_owned())
}

fn compact(value: &str) -> String {
    value
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect()
}

fn visit_children(node: Node<'_>, mut visitor: impl FnMut(Node<'_>)) {
    let mut cursor = node.walk();
    if cursor.goto_first_child() {
        loop {
            visitor(cursor.node());
            if !cursor.goto_next_sibling() {
                break;
            }
        }
    }
}

fn line_number(node: Node<'_>) -> u32 {
    u32::try_from(node.start_position().row + 1).unwrap_or(u32::MAX)
}

fn end_line_number(node: Node<'_>) -> u32 {
    u32::try_from(node.end_position().row + 1).unwrap_or(u32::MAX)
}

fn is_tsx(document: &SourceDocument) -> bool {
    document
        .relative_path
        .rsplit_once('.')
        .is_some_and(|(_, extension)| {
            matches!(extension.to_ascii_lowercase().as_str(), "tsx" | "jsx")
        })
}

#[cfg(test)]
mod tests {
    use schema_model::{DatabaseInfo, DatabaseType, SchemaDefinition, TableDefinition};

    use super::*;

    fn snapshot() -> DatabaseSnapshot {
        let mut snapshot = DatabaseSnapshot::new(
            Uuid::new_v4(),
            DatabaseInfo {
                name: "shop".into(),
                database_type: DatabaseType::PostgreSql,
                version: "17".into(),
            },
            vec![SchemaDefinition {
                name: "public".into(),
                tables: vec![
                    TableDefinition::empty("public", "orders"),
                    TableDefinition::empty("public", "users"),
                ],
                views: vec![],
                enums: vec![],
            }],
        );
        snapshot.canonicalize().unwrap();
        snapshot
    }

    fn analyze(source: &str) -> AnalysisBatch {
        TypeScriptAnalyzer
            .analyze(
                Uuid::new_v4(),
                Uuid::new_v4(),
                &SourceDocument {
                    relative_path: "src/orders.ts".into(),
                    language: "typescript".into(),
                    contents: source.into(),
                },
                &snapshot(),
            )
            .unwrap()
    }

    #[test]
    fn extracts_endpoint_service_and_prisma_read() {
        let batch = analyze(
            r#"
            class OrderService {
              list() { return prisma.orders.findMany(); }
            }
            router.get("/orders", () => service.list());
            "#,
        );
        assert!(
            batch
                .nodes
                .iter()
                .any(|node| node.kind == ProjectNodeKind::Service)
        );
        assert!(
            batch
                .nodes
                .iter()
                .any(|node| node.kind == ProjectNodeKind::Endpoint)
        );
        assert!(
            batch
                .edges
                .iter()
                .any(|edge| edge.kind == ProjectEdgeKind::Reads)
        );
        assert!(
            batch
                .edges
                .iter()
                .any(|edge| edge.kind == ProjectEdgeKind::Handles)
        );
    }

    #[test]
    fn extracts_drizzle_and_typeorm_mappings_and_writes() {
        let batch = analyze(
            r#"
            const orders = pgTable("orders", {});
            @Entity("users") class User {}
            const users = dataSource.getRepository(User);
            function work() {
              db.insert(orders).values({});
              users.save({});
            }
            "#,
        );
        assert!(
            batch
                .edges
                .iter()
                .filter(|edge| edge.kind == ProjectEdgeKind::MapsTo)
                .count()
                >= 2
        );
        assert!(
            batch
                .edges
                .iter()
                .filter(|edge| edge.kind == ProjectEdgeKind::Writes)
                .count()
                >= 2
        );
    }

    #[test]
    fn records_same_file_function_calls_from_ast() {
        let batch = analyze("function load() {} function handler() { load(); }");
        assert!(
            batch
                .edges
                .iter()
                .any(|edge| edge.kind == ProjectEdgeKind::Calls)
        );
    }
}
