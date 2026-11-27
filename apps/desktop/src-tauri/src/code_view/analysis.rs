use std::{collections::BTreeSet, ops::ControlFlow};

use schema_model::{DatabaseSnapshot, ObjectKey, ObjectKind};
use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlparser::{
    ast::{
        AlterTableOperation, Expr, GroupByExpr, Ident, JoinConstraint, JoinOperator, ObjectName,
        Query, Select, SelectItem, SetExpr, Statement, TableFactor, Visit, Visitor,
        visit_relations,
    },
    dialect::MySqlDialect,
    parser::Parser,
    tokenizer::{Location, Token, Tokenizer},
};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct StatementAnalysis {
    pub(super) start: usize,
    pub(super) end: usize,
    pub(super) line: u64,
    pub(super) digest: String,
    pub(super) kind: &'static str,
    pub(super) references: BTreeSet<ObjectKey>,
    pub(super) diagnostics: BTreeSet<&'static str>,
    #[serde(skip_serializing_if = "BTreeSet::is_empty")]
    pub(super) outside_databases: BTreeSet<String>,
    pub(super) changes: Vec<Change>,
    pub(super) open_query: bool,
}

impl StatementAnalysis {
    fn record_outside_database(&mut self, name: &ObjectName) {
        self.diagnostics.insert("outsideDatabase");
        if let [database, _] = name.0.as_slice()
            && let Some(database) = database.as_ident()
        {
            self.outside_databases.insert(database.value.clone());
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Change {
    pub(super) table: ObjectKey,
    pub(super) action: &'static str,
    pub(super) before: Option<String>,
    pub(super) after: Option<String>,
}

pub(super) fn digest(contents: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(contents))
}

fn statement_ranges(contents: &str) -> Result<Vec<(usize, usize, u64)>, &'static str> {
    // Executable MySQL comments and client delimiters can change subsequent SQL semantics.
    if contents.contains("/*!")
        || contents.contains("/*M!")
        || contents.lines().any(|line| {
            line.split_whitespace()
                .next()
                .is_some_and(|word| word.eq_ignore_ascii_case("delimiter"))
        })
    {
        return Err("sessionContext");
    }
    if contents.contains("{{") || contents.contains("{%") || contents.contains("${") {
        return Err("template");
    }
    let tokens = Tokenizer::new(&MySqlDialect {}, contents)
        .tokenize_with_location()
        .map_err(|_| "syntax")?;
    let lines: Vec<_> = std::iter::once(0)
        .chain(
            contents
                .match_indices('\n')
                .map(|(position, _)| position + 1),
        )
        .collect();
    let offset = |location: Location| -> Option<usize> {
        let line = *lines.get(usize::try_from(location.line.checked_sub(1)?).ok()?)?;
        contents[line..]
            .char_indices()
            .nth(usize::try_from(location.column.checked_sub(1)?).ok()?)
            .map(|(column, _)| line + column)
            .or(Some(contents.len()))
    };
    let mut start = None;
    let mut ranges = Vec::new();
    for token in tokens {
        match token.token {
            Token::Whitespace(_) => (),
            Token::SemiColon => {
                if let Some((begin, line)) = start.take() {
                    let end = offset(token.span.start).ok_or("syntax")?;
                    if begin < end {
                        ranges.push((begin, end, line));
                    }
                }
            }
            _ => {
                if start.is_none() {
                    start = Some((
                        offset(token.span.start).ok_or("syntax")?,
                        token.span.start.line,
                    ));
                }
            }
        }
    }
    if let Some((begin, line)) = start {
        ranges.push((begin, contents.len(), line));
    }
    Ok(ranges)
}

pub(super) fn analyze(
    contents: &str,
    snapshot: &DatabaseSnapshot,
) -> (Vec<StatementAnalysis>, Option<&'static str>) {
    let ranges = match statement_ranges(contents) {
        Ok(ranges) => ranges,
        Err(reason) => return (Vec::new(), Some(reason)),
    };
    let mut session_unknown = false;
    let mut results = Vec::new();
    for (start, end, line) in ranges {
        let sql = contents[start..end].trim_end();
        let mut result = StatementAnalysis {
            start,
            end: start + sql.len(),
            line,
            digest: digest(sql),
            kind: "unsupported",
            references: BTreeSet::new(),
            diagnostics: BTreeSet::new(),
            outside_databases: BTreeSet::new(),
            changes: Vec::new(),
            open_query: false,
        };
        // An unparsed statement could have affected the script's session context.
        if session_unknown {
            result.diagnostics.insert("sessionContext");
        } else {
            match Parser::parse_sql(&MySqlDialect {}, sql)
                .ok()
                .and_then(|mut statements| (statements.len() == 1).then(|| statements.remove(0)))
            {
                Some(Statement::Query(query)) => {
                    result.kind = "query";
                    let mut resolver = Resolver {
                        snapshot,
                        result: &mut result,
                        known_context: true,
                    };
                    resolver.query(&query, &BTreeSet::new());
                    let _: ControlFlow<()> = visit_relations(&query, |name| {
                        if name.0.len() > 1 && table_key(name, snapshot).is_none() {
                            resolver.result.record_outside_database(name);
                            resolver.known_context = false;
                        }
                        ControlFlow::Continue(())
                    });
                    result.open_query = resolver.known_context && readonly(sql);
                }
                Some(Statement::AlterTable(table)) => {
                    result.kind = "migration";
                    if let Some(key) = table_key(&table.name, snapshot) {
                        track_table(&mut result, snapshot, &key);
                        alter_columns(table.operations, snapshot, &key, &mut result);
                    } else {
                        result.record_outside_database(&table.name);
                    }
                }
                Some(Statement::CreateTable(table)) if !table.temporary => {
                    result.kind = "migration";
                    if let Some(key) = table_key(&table.name, snapshot) {
                        track_table(&mut result, snapshot, &key);
                        change(&mut result, snapshot, &key, "createTable", None, None);
                        for column in table.columns {
                            change(&mut result, snapshot, &key, "add", None, Some(column.name));
                        }
                    } else {
                        result.record_outside_database(&table.name);
                    }
                }
                Some(
                    Statement::Use(_)
                    | Statement::Set(_)
                    | Statement::Prepare { .. }
                    | Statement::Execute { .. }
                    | Statement::CreateTable(_),
                ) => {
                    result.diagnostics.insert("sessionContext");
                    session_unknown = true;
                }
                Some(_) => {
                    result.diagnostics.insert("unsupported");
                    session_unknown = true;
                }
                None => {
                    result.diagnostics.insert("syntax");
                    session_unknown = true;
                }
            }
        }
        results.push(result);
    }
    (results, None)
}

fn alter_columns(
    operations: Vec<AlterTableOperation>,
    snapshot: &DatabaseSnapshot,
    key: &ObjectKey,
    result: &mut StatementAnalysis,
) {
    for operation in operations {
        match operation {
            AlterTableOperation::AddColumn { column_def, .. } => {
                change(result, snapshot, key, "add", None, Some(column_def.name));
            }
            AlterTableOperation::DropColumn { column_names, .. } => {
                for column in column_names {
                    change(result, snapshot, key, "drop", Some(column), None);
                }
            }
            AlterTableOperation::RenameColumn {
                old_column_name,
                new_column_name,
            } => change(
                result,
                snapshot,
                key,
                "rename",
                Some(old_column_name),
                Some(new_column_name),
            ),
            AlterTableOperation::ChangeColumn {
                old_name, new_name, ..
            } => {
                let action = if old_name.value == new_name.value {
                    "modify"
                } else {
                    "rename"
                };
                change(
                    result,
                    snapshot,
                    key,
                    action,
                    Some(old_name),
                    Some(new_name),
                );
            }
            AlterTableOperation::ModifyColumn { col_name, .. } => change(
                result,
                snapshot,
                key,
                "modify",
                Some(col_name.clone()),
                Some(col_name),
            ),
            _ => {
                result.diagnostics.insert("unsupported");
            }
        }
    }
}

fn readonly(sql: &str) -> bool {
    query_engine::ExecuteQueryRequest {
        query_id: uuid::Uuid::nil(),
        sql: sql.to_owned(),
        row_limit: 1,
        timeout_ms: 1_000,
        max_cell_bytes: query_engine::DEFAULT_CELL_BYTES,
        max_result_bytes: query_engine::DEFAULT_RESULT_BYTES,
    }
    .validate_mysql()
    .is_ok()
}

fn table_key(name: &ObjectName, snapshot: &DatabaseSnapshot) -> Option<ObjectKey> {
    let names = name
        .0
        .iter()
        .map(|part| part.as_ident())
        .collect::<Option<Vec<_>>>()?;
    let table = match names.as_slice() {
        [table] => table,
        [database, table] if database.value == snapshot.database.name => table,
        _ => return None,
    };
    Some(ObjectKey::table(&snapshot.database.name, &table.value))
}

fn table<'a>(
    snapshot: &'a DatabaseSnapshot,
    key: &ObjectKey,
) -> Option<&'a schema_model::TableDefinition> {
    snapshot
        .schemas
        .iter()
        .find(|schema| schema.name == key.schema)?
        .tables
        .iter()
        .find(|table| &table.key == key)
}

