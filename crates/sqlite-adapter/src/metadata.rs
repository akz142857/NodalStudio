use crate::{SqliteError, test_connection};
use schema_model::{
    ColumnDefinition, ConstraintDefinition, ConstraintType, DatabaseSnapshot, ForeignKeyDefinition,
    IndexDefinition, MatchType, ObjectDependency, ObjectKey, ObjectKind, PrimaryKeyDefinition,
    ProgramDefinition, ReferentialAction, SchemaDefinition, SqliteTableMetadata, TableDefinition,
    ViewDefinition,
};
use sha2::{Digest, Sha256};
use sqlparser::{
    ast::{ColumnOption, Statement, TableConstraint},
    dialect::SQLiteDialect,
    parser::Parser,
};
use sqlx::{Connection, Row, SqliteConnection, sqlite::SqliteRow};
use std::collections::{BTreeMap, BTreeSet, btree_map::Entry};
use uuid::Uuid;

/// Captures a consistent, bounded catalog in one read transaction.
/// # Errors
/// Fails closed for incomplete ordinary-table metadata; unsupported virtual tables retain DDL with diagnostics.
#[allow(clippy::too_many_lines)]
pub async fn inspect_schema(
    connection: &mut SqliteConnection,
    source: Uuid,
    name: &str,
) -> Result<DatabaseSnapshot, SqliteError> {
    let mut tx = connection.begin().await?;
    let database = test_connection(&mut tx, name).await?;
    let size: i64 = sqlx::query_scalar(
        "SELECT coalesce(sum(coalesce(length(CAST(sql AS BLOB)),0)+length(CAST(name AS BLOB))),0) FROM main.sqlite_schema",
    )
    .fetch_one(&mut *tx)
    .await?;
    if size > 16 * 1024 * 1024 {
        return Err(SqliteError::Limit);
    }
    let catalog = sqlx::query(
        "SELECT type,name,tbl_name,sql FROM main.sqlite_schema ORDER BY type,name LIMIT 10001",
    )
    .fetch_all(&mut *tx)
    .await?;
    if catalog.len() > 10_000 {
        return Err(SqliteError::Limit);
    }
    let table_info =
        sqlx::query("SELECT name,type,wr,strict FROM pragma_table_list WHERE schema='main'")
            .fetch_all(&mut *tx)
            .await?;
    let table_info: BTreeMap<&str, _> = table_info
        .iter()
        .map(|row| (row.get("name"), row))
        .collect();
    // Index the catalog once. SQLite resolves identifiers case-insensitively,
    // while the model preserves the spelling stored in the catalog.
    let mut table_names = BTreeMap::new();
    let mut index_definitions = BTreeMap::new();
    let mut view_names = BTreeSet::new();
    for row in &catalog {
        let name: &str = row.try_get("name")?;
        match row.try_get::<&str, _>("type")? {
            "table" => {
                table_names.insert(name.to_ascii_lowercase(), name);
            }
            "index" => {
                index_definitions.insert(name, row);
            }
            "view" => {
                view_names.insert(name.to_ascii_lowercase());
            }
            _ => {}
        }
    }
    let mut foreign_key_targets: BTreeMap<String, Option<Vec<SqliteRow>>> = BTreeMap::new();
    let mut schema = SchemaDefinition::empty("main");
    let mut column_count = 0usize;
    for row in &catalog {
        let name: &str = row.try_get("name")?;
        let kind: &str = row.try_get("type")?;
        if name.starts_with("sqlite_") {
            continue;
        }
        let definition: Option<String> = row.try_get("sql")?;
        let definition = definition.unwrap_or_default();
        if kind == "view" {
            schema.views.push(ViewDefinition {
                key: ObjectKey::new(ObjectKind::View, "main", name),
                definition,
                materialized: false,
                comment: None,
                indexes: vec![],
            });
        } else if kind == "trigger" {
            let key = ObjectKey::new(ObjectKind::Trigger, "main", name);
            let target: String = row.try_get("tbl_name")?;
            let target_kind = if view_names.contains(&target.to_ascii_lowercase()) {
                ObjectKind::View
            } else {
                ObjectKind::Table
            };
            let table = ObjectKey::new(target_kind, "main", target);
            schema.dependencies.push(ObjectDependency {
                source: key.clone(),
                target: table.clone(),
            });
            schema.programs.push(ProgramDefinition {
                key,
                definition: Some(definition),
                arguments: String::new(),
                language: "SQL".into(),
                result_type: None,
                owner: String::new(),
                table: Some(table),
                enabled: None,
            });
        } else if kind == "table" {
            let info = table_info.get(name);
            if info.is_some_and(|r| r.get::<&str, _>("type") == "shadow") {
                continue;
            }
            let virtual_table = info.is_some_and(|r| r.get::<&str, _>("type") == "virtual");
            let strict = info.is_some_and(|r| r.get::<i64, _>("strict") != 0);
            let without_rowid = info.is_some_and(|r| r.get::<i64, _>("wr") != 0);
            let mut table = TableDefinition::empty("main", name);
            let mut metadata = SqliteTableMetadata {
                definition,
                strict,
                without_rowid,
                virtual_table,
                diagnostics: vec![],
                columns: BTreeMap::new(),
                index_terms: BTreeMap::new(),
                columns_unavailable: false,
            };
            let columns = sqlx::query("SELECT cid,name,type,\"notnull\",dflt_value,pk,hidden FROM pragma_table_xinfo(?, 'main') ORDER BY cid").bind(name).fetch_all(&mut *tx).await;
            let columns = match columns {
                Ok(rows) => rows,
                Err(error) if virtual_table && missing_module(&error) => {
                    metadata.columns_unavailable = true;
                    metadata.diagnostics.push(
                        "Virtual table module unavailable; only its definition was captured."
                            .into(),
                    );
                    table.sqlite = Some(metadata);
                    schema.tables.push(table);
                    continue;
                }
                Err(error) => return Err(error.into()),
            };
            column_count += columns.len();
            if column_count > 50_000 {
                return Err(SqliteError::Limit);
            }
            let indexes = sqlx::query("SELECT name,\"unique\",origin,partial FROM pragma_index_list(?, 'main') ORDER BY name").bind(name).fetch_all(&mut *tx).await?;
            let mut pk: Vec<(i64, String)> = vec![];
            for col in &columns {
                let name: String = col.try_get("name")?;
                let declared: String = col.try_get("type")?;
                let pk_order: i64 = col.try_get("pk")?;
                let hidden: i64 = col.try_get("hidden")?;
                // A rowid alias has no separate PK index, including SQLite's DESC exception.
                let rowid_alias = pk_order > 0
                    && declared.eq_ignore_ascii_case("INTEGER")
                    && !without_rowid
                    && !indexes.iter().any(|r| r.get::<String, _>("origin") == "pk");
                let nullable = col.try_get::<i64, _>("notnull")? == 0
                    && !(pk_order > 0 && (strict || without_rowid || rowid_alias));
                if pk_order > 0 {
                    pk.push((pk_order, name.clone()));
                }
                metadata.columns.insert(
                    name.clone(),
                    schema_model::SqliteColumnMetadata {
                        hidden,
                        affinity: affinity(&declared, strict).into(),
                        generation_expression: None,
                        generation_mode: None,
                    },
                );
                table.columns.push(ColumnDefinition {
                    name,
                    ordinal_position: col.try_get::<i32, _>("cid")? + 1,
                    formatted_type: declared.clone(),
                    type_schema: "main".into(),
                    type_name: affinity(&declared, strict).into(),
                    nullable,
                    default_value: col.try_get("dflt_value")?,
                    identity: None,
                    generated: hidden == 2 || hidden == 3,
                    comment: (hidden == 1).then(|| "SQLite hidden virtual-table column".into()),
                });
            }
            pk.sort();
            if !pk.is_empty() {
                table.primary_key = Some(PrimaryKeyDefinition {
                    name: format!("{name}__pk"),
                    columns: pk.into_iter().map(|(_, n)| n).collect(),
                });
            }
            for idx in indexes {
                let index_name: String = idx.try_get("name")?;
                let details = sqlx::query("SELECT name,cid,\"desc\",coll,\"key\" FROM pragma_index_xinfo(?, 'main') ORDER BY seqno").bind(&index_name).fetch_all(&mut *tx).await?;
                let ddl = index_definitions
                    .get(index_name.as_str())
                    .and_then(|r| r.get::<Option<String>, _>("sql"));
                let mut predicate = None;
                let mut expressions = vec![];
                if let Some(sql) = &ddl
                    && let Ok(statements) = Parser::parse_sql(&SQLiteDialect {}, sql)
                    && let Some(Statement::CreateIndex(index)) = statements.first()
                {
                    predicate = index.predicate.as_ref().map(ToString::to_string);
                    expressions = index.columns.iter().map(ToString::to_string).collect();
                }
                metadata.index_terms.insert(
                    index_name.clone(),
                    details
                        .iter()
                        .filter(|r| r.get::<i64, _>("key") != 0)
                        .map(|r| schema_model::SqliteIndexTerm {
                            column: r.get("name"),
                            descending: r.get::<i64, _>("desc") != 0,
                            collation: r.get("coll"),
                        })
                        .collect(),
                );
                let fields = details
                    .iter()
                    .filter(|r| r.get::<i64, _>("key") != 0)
                    .enumerate()
                    .map(|(i, r)| {
                        r.get::<Option<String>, _>("name").unwrap_or_else(|| {
                            expressions
                                .get(i)
                                .cloned()
                                .unwrap_or_else(|| "<expression; see definition>".into())
                        })
                    })
                    .collect();
                if idx.get::<i64, _>("partial") != 0 && predicate.is_none() {
                    metadata.diagnostics.push(format!("Partial index {index_name}: predicate is available in its original definition only."));
                }
                table.indexes.push(IndexDefinition {
                    definition: ddl,
                    name: index_name,
                    method: "btree".into(),
                    columns: fields,
                    unique: idx.try_get::<i64, _>("unique")? != 0,
                    primary: idx.try_get::<String, _>("origin")? == "pk",
                    predicate,
                });
            }
            let fks = sqlx::query("SELECT id,seq,\"table\",\"from\",\"to\",on_update,on_delete FROM pragma_foreign_key_list(?, 'main') ORDER BY id,seq").bind(name).fetch_all(&mut *tx).await?;
            let mut groups: BTreeMap<i64, Vec<SqliteRow>> = BTreeMap::new();
            for fk in fks {
                groups.entry(fk.get("id")).or_default().push(fk);
            }
            let mut fk_ids = BTreeMap::<String, usize>::new();
            for rows in groups.values() {
                let first = &rows[0];
                let declared_target: &str = first.try_get("table")?;
                let target_key = declared_target.to_ascii_lowercase();
                let target = table_names
                    .get(&target_key)
                    .copied()
                    .unwrap_or(declared_target);
                // Reuse target metadata only within this read transaction. Retain
                // the unavailable-module diagnostic for each referencing table.
                let cached = match foreign_key_targets.entry(target_key) {
                    Entry::Occupied(entry) => entry.into_mut(),
                    Entry::Vacant(entry) => {
                        let columns = sqlx::query(
                            "SELECT name,pk FROM pragma_table_xinfo(?, 'main') ORDER BY pk",
                        )
                        .bind(target)
                        .fetch_all(&mut *tx)
                        .await;
                        entry.insert(match columns {
                            Ok(columns) => Some(columns),
                            Err(error) if missing_module(&error) => None,
                            Err(error) => return Err(error.into()),
                        })
                    }
                };
                if cached.is_none() {
                    metadata.diagnostics.push(format!("Foreign key to {target}: target module unavailable; declared references are retained but cannot be verified."));
                }
                let target_columns = cached.as_deref().unwrap_or_default();
                let target_pk: Vec<_> = target_columns
                    .iter()
                    .filter(|column| column.get::<i64, _>("pk") > 0)
                    .collect();
                let mut referenced_columns = vec![];
                for (i, r) in rows.iter().enumerate() {
                    let declared: Option<String> = r.try_get("to")?;
                    referenced_columns.push(match declared {
                        Some(declared) => target_columns
                            .iter()
                            .find(|column| {
                                column
                                    .get::<String, _>("name")
                                    .eq_ignore_ascii_case(&declared)
                            })
                            .map_or(declared, |column| column.get("name")),
                        None => target_pk
                            .get(i)
                            .map_or_else(String::new, |column| column.get("name")),
                    });
                }
                if referenced_columns.iter().any(String::is_empty) {
                    metadata.diagnostics.push(format!("Foreign key to {target}: referenced primary-key columns could not be resolved."));
                }
                let fields: Vec<String> = rows.iter().map(|r| r.get("from")).collect();
                // Include target columns and actions: two keys can use the same local fields.
                let basis = serde_json::json!([
                    fields,
                    target,
                    referenced_columns,
                    first.get::<String, _>("on_update"),
                    first.get::<String, _>("on_delete")
                ]);
                let digest = format!("{:x}", Sha256::digest(basis.to_string().as_bytes()));
                let stem = format!("{name}__fk_{}", &digest[..16]);
                let occurrence = fk_ids.entry(stem.clone()).or_default();
                *occurrence += 1;
                let derived_name = format!("{stem}_{occurrence}");
                table.foreign_keys.push(ForeignKeyDefinition {
                    name: derived_name,
                    columns: fields,
                    referenced_schema: "main".into(),
                    referenced_table: target.into(),
                    referenced_columns,
                    on_update: action(&first.try_get::<String, _>("on_update")?),
                    on_delete: action(&first.try_get::<String, _>("on_delete")?),
                    match_type: MatchType::Simple,
                    deferrable: false,
                    initially_deferred: false,
                });
            }
            table.sqlite = Some(metadata);
            parse_constraints(&mut table);
            schema.tables.push(table);
        }
    }
    let mut snapshot = DatabaseSnapshot::new(source, database, vec![schema]);
    snapshot.canonicalize()?;
    tx.rollback().await?;
    Ok(snapshot)
}

fn missing_module(error: &sqlx::Error) -> bool {
    error
        .as_database_error()
        .is_some_and(|error| error.message().starts_with("no such module:"))
}

fn action(value: &str) -> ReferentialAction {
    match value {
        "CASCADE" => ReferentialAction::Cascade,
        "RESTRICT" => ReferentialAction::Restrict,
        "SET NULL" => ReferentialAction::SetNull,
        "SET DEFAULT" => ReferentialAction::SetDefault,
        _ => ReferentialAction::NoAction,
    }
}
fn affinity(declared: &str, strict: bool) -> &'static str {
    let name = declared.to_ascii_uppercase();
    if strict && name == "ANY" {
        "NONE"
    } else if name.contains("INT") {
        "INTEGER"
    } else if ["CHAR", "CLOB", "TEXT"].iter().any(|s| name.contains(s)) {
        "TEXT"
    } else if name.is_empty() || name.contains("BLOB") {
        "BLOB"
    } else if ["REAL", "FLOA", "DOUB"].iter().any(|s| name.contains(s)) {
        "REAL"
    } else {
        "NUMERIC"
    }
}
fn parse_constraints(table: &mut TableDefinition) {
    let meta = table.sqlite.as_mut().unwrap();
    let parsed = Parser::parse_sql(&SQLiteDialect {}, &meta.definition);
    if let Ok(statements) = parsed {
        if let Some(Statement::CreateTable(create)) = statements.first() {
            for constraint in &create.constraints {
                if let TableConstraint::ForeignKey(fk) = constraint {
                    apply_fk(
                        &mut table.foreign_keys,
                        fk,
                        fk.name.as_ref(),
                        &fk.columns
                            .iter()
                            .map(|c| c.value.clone())
                            .collect::<Vec<_>>(),
                    );
                }
                if let TableConstraint::Check(check) = constraint {
                    table.constraints.push(ConstraintDefinition {
                        name: check.name.as_ref().map_or_else(
                            || format!("{}__check_{}", table.key.name, table.constraints.len()),
                            ToString::to_string,
                        ),
                        constraint_type: ConstraintType::Check,
                        definition: constraint.to_string(),
                    });
                }
            }
            for col in &create.columns {
                for option in &col.options {
                    if let ColumnOption::ForeignKey(fk) = &option.option {
                        apply_fk(
                            &mut table.foreign_keys,
                            fk,
                            option.name.as_ref().or(fk.name.as_ref()),
                            std::slice::from_ref(&col.name.value),
                        );
                    }
                    if let ColumnOption::Generated {
                        generation_expr,
                        generation_expr_mode,
                        ..
                    } = &option.option
                        && let Some(details) = meta.columns.get_mut(&col.name.value)
                    {
                        details.generation_expression =
                            generation_expr.as_ref().map(ToString::to_string);
                        details.generation_mode =
                            generation_expr_mode.as_ref().map(|mode| match mode {
                                sqlparser::ast::GeneratedExpressionMode::Virtual => {
                                    "VIRTUAL".into()
                                }
                                sqlparser::ast::GeneratedExpressionMode::Stored => "STORED".into(),
                            });
                    }
                    if let ColumnOption::Check(_) = &option.option {
                        table.constraints.push(ConstraintDefinition {
                            name: option.name.as_ref().map_or_else(
                                || {
                                    format!(
                                        "{}__{}_check_{}",
                                        table.key.name,
                                        col.name.value,
                                        table.constraints.len()
                                    )
                                },
                                ToString::to_string,
                            ),
                            constraint_type: ConstraintType::Check,
                            definition: option.option.to_string(),
                        });
                    }
                }
            }
        }
    } else {
        meta.diagnostics.push(
            "Some SQLite DDL properties could not be parsed; consult the original definition."
                .into(),
        );
    }
    if !table.foreign_keys.is_empty() {
        meta.diagnostics.push("Unnamed foreign-key names are derived. Enforcement is connection-specific. If DDL parsing is incomplete or multiple declarations share the same local columns and target table, names and deferral properties are unverified; consult the original definition.".into());
    }
}