fn column_key(table: &schema_model::TableDefinition, name: &str) -> Option<ObjectKey> {
    let column = table
        .columns
        .iter()
        .find(|column| column.name.eq_ignore_ascii_case(name))?;
    Some(table.key.child(ObjectKind::Column, &column.name))
}

fn track_table(result: &mut StatementAnalysis, snapshot: &DatabaseSnapshot, key: &ObjectKey) {
    if table(snapshot, key).is_some() {
        result.references.insert(key.clone());
    } else {
        result.diagnostics.insert("notObserved");
    }
}

fn change(
    result: &mut StatementAnalysis,
    snapshot: &DatabaseSnapshot,
    table_key: &ObjectKey,
    action: &'static str,
    before: Option<Ident>,
    after: Option<Ident>,
) {
    if let Some(before) = &before {
        if let Some(key) =
            table(snapshot, table_key).and_then(|table| column_key(table, &before.value))
        {
            result.references.insert(key);
        } else {
            result.diagnostics.insert("notObserved");
        }
    }
    result.changes.push(Change {
        table: table_key.clone(),
        action,
        before: before.map(|identifier| identifier.value),
        after: after.map(|identifier| identifier.value),
    });
}

struct Resolver<'a, 'b> {
    snapshot: &'a DatabaseSnapshot,
    result: &'b mut StatementAnalysis,
    known_context: bool,
}

struct Relation<'a> {
    name: String,
    table: Option<&'a schema_model::TableDefinition>,
    aliased: bool,
}

impl<'a> Resolver<'a, '_> {
    fn query(&mut self, query: &Query, inherited: &BTreeSet<String>) {
        let mut ctes = inherited.clone();
        if let Some(with) = &query.with {
            if with.recursive {
                ctes.extend(
                    with.cte_tables
                        .iter()
                        .map(|cte| cte.alias.name.value.clone()),
                );
            }
            for cte in &with.cte_tables {
                self.query(&cte.query, &ctes);
                ctes.insert(cte.alias.name.value.clone());
            }
        }
        self.set(&query.body, &ctes);
        if query.order_by.is_some() {
            // ORDER BY can refer to a select alias or an output of a set operation.
            self.result.diagnostics.insert("partialColumns");
        }
    }

    fn set(&mut self, set: &SetExpr, ctes: &BTreeSet<String>) {
        match set {
            SetExpr::Select(select) => self.select(select, ctes),
            SetExpr::Query(query) => self.query(query, ctes),
            SetExpr::SetOperation { left, right, .. } => {
                self.set(left, ctes);
                self.set(right, ctes);
            }
            _ => self.unavailable("unsupported"),
        }
    }

    fn select(&mut self, select: &Select, ctes: &BTreeSet<String>) {
        let mut relations = Vec::new();
        for source in &select.from {
            relations.push(self.relation(&source.relation, ctes));
            for join in &source.joins {
                relations.push(self.relation(&join.relation, ctes));
                match &join.join_operator {
                    JoinOperator::Join(constraint)
                    | JoinOperator::Inner(constraint)
                    | JoinOperator::Left(constraint)
                    | JoinOperator::LeftOuter(constraint)
                    | JoinOperator::Right(constraint)
                    | JoinOperator::RightOuter(constraint)
                    | JoinOperator::CrossJoin(constraint)
                    | JoinOperator::StraightJoin(constraint) => match constraint {
                        JoinConstraint::On(expression) => {
                            self.expression(expression, &relations, ctes);
                        }
                        JoinConstraint::None => (),
                        _ => {
                            self.result.diagnostics.insert("partialColumns");
                        }
                    },
                    _ => self.unavailable("unsupported"),
                }
            }
        }
        for item in &select.projection {
            match item {
                SelectItem::UnnamedExpr(expression)
                | SelectItem::ExprWithAlias {
                    expr: expression, ..
                } => self.expression(expression, &relations, ctes),
                _ => {
                    self.result.diagnostics.insert("partialColumns");
                }
            }
        }
        if let Some(expression) = &select.selection {
            self.expression(expression, &relations, ctes);
        }
        if !select.named_window.is_empty()
            || select.having.is_some()
            || !matches!(&select.group_by, GroupByExpr::Expressions(exprs, _) if exprs.is_empty())
        {
            self.result.diagnostics.insert("partialColumns");
        }
    }

    fn relation(&mut self, factor: &TableFactor, ctes: &BTreeSet<String>) -> Relation<'a> {
        if let TableFactor::Derived {
            subquery, alias, ..
        } = factor
        {
            self.query(subquery, ctes);
            return Relation {
                name: alias
                    .as_ref()
                    .map_or_else(String::new, |alias| alias.name.value.clone()),
                table: None,
                aliased: true,
            };
        }
        if let TableFactor::Table {
            name,
            alias,
            args: None,
            ..
        } = factor
        {
            let name_part = name.0.last().and_then(|part| part.as_ident());
            let label = alias
                .as_ref()
                .map(|alias| &alias.name)
                .or(name_part)
                .map_or_else(String::new, |identifier| identifier.value.clone());
            let mut relation = Relation {
                name: label,
                table: None,
                aliased: alias.is_some(),
            };
            if name.0.len() == 1
                && name_part.is_some_and(|identifier| {
                    ctes.iter()
                        .any(|name| name.eq_ignore_ascii_case(&identifier.value))
                })
            {
                return relation;
            }
            if let Some(key) = table_key(name, self.snapshot) {
                if let Some(table) = table(self.snapshot, &key) {
                    self.result.references.insert(key);
                    relation.table = Some(table);
                } else if let Some(view) = self
                    .snapshot
                    .schemas
                    .iter()
                    .find(|schema| schema.name == key.schema)
                    .and_then(|schema| schema.views.iter().find(|view| view.key.name == key.name))
                {
                    self.result.references.insert(view.key.clone());
                    self.result.diagnostics.insert("partialColumns");
                } else {
                    self.unavailable("notObserved");
                }
            } else {
                self.unavailable("outsideDatabase");
            }
            return relation;
        }
        self.unavailable("unsupported");
        Relation {
            name: String::new(),
            table: None,
            aliased: false,
        }
    }

    fn unavailable(&mut self, reason: &'static str) {
        self.result.diagnostics.insert(reason);
        self.known_context = false;
    }

    fn expression(&mut self, expr: &Expr, relations: &[Relation<'a>], ctes: &BTreeSet<String>) {
        let _ = expr.visit(&mut ExpressionVisitor {
            resolver: self,
            relations,
            ctes,
            nested_queries: 0,
        });
    }
}