fn apply_fk(
    target: &mut [ForeignKeyDefinition],
    parsed: &sqlparser::ast::ForeignKeyConstraint,
    name: Option<&sqlparser::ast::Ident>,
    columns: &[String],
) {
    // Match by local columns; ambiguous duplicate declarations remain in original DDL.
    let matches: Vec<_> = target
        .iter_mut()
        .filter(|fk| {
            fk.columns.len() == columns.len()
                && fk
                    .columns
                    .iter()
                    .zip(columns)
                    .all(|(a, b)| a.eq_ignore_ascii_case(b))
                && parsed
                    .foreign_table
                    .0
                    .last()
                    .and_then(sqlparser::ast::ObjectNamePart::as_ident)
                    .is_some_and(|name| name.value.eq_ignore_ascii_case(&fk.referenced_table))
        })
        .collect();
    if matches.len() != 1 {
        return;
    }
    for fk in matches {
        if let Some(name) = name {
            fk.name.clone_from(&name.value);
        }
        if let Some(characteristics) = &parsed.characteristics {
            fk.deferrable = characteristics.deferrable.unwrap_or(false);
            fk.initially_deferred = fk.deferrable
                && characteristics.initially == Some(sqlparser::ast::DeferrableInitial::Deferred);
        }
    }
}