struct ExpressionVisitor<'a, 'b, 'c> {
    resolver: &'c mut Resolver<'a, 'b>,
    relations: &'c [Relation<'a>],
    ctes: &'c BTreeSet<String>,
    nested_queries: usize,
}

impl Visitor for ExpressionVisitor<'_, '_, '_> {
    type Break = ();

    fn pre_visit_query(&mut self, query: &Query) -> ControlFlow<()> {
        if self.nested_queries == 0 {
            self.resolver.query(query, self.ctes);
        }
        self.nested_queries += 1;
        ControlFlow::Continue(())
    }

    fn post_visit_query(&mut self, _: &Query) -> ControlFlow<()> {
        self.nested_queries -= 1;
        ControlFlow::Continue(())
    }

    fn pre_visit_expr(&mut self, expr: &Expr) -> ControlFlow<()> {
        if self.nested_queries != 0 {
            return ControlFlow::Continue(());
        }
        let names = match expr {
            Expr::Identifier(name) => std::slice::from_ref(name),
            Expr::CompoundIdentifier(names) => names.as_slice(),
            _ => return ControlFlow::Continue(()),
        };
        let matches: Vec<_> = match names {
            [column]
                if self
                    .relations
                    .iter()
                    .all(|relation| relation.table.is_some()) =>
            {
                self.relations
                    .iter()
                    .filter_map(|relation| column_key(relation.table?, &column.value))
                    .collect()
            }
            [qualifier, column] => {
                let matches: Vec<_> = self
                    .relations
                    .iter()
                    .filter(|relation| relation.name.eq_ignore_ascii_case(&qualifier.value))
                    .collect();
                if let [relation] = matches.as_slice() {
                    relation
                        .table
                        .and_then(|table| column_key(table, &column.value))
                        .into_iter()
                        .collect()
                } else {
                    Vec::new()
                }
            }
            [database, qualifier, column]
                if database.value == self.resolver.snapshot.database.name =>
            {
                self.relations
                    .iter()
                    .filter(|relation| {
                        !relation.aliased && relation.name.eq_ignore_ascii_case(&qualifier.value)
                    })
                    .filter_map(|relation| column_key(relation.table?, &column.value))
                    .collect()
            }
            _ => Vec::new(),
        };
        if let [key] = matches.as_slice() {
            self.resolver.result.references.insert(key.clone());
        } else {
            self.resolver
                .result
                .diagnostics
                .insert(if matches.len() > 1 {
                    "ambiguousColumn"
                } else {
                    "partialColumns"
                });
        }
        ControlFlow::Continue(())
    }
}
