//! Bounded previews and transactional row changes for ordinary `SQLite` tables.
use crate::{connect, connect_for_write, set_deadline};
use futures_util::TryStreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{Connection, QueryBuilder, Row, Sqlite, SqliteConnection, TypeInfo, ValueRef};
use std::{
    path::Path,
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

mod page;
use page::{BrowseOrder, PageCursor};

const DEFAULT_PAGE_SIZE: usize = 100;
const MAX_PAGE_SIZE: usize = 200;
const CHANGE_LIMIT: usize = 100;
const COLUMN_LIMIT: usize = 256;
const CELL_LIMIT: usize = 4096;
const PAYLOAD_LIMIT: usize = 2 * 1024 * 1024;
const FIXED_PAGE_PAYLOAD_LIMIT: usize = 16 * 1024 * 1024;
const TIME_LIMIT: Duration = Duration::from_secs(15);

#[derive(Debug, thiserror::Error)]
pub enum TableError {
    #[error(
        "Unable to open the SQLite file. Check permissions and grant access to its containing folder if needed."
    )]
    File,
    #[error("This SQLite table cannot be edited in the table workspace.")]
    Unsupported,
    #[error(
        "The database or table structure changed. Discard the draft and reopen the table before editing."
    )]
    TableChanged,
    #[error("Change {0} refers to a row that changed or was removed in another connection.")]
    RowChanged(usize),
    #[error("A value or column in the change set is invalid or exceeds the SQLite editor limits.")]
    Invalid,
    #[error("The database is locked by another connection. Try saving again.")]
    Busy,
    #[error(
        "A database constraint rejected a change. Check required fields, unique keys, and references."
    )]
    Constraint,
    #[error("The SQLite table operation timed out.")]
    Timeout,
    #[error("A single row exceeds the table browser's display limit.")]
    PageLimit,
    #[error("This page exceeds the display limit. Choose fewer rows per page.")]
    FixedPageLimit,
    #[error("The selected filter or sort column is unavailable, or the filter value is too large.")]
    InvalidBrowse,
    #[error("SQLite could not complete the table operation. Check file and folder permissions.")]
    Database,
}

impl From<sqlx::Error> for TableError {
    fn from(error: sqlx::Error) -> Self {
        if let Some(database) = error.as_database_error() {
            // Extended SQLite codes retain their primary code in the low byte.
            return match database
                .code()
                .and_then(|code| code.parse::<u32>().ok())
                .map(|code| code & 0xff)
            {
                Some(5 | 6) => Self::Busy,
                Some(8 | 14) => Self::File,
                Some(9) => Self::Timeout,
                Some(19) => Self::Constraint,
                _ => Self::Database,
            };
        }
        Self::Database
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Value {
    Null,
    Text { value: String },
    Integer { value: String },
    Real { value: String },
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Cell {
    Unavailable,
    #[serde(untagged)]
    Value(Value),
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Column {
    name: String,
    declared_type: String,
    generated: bool,
    primary_key: bool,
    #[serde(skip)]
    not_null: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RowIdentity {
    key: Vec<Value>,
    revision: String,
}

#[derive(Debug, Serialize)]
pub struct TableRow {
    cells: Vec<Cell>,
    identity: Option<RowIdentity>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableData {
    version: String,
    columns: Vec<Column>,
    rows: Vec<TableRow>,
    statement: String,
    next_offset: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    next_cursor: Option<PageCursor>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadOptions {
    #[serde(default)]
    offset: u32,
    page_size: Option<usize>,
    cursor: Option<PageCursor>,
    filter: Option<Filter>,
    sort: Option<Sort>,
}

#[derive(Debug, Deserialize)]
pub struct CountOptions {
    filter: Option<Filter>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum Filter {
    Group {
        #[serde(rename = "match")]
        mode: Match,
        rules: Vec<FilterRule>,
    },
    Rule(FilterRule),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Match {
    All,
    Any,
}

#[derive(Debug, Deserialize)]
struct FilterRule {
    column: String,
    kind: FilterKind,
    value: Option<String>,
    end: Option<String>,
    values: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
enum FilterKind {
    Equals,
    NotEquals,
    Less,
    LessOrEqual,
    Greater,
    GreaterOrEqual,
    Contains,
    NotContains,
    StartsWith,
    NotStartsWith,
    EndsWith,
    NotEndsWith,
    IsNull,
    IsNotNull,
    IsEmpty,
    IsNotEmpty,
    Between,
    NotBetween,
    InList,
    NotInList,
}

#[derive(Debug, Deserialize)]
struct Sort {
    column: String,
    direction: Direction,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum Direction {
    Asc,
    Desc,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct Field {
    column: usize,
    value: Value,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Change {
    Insert {
        fields: Vec<Field>,
    },
    Update {
        identity: RowIdentity,
        fields: Vec<Field>,
    },
    Delete {
        identity: RowIdentity,
    },
}

struct Table {
    sql_name: String,
    columns: Vec<Column>,
    primary_key: Vec<usize>,
    cursor_key: Vec<String>,
    rowid: Option<&'static str>,
    without_rowid: bool,
    version: String,
}

fn identifier(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn file_identity(path: &Path) -> Result<String, TableError> {
    let canonical = path.canonicalize().map_err(|_| TableError::File)?;
    let identity = canonical.to_string_lossy();
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let file = canonical.metadata().map_err(|_| TableError::File)?;
        Ok(format!("{identity}\0{}:{}", file.dev(), file.ino()))
    }
    #[cfg(not(unix))]
    Ok(identity.into_owned())
}

async fn inspect_table(
    connection: &mut SqliteConnection,
    name: &str,
    file: &str,
) -> Result<Table, TableError> {
    if name.is_empty() || name.contains('\0') || name.to_ascii_lowercase().starts_with("sqlite_") {
        return Err(TableError::Unsupported);
    }
    let without_rowid: bool = sqlx::query_scalar(
        "SELECT wr FROM pragma_table_list WHERE schema = 'main' AND type = 'table' AND name = ?",
    )
    .bind(name)
    .fetch_optional(&mut *connection)
    .await?
    .ok_or(TableError::Unsupported)?;
    let schema_version: i64 = sqlx::query_scalar("PRAGMA main.schema_version")
        .fetch_one(&mut *connection)
        .await?;
    let metadata = sqlx::query(
        "SELECT name, type, pk, hidden, \"notnull\" FROM pragma_table_xinfo(?, 'main') ORDER BY cid LIMIT ?",
    )
    .bind(name)
    .bind(i64::try_from(COLUMN_LIMIT + 1).unwrap_or(i64::MAX))
    .fetch_all(&mut *connection)
    .await?;
    if metadata.is_empty() || metadata.len() > COLUMN_LIMIT {
        return Err(TableError::Unsupported);
    }
    let mut columns = Vec::with_capacity(metadata.len());
    let mut key = Vec::new();
    let mut key_not_null = true;
    for row in metadata {
        let position: i64 = row.try_get("pk")?;
        let not_null = row.try_get::<bool, _>("notnull")?;
        if position != 0 {
            key.push((position, columns.len()));
            key_not_null &= not_null;
        }
        columns.push(Column {
            name: row.try_get("name")?,
            declared_type: row.try_get("type")?,
            generated: row.try_get::<i64, _>("hidden")? != 0,
            primary_key: position != 0,
            not_null,
        });
    }
    key.sort_unstable();
    let rowid = ["_rowid_", "rowid", "oid"].into_iter().find(|name| {
        !without_rowid
            && !columns
                .iter()
                .any(|column| column.name.eq_ignore_ascii_case(name))
    });
    let mut cursor_key = Vec::new();
    if !key.is_empty() {
        let key_parts: Vec<(String, String)> = sqlx::query_as(
            "SELECT x.name, x.coll FROM pragma_index_list(?, 'main') AS p
             JOIN pragma_index_xinfo(p.name, 'main') AS x
             WHERE p.origin = 'pk' AND x.\"key\" AND x.cid >= 0 ORDER BY x.seqno",
        )
        .bind(name)
        .fetch_all(&mut *connection)
        .await?;
        // A declared INTEGER PRIMARY KEY without a PK index aliases the rowid.
        if key_parts.is_empty()
            && key.len() == 1
            && columns[key[0].1]
                .declared_type
                .eq_ignore_ascii_case("INTEGER")
        {
            cursor_key.push(identifier(&columns[key[0].1].name));
        } else if (without_rowid || key_not_null) && key_parts.len() == key.len() {
            // Index collations determine uniqueness and can differ from column defaults.
            cursor_key.extend(key_parts.into_iter().map(|(name, collation)| {
                format!("{} COLLATE {}", identifier(&name), identifier(&collation))
            }));
        }
    }
    if cursor_key.is_empty()
        && let Some(rowid) = rowid
    {
        cursor_key.push(rowid.to_owned());
    }
    let version = format!(
        "{:x}",
        Sha256::digest(format!("{file}\0{schema_version}\0{name}"))
    );
    Ok(Table {
        sql_name: format!("main.{}", identifier(name)),
        columns,
        cursor_key,
        primary_key: key.into_iter().map(|(_, position)| position).collect(),
        rowid,
        without_rowid,
        version,
    })
}

fn projection(table: &Table, browse: Option<&BrowseOrder>) -> QueryBuilder<Sqlite> {
    let mut query = QueryBuilder::new("SELECT ");
    let expressions = table.columns.iter().map(|column| {
        let name = identifier(&column.name);
        // Never pull arbitrary blobs or oversized text through the driver.
        format!("CASE WHEN typeof({name}) = 'blob' OR (typeof({name}) = 'text' AND length(CAST({name} AS BLOB)) > {CELL_LIMIT}) THEN X'' ELSE {name} END")
    }).collect::<Vec<_>>();
    query.push(expressions.join(", "));
    if let Some(order) = browse {
        order.add_projection(&mut query);
    }
    query.push(" FROM ").push(&table.sql_name);
    query
}

fn cells(row: &sqlx::sqlite::SqliteRow, columns: usize) -> Result<Vec<Cell>, TableError> {
    (0..columns)
        .map(|position| {
            let raw = row.try_get_raw(position)?;
            let value = if raw.is_null() {
                Value::Null
            } else {
                match raw.type_info().name() {
                    "INTEGER" => Value::Integer {
                        value: row.try_get_unchecked::<i64, _>(position)?.to_string(),
                    },
                    "REAL" => {
                        let value: f64 = row.try_get_unchecked(position)?;
                        if !value.is_finite() {
                            return Ok(Cell::Unavailable);
                        }
                        Value::Real {
                            value: value.to_string(),
                        }
                    }
                    "TEXT" => match row.try_get_unchecked::<String, _>(position) {
                        Ok(value) if value.len() <= CELL_LIMIT => Value::Text { value },
                        _ => return Ok(Cell::Unavailable),
                    },
                    _ => return Ok(Cell::Unavailable),
                }
            };
            Ok(Cell::Value(value))
        })
        .collect()
}

fn revision(cells: &[Cell]) -> Result<String, TableError> {
    let serialized = serde_json::to_vec(cells).map_err(|_| TableError::Database)?;
    Ok(format!("{:x}", Sha256::digest(serialized)))
}

fn row_identity(table: &Table, cells: &[Cell]) -> Result<Option<RowIdentity>, TableError> {
    if table.primary_key.is_empty() || cells.iter().any(|cell| matches!(cell, Cell::Unavailable)) {
        return Ok(None);
    }
    let key: Option<Vec<_>> = table
        .primary_key
        .iter()
        .map(|&position| match &cells[position] {
            Cell::Value(Value::Null) | Cell::Unavailable => None,
            Cell::Value(value) => Some(value.clone()),
        })
        .collect();
    key.map(|key| {
        Ok(RowIdentity {
            key,
            revision: revision(cells)?,
        })
    })
    .transpose()
}

struct ReadPage {
    rows: Vec<TableRow>,
    statement: String,
    next_offset: Option<u32>,
    next_cursor: Option<PageCursor>,
}

async fn read_rows(
    connection: &mut SqliteConnection,
    table: &Table,
    options: &ReadOptions,
) -> Result<ReadPage, TableError> {
    let page_size = options.page_size.unwrap_or(DEFAULT_PAGE_SIZE);
    if !(1..=MAX_PAGE_SIZE).contains(&page_size) {
        return Err(TableError::InvalidBrowse);
    }
    let browse = BrowseOrder::new(table, options.sort.as_ref())?;
    if options.cursor.is_some() && browse.is_none() {
        return Err(TableError::InvalidBrowse);
    }
    let mut query = projection(table, browse.as_ref());
    add_where_filter(&mut query, table, options.filter.as_ref())?;
    if let Some(order) = &browse {
        if let Some(cursor) = &options.cursor {
            query.push(if options.filter.is_some() {
                " AND "
            } else {
                " WHERE "
            });
            order.add_boundary(&mut query, table, cursor)?;
        }
        order.add_order(&mut query);
    } else {
        add_legacy_order(&mut query, table, options.sort.as_ref())?;
    }
    query.push(" LIMIT ").push(page_size + 1);
    // Known boundaries seek by key. A direct page jump with no saved cursor
    // uses the requested offset in the same ordering.
    if options.cursor.is_none() && options.offset != 0 {
        query.push(" OFFSET ").push_bind(i64::from(options.offset));
    }
    let statement = query.sql().as_str().to_owned();
    let mut result = query.build().fetch(connection);
    let mut rows = Vec::new();
    let mut bytes = 0;
    let mut last = None;
    let payload_limit = if options.page_size.is_some() {
        FIXED_PAGE_PAYLOAD_LIMIT
    } else {
        PAYLOAD_LIMIT
    };
    while let Some(row) = result.try_next().await? {
        if rows.len() == page_size {
            return end_page(
                options.offset,
                rows,
                statement,
                browse.as_ref(),
                table,
                last.as_ref(),
            );
        }
        let cells = cells(&row, table.columns.len())?;
        let value = TableRow {
            identity: row_identity(table, &cells)?,
            cells,
        };
        bytes += serde_json::to_vec(&value)
            .map_err(|_| TableError::Database)?
            .len();
        if bytes > payload_limit {
            if options.page_size.is_some() {
                // Shortening a fixed-size page would make direct page numbers
                // disagree with the boundaries found by sequential paging.
                return Err(TableError::FixedPageLimit);
            }
            return end_page(
                options.offset,
                rows,
                statement,
                browse.as_ref(),
                table,
                last.as_ref(),
            );
        }
        rows.push(value);
        last = Some(row);
    }
    Ok(ReadPage {
        rows,
        statement,
        next_offset: None,
        next_cursor: None,
    })
}

fn end_page(
    offset: u32,
    rows: Vec<TableRow>,
    statement: String,
    browse: Option<&BrowseOrder>,
    table: &Table,
    last: Option<&sqlx::sqlite::SqliteRow>,
) -> Result<ReadPage, TableError> {
    if rows.is_empty() {
        return Err(TableError::PageLimit);
    }
    let emitted = u32::try_from(rows.len()).map_err(|_| TableError::PageLimit)?;
    let next = offset.checked_add(emitted).ok_or(TableError::PageLimit)?;
    let next_cursor = match (browse, last) {
        (Some(order), Some(row)) => order.cursor(table, row)?,
        _ => None,
    };
    Ok(ReadPage {
        rows,
        statement,
        next_offset: Some(next),
        next_cursor,
    })
}

fn checked_column(table: &Table, name: &str) -> Result<String, TableError> {
    table
        .columns
        .iter()
        .find(|column| column.name == name)
        .map(|column| identifier(&column.name))
        .ok_or(TableError::InvalidBrowse)
}

fn add_where_filter(
    query: &mut QueryBuilder<Sqlite>,
    table: &Table,
    filter: Option<&Filter>,
) -> Result<(), TableError> {
    if let Some(filter) = filter {
        query.push(" WHERE (");
        add_filter(query, table, filter)?;
        query.push(")");
    }
    Ok(())
}

fn add_filter(
    query: &mut QueryBuilder<Sqlite>,
    table: &Table,
    filter: &Filter,
) -> Result<(), TableError> {
    let (rules, separator) = match filter {
        Filter::Group { mode, rules } => (
            rules.as_slice(),
            match mode {
                Match::All => " AND ",
                Match::Any => " OR ",
            },
        ),
        Filter::Rule(rule) => (std::slice::from_ref(rule), " AND "),
    };
    if !(1..=10).contains(&rules.len()) {
        return Err(TableError::InvalidBrowse);
    }
    for (index, rule) in rules.iter().enumerate() {
        if index > 0 {
            query.push(separator);
        }
        query.push("(");
        add_filter_rule(query, table, rule)?;
        query.push(")");
    }
    Ok(())
}

fn filter_value(value: Option<&str>) -> Result<&str, TableError> {
    value
        .filter(|value| value.len() <= CELL_LIMIT && !value.contains('\0'))
        .ok_or(TableError::InvalidBrowse)
}

fn filter_pattern(kind: &FilterKind, value: &str) -> String {
    let mut pattern = String::new();
    if !matches!(kind, FilterKind::StartsWith | FilterKind::NotStartsWith) {
        pattern.push('%');
    }
    for character in value.chars() {
        if matches!(character, '!' | '%' | '_') {
            pattern.push('!');
        }
        pattern.push(character);
    }
    if !matches!(kind, FilterKind::EndsWith | FilterKind::NotEndsWith) {
        pattern.push('%');
    }
    pattern
}

fn add_filter_rule(
    query: &mut QueryBuilder<Sqlite>,
    table: &Table,
    rule: &FilterRule,
) -> Result<(), TableError> {
    use FilterKind::{
        Between, Contains, EndsWith, Equals, Greater, GreaterOrEqual, InList, IsEmpty, IsNotEmpty,
        IsNotNull, IsNull, Less, LessOrEqual, NotBetween, NotContains, NotEndsWith, NotEquals,
        NotInList, NotStartsWith, StartsWith,
    };
    let name = checked_column(table, &rule.column)?;
    let value = || filter_value(rule.value.as_deref());
    if !matches!(rule.kind, IsNull | IsNotNull) {
        query.push("typeof(").push(&name).push(") <> 'blob' AND ");
    }
    match rule.kind {
        IsNull | IsNotNull => {
            query.push(name).push(if matches!(rule.kind, IsNull) {
                " IS NULL"
            } else {
                " IS NOT NULL"
            });
        }
        IsEmpty | IsNotEmpty => {
            query
                .push("length(CAST(")
                .push(name)
                .push(" AS BLOB))")
                .push(if matches!(rule.kind, IsEmpty) {
                    " = 0"
                } else {
                    " > 0"
                });
        }
        Contains | NotContains | StartsWith | NotStartsWith | EndsWith | NotEndsWith => {
            query
                .push("CAST(")
                .push(name)
                .push(" AS TEXT)")
                .push(
                    if matches!(rule.kind, NotContains | NotStartsWith | NotEndsWith) {
                        " NOT LIKE "
                    } else {
                        " LIKE "
                    },
                )
                .push_bind(filter_pattern(&rule.kind, value()?))
                .push(" ESCAPE '!'");
        }
        Between | NotBetween => {
            query
                .push(name)
                .push(if matches!(rule.kind, NotBetween) {
                    " NOT BETWEEN "
                } else {
                    " BETWEEN "
                })
                .push_bind(value()?.to_owned())
                .push(" AND ")
                .push_bind(filter_value(rule.end.as_deref())?.to_owned());
        }
        InList | NotInList => {
            let values = rule.values.as_deref().unwrap_or_default();
            if !(1..=50).contains(&values.len()) {
                return Err(TableError::InvalidBrowse);
            }
            query.push(name).push(if matches!(rule.kind, NotInList) {
                " NOT IN ("
            } else {
                " IN ("
            });
            let mut list = query.separated(", ");
            for value in values {
                list.push_bind(filter_value(Some(value))?.to_owned());
            }
            query.push(")");
        }
        Equals | NotEquals | Less | LessOrEqual | Greater | GreaterOrEqual => {
            let comparison = match rule.kind {
                Equals => " = ",
                NotEquals => " <> ",
                Less => " < ",
                LessOrEqual => " <= ",
                Greater => " > ",
                GreaterOrEqual => " >= ",
                _ => unreachable!(),
            };
            query
                .push(name)
                .push(comparison)
                .push_bind(value()?.to_owned());
        }
    }
    Ok(())
}

fn add_legacy_order(
    query: &mut QueryBuilder<Sqlite>,
    table: &Table,
    sort: Option<&Sort>,
) -> Result<(), TableError> {
    let mut order = Vec::new();
    if let Some(sort) = sort {
        let name = checked_column(table, &sort.column)?;
        let direction = match sort.direction {
            Direction::Asc => "ASC",
            Direction::Desc => "DESC",
        };
        order.push(format!("{name} {direction}"));
    }
    order.extend(
        table
            .primary_key
            .iter()
            .map(|&index| identifier(&table.columns[index].name)),
    );
    if let Some(rowid) = table.rowid {
        order.push(rowid.to_owned());
    } else if !table.without_rowid {
        // All three rowid names can be shadowed. Finish ordering by the stored
        // column values so distinguishable rows have a consistent position.
        order.extend(
            table
                .columns
                .iter()
                .map(|column| format!("{} COLLATE BINARY", identifier(&column.name))),
        );
    }
    query.push(" ORDER BY ").push(order.join(", "));
    Ok(())
}

/// Reads a bounded page and produces optimistic row identities.
/// # Errors
/// Returns an error when the file, table, or bounded read is unavailable.
pub async fn load(path: &Path, name: &str, options: &ReadOptions) -> Result<TableData, TableError> {
    let file = file_identity(path)?;
    let mut connection = connect(path).await.map_err(|_| TableError::File)?;
    let result = async {
        set_deadline(
            &mut connection,
            CancellationToken::new(),
            Instant::now() + TIME_LIMIT,
        )
        .await
        .map_err(|_| TableError::Database)?;
        let mut transaction = connection.begin().await?;
        let table = inspect_table(&mut transaction, name, &file).await?;
        let page = read_rows(&mut transaction, &table, options).await?;
        transaction.commit().await?;
        Ok(TableData {
            version: table.version,
            columns: table.columns,
            rows: page.rows,
            statement: page.statement,
            next_offset: page.next_offset,
            next_cursor: page.next_cursor,
        })
    }
    .await;
    let _ = connection.close().await;
    result
}

/// Counts rows matching the same predicates as the table browser.
/// # Errors
/// Returns an error if the table, filter, or bounded read is unavailable.
pub async fn count_rows(
    path: &Path,
    name: &str,
    options: &CountOptions,
) -> Result<i64, TableError> {
    let file = file_identity(path)?;
    let mut connection = connect(path).await.map_err(|_| TableError::File)?;
    let result = async {
        set_deadline(
            &mut connection,
            CancellationToken::new(),
            Instant::now() + TIME_LIMIT,
        )
        .await
        .map_err(|_| TableError::Database)?;
        let mut transaction = connection.begin().await?;
        let table = inspect_table(&mut transaction, name, &file).await?;
        let mut query = QueryBuilder::<Sqlite>::new("SELECT COUNT(*) FROM ");
        query.push(&table.sql_name);
        add_where_filter(&mut query, &table, options.filter.as_ref())?;
        let rows = query
            .build_query_scalar()
            .fetch_one(&mut *transaction)
            .await?;
        transaction.commit().await?;
        Ok(rows)
    }
    .await;
    let _ = connection.close().await;
    result
}

fn bind(query: &mut QueryBuilder<Sqlite>, value: &Value) -> Result<(), TableError> {
    match value {
        Value::Null => {
            query.push_bind(None::<String>);
        }
        Value::Text { value } if value.len() <= CELL_LIMIT => {
            query.push_bind(value.clone());
        }
        Value::Integer { value } => {
            query.push_bind(value.parse::<i64>().map_err(|_| TableError::Invalid)?);
        }
        Value::Real { value } => {
            let number = value.parse::<f64>().map_err(|_| TableError::Invalid)?;
            if !number.is_finite() {
                return Err(TableError::Invalid);
            }
            query.push_bind(number);
        }
        Value::Text { .. } => return Err(TableError::Invalid),
    }
    Ok(())
}

fn where_key(
    query: &mut QueryBuilder<Sqlite>,
    table: &Table,
    identity: &RowIdentity,
) -> Result<(), TableError> {
    if table.primary_key.is_empty() || table.primary_key.len() != identity.key.len() {
        return Err(TableError::Invalid);
    }
    for (index, (&column, value)) in table.primary_key.iter().zip(&identity.key).enumerate() {
        if matches!(value, Value::Null) {
            return Err(TableError::Invalid);
        }
        query
            .push(if index == 0 { " WHERE " } else { " AND " })
            .push(identifier(&table.columns[column].name))
            .push(" COLLATE BINARY IS ");
        bind(query, value)?;
    }
    Ok(())
}

async fn require_current(
    connection: &mut SqliteConnection,
    table: &Table,
    identity: &RowIdentity,
    change_index: usize,
) -> Result<(), TableError> {
    let mut query = projection(table, None);
    where_key(&mut query, table, identity)?;
    let rows = query.push(" LIMIT 2").build().fetch_all(connection).await?;
    if let [row] = rows.as_slice() {
        let values = cells(row, table.columns.len())?;
        if row_identity(table, &values)?
            .is_some_and(|current| current.revision == identity.revision)
        {
            return Ok(());
        }
    }
    Err(TableError::RowChanged(change_index))
}

fn field_names(table: &Table, fields: &[Field]) -> Result<Vec<String>, TableError> {
    let mut seen = std::collections::HashSet::new();
    fields
        .iter()
        .map(|field| {
            let column = table
                .columns
                .get(field.column)
                .filter(|column| !column.generated)
                .ok_or(TableError::Invalid)?;
            if !seen.insert(field.column) {
                return Err(TableError::Invalid);
            }
            Ok(identifier(&column.name))
        })
        .collect()
}

async fn apply_change(
    connection: &mut SqliteConnection,
    table: &Table,
    change: &Change,
    index: usize,
) -> Result<(), TableError> {
    let mut query = match change {
        Change::Insert { fields } => {
            let mut query = QueryBuilder::new("INSERT OR ABORT INTO ");
            query.push(&table.sql_name);
            if fields.is_empty() {
                query.push(" DEFAULT VALUES");
            } else {
                let names = field_names(table, fields)?;
                query.push(" (").push(names.join(", ")).push(") VALUES (");
                for (position, field) in fields.iter().enumerate() {
                    if position != 0 {
                        query.push(", ");
                    }
                    bind(&mut query, &field.value)?;
                }
                query.push(")");
            }
            query
        }
        Change::Update { identity, fields } => {
            if fields.is_empty() {
                return Err(TableError::Invalid);
            }
            let names = field_names(table, fields)?;
            require_current(connection, table, identity, index).await?;
            let mut query = QueryBuilder::new("UPDATE OR ABORT ");
            query.push(&table.sql_name).push(" SET ");
            for (position, (name, field)) in names.iter().zip(fields).enumerate() {
                if position != 0 {
                    query.push(", ");
                }
                query.push(name).push(" = ");
                bind(&mut query, &field.value)?;
            }
            where_key(&mut query, table, identity)?;
            query
        }
        Change::Delete { identity } => {
            require_current(connection, table, identity, index).await?;
            let mut query = QueryBuilder::new("DELETE FROM ");
            query.push(&table.sql_name);
            where_key(&mut query, table, identity)?;
            query
        }
    };
    let result = query.build().execute(connection).await?;
    if result.rows_affected() != 1 {
        return Err(TableError::RowChanged(index));
    }
    Ok(())
}

/// Applies the entire batch in one write transaction and checks row revisions under the write lock.
/// # Errors
/// A stale row, lock, validation error, or database constraint aborts the entire batch.
pub async fn save(
    path: &Path,
    name: &str,
    version: &str,
    changes: &[Change],
) -> Result<(), TableError> {
    if changes.is_empty()
        || changes.len() > CHANGE_LIMIT
        || serde_json::to_vec(changes)
            .map_err(|_| TableError::Invalid)?
            .len()
            > PAYLOAD_LIMIT
    {
        return Err(TableError::Invalid);
    }
    let file = file_identity(path)?;
    let mut connection = connect_for_write(path).await?;
    let result = save_connected(&mut connection, name, &file, version, changes).await;
    let _ = connection.close().await;
    result
}

async fn save_connected(
    connection: &mut SqliteConnection,
    name: &str,
    file: &str,
    version: &str,
    changes: &[Change],
) -> Result<(), TableError> {
    let deadline = Instant::now() + TIME_LIMIT;
    set_deadline(connection, CancellationToken::new(), deadline)
        .await
        .map_err(|_| TableError::Database)?;
    let mut transaction = connection.begin_with("BEGIN IMMEDIATE").await?;
    let result = async {
        let table = inspect_table(&mut transaction, name, file).await?;
        if table.version != version {
            return Err(TableError::TableChanged);
        }
        for (index, change) in changes.iter().enumerate() {
            apply_change(&mut transaction, &table, change, index + 1).await?;
        }
        if Instant::now() >= deadline {
            return Err(TableError::Timeout);
        }
        Ok(())
    }
    .await;
    if let Err(error) = result {
        let _ = transaction.rollback().await;
        return Err(error);
    }
    // SQLx rolls back on drop if COMMIT itself is rejected, e.g. by a deferred FK.
    transaction.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::{Executor, sqlite::SqliteConnectOptions};

    async fn fixture(
        sql: &'static str,
    ) -> (tempfile::TempDir, std::path::PathBuf, SqliteConnection) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("editor.sqlite");
        let mut independent = SqliteConnection::connect_with(
            &SqliteConnectOptions::new()
                .filename(&path)
                .create_if_missing(true),
        )
        .await
        .unwrap();
        sqlx::raw_sql(sql).execute(&mut independent).await.unwrap();
        (dir, path, independent)
    }

    fn field(column: usize, text: &str) -> Field {
        Field {
            column,
            value: Value::Text { value: text.into() },
        }
    }

    fn identity(data: &mut TableData, row: usize) -> RowIdentity {
        data.rows[row].identity.take().unwrap()
    }

    fn integer_cell(row: &TableRow, column: usize) -> i64 {
        match &row.cells[column] {
            Cell::Value(Value::Integer { value }) => value.parse().unwrap(),
            other => panic!("expected integer, found {other:?}"),
        }
    }

    #[tokio::test]
    async fn filters_literal_values_and_sorts_before_paginating() {
        let (_dir, path, _separate) = fixture(
            r"CREATE TABLE ledger(id INTEGER PRIMARY KEY, label TEXT, score INTEGER, remark TEXT);
             WITH RECURSIVE series(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM series WHERE n<205)
             INSERT INTO ledger SELECT n, CASE WHEN n<=105 THEN 'Prefix %_' ELSE 'plain' END,
                 n%2, CASE WHEN n>105 THEN 'ok' END FROM series;",
        )
        .await;
        let mut options = ReadOptions {
            filter: Some(
                serde_json::from_value(serde_json::json!({
                    "column": "label", "kind": "contains", "value": "prefix %_"
                }))
                .unwrap(),
            ),
            sort: Some(Sort {
                column: "score".into(),
                direction: Direction::Desc,
            }),
            ..ReadOptions::default()
        };
        let first = load(&path, "ledger", &options).await.unwrap();
        assert!(first.statement.contains("FROM main.\"ledger\" WHERE ("));
        assert!(first.statement.contains('?'));
        assert!(!first.statement.contains("prefix %_"));
        let count_options: CountOptions = serde_json::from_value(serde_json::json!({
            "filter": { "column": "label", "kind": "contains", "value": "prefix %_" }
        }))
        .unwrap();
        assert_eq!(
            count_rows(&path, "ledger", &count_options).await.unwrap(),
            105
        );
        options.offset = first.next_offset.unwrap();
        options.cursor = Some(first.next_cursor.unwrap());
        assert_eq!(options.offset, 100);
        let second = load(&path, "ledger", &options).await.unwrap();
        assert!(second.next_offset.is_none());
        let expected: Vec<i64> = (1..=53)
            .rev()
            .map(|i| 2 * i - 1)
            .chain((1..=52).rev().map(|i| 2 * i))
            .collect();
        let actual: Vec<i64> = first
            .rows
            .iter()
            .chain(&second.rows)
            .map(|row| integer_cell(row, 0))
            .collect();
        assert_eq!(actual, expected);

        let mut options = ReadOptions {
            filter: Some(
                serde_json::from_value(serde_json::json!({
                    "column": "label", "kind": "equals", "value": "' OR 1=1 --"
                }))
                .unwrap(),
            ),
            ..ReadOptions::default()
        };
        assert!(
            load(&path, "ledger", &options)
                .await
                .unwrap()
                .rows
                .is_empty()
        );
        options.filter = Some(
            serde_json::from_value(serde_json::json!({ "column": "remark", "kind": "isNull" }))
                .unwrap(),
        );
        assert_eq!(
            load(&path, "ledger", &options).await.unwrap().next_offset,
            Some(100)
        );
        options.filter = Some(
            serde_json::from_value(serde_json::json!({ "column": "remark", "kind": "isNotNull" }))
                .unwrap(),
        );
        let result = load(&path, "ledger", &options).await.unwrap();
        assert_eq!(result.rows.len(), 100);
        assert!(result.next_offset.is_none());
    }

    #[tokio::test]
    async fn combines_ranges_lists_and_missing_values() {
        let (_dir, path, _separate) = fixture(
            r"CREATE TABLE ledger(id INTEGER PRIMARY KEY, label TEXT, note TEXT);
              INSERT INTO ledger VALUES (1, 'Café_ one', NULL), (2, 'Café_ two', ''),
                (3, 'CaféX three', NULL), (4, 'item', ' ');",
        )
        .await;
        let mut options: ReadOptions = serde_json::from_value(serde_json::json!({
            "filter": { "match": "all", "rules": [
                { "column": "id", "kind": "between", "value": "1", "end": "3" },
                { "column": "label", "kind": "startsWith", "value": "Café_" },
                { "column": "note", "kind": "isNull" }
            ] }
        }))
        .unwrap();
        let result = load(&path, "ledger", &options).await.unwrap();
        assert_eq!(
            result
                .rows
                .iter()
                .map(|row| integer_cell(row, 0))
                .collect::<Vec<_>>(),
            [1]
        );

        options.filter = Some(
            serde_json::from_value(serde_json::json!({
                "match": "any", "rules": [
                    { "column": "id", "kind": "inList", "values": ["3", "4"] },
                    { "column": "note", "kind": "isEmpty" }
                ]
            }))
            .unwrap(),
        );
        let result = load(&path, "ledger", &options).await.unwrap();
        assert_eq!(
            result
                .rows
                .iter()
                .map(|row| integer_cell(row, 0))
                .collect::<Vec<_>>(),
            [2, 3, 4]
        );
    }

    #[tokio::test]
    async fn byte_limited_pages_resume_after_the_last_emitted_row() {
        let (_dir, path, _separate) = fixture(
            "CREATE TABLE wide(id INTEGER PRIMARY KEY, a, b, c, d, e, f);
             WITH RECURSIVE series(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM series WHERE n<110)
             INSERT INTO wide SELECT n, printf('%4096s','a'), printf('%4096s','b'),
                 printf('%4096s','c'), printf('%4096s','d'), printf('%4096s','e'), printf('%4096s','f') FROM series;",
        ).await;
        let first = load(&path, "wide", &ReadOptions::default()).await.unwrap();
        assert!(first.rows.len() < DEFAULT_PAGE_SIZE);
        assert_eq!(first.next_offset, u32::try_from(first.rows.len()).ok());
        let second = load(
            &path,
            "wide",
            &ReadOptions {
                offset: first.next_offset.unwrap(),
                cursor: Some(first.next_cursor.unwrap()),
                ..ReadOptions::default()
            },
        )
        .await
        .unwrap();
        assert!(second.next_offset.is_none());
        let ids: Vec<i64> = first
            .rows
            .iter()
            .chain(&second.rows)
            .map(|row| integer_cell(row, 0))
            .collect();
        assert_eq!(ids, (1..=110).collect::<Vec<_>>());
    }

    #[tokio::test]
    async fn a_fixed_page_jump_matches_the_cursor_even_after_a_wide_page() {
        let (_dir, path, _separate) = fixture(
            "CREATE TABLE wide(id INTEGER PRIMARY KEY, a, b, c, d, e, f);
             WITH RECURSIVE series(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM series WHERE n<119)
             INSERT INTO wide SELECT n, printf('%4096s','a'), printf('%4096s','b'),
                 printf('%4096s','c'), printf('%4096s','d'), printf('%4096s','e'), printf('%4096s','f') FROM series;",
        ).await;
        let mut options = ReadOptions {
            page_size: Some(100),
            ..ReadOptions::default()
        };
        let first = load(&path, "wide", &options).await.unwrap();
        assert_eq!(first.rows.len(), 100);
        assert_eq!(first.next_offset, Some(100));
        options.offset = 100;
        let jumped = load(&path, "wide", &options).await.unwrap();
        options.cursor = first.next_cursor;
        let continued = load(&path, "wide", &options).await.unwrap();
        let ids = |page: TableData| {
            page.rows
                .iter()
                .map(|row| integer_cell(row, 0))
                .collect::<Vec<_>>()
        };
        assert!(jumped.next_offset.is_none());
        assert_eq!(ids(jumped), (101..=119).collect::<Vec<_>>());
        assert_eq!(ids(continued), (101..=119).collect::<Vec<_>>());
    }

    #[tokio::test]
    async fn cursor_respects_primary_key_collation_after_a_nullable_sort() {
        let (_dir, path, mut separate) = fixture(
            "CREATE TABLE mixed(a TEXT COLLATE NOCASE, b INTEGER, score INTEGER,
               PRIMARY KEY(a COLLATE BINARY, b)) WITHOUT ROWID;
             WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<180)
             INSERT INTO mixed
             SELECT CASE WHEN i%2=0 THEN 'A' ELSE 'a' END, (i+1)/2,
               CASE WHEN i>130 THEN 1 END FROM n;",
        )
        .await;
        let expected: Vec<(String, i64)> = sqlx::query_as(
            "SELECT a, b FROM mixed ORDER BY score ASC, a COLLATE BINARY ASC, b ASC",
        )
        .fetch_all(&mut separate)
        .await
        .unwrap();
        let mut options = ReadOptions {
            sort: Some(Sort {
                column: "score".into(),
                direction: Direction::Asc,
            }),
            ..ReadOptions::default()
        };
        let mut actual = Vec::new();
        loop {
            let page = load(&path, "mixed", &options).await.unwrap();
            actual.extend(page.rows.iter().map(|row| {
                let Cell::Value(Value::Text { value }) = &row.cells[0] else {
                    panic!("text key")
                };
                (value.clone(), integer_cell(row, 1))
            }));
            let Some(offset) = page.next_offset else {
                break;
            };
            options.offset = offset;
            options.cursor = Some(page.next_cursor.expect("bounded keyset cursor"));
        }
        assert_eq!(actual, expected);
    }

    #[tokio::test]
    async fn commits_insert_update_and_delete_to_a_real_file() {
        let (_dir, path, mut separate) = fixture(
            r#"
            CREATE TABLE "some""table" (
                group_id TEXT,
                item INTEGER,
                label TEXT NOT NULL DEFAULT 'default',
                upper_label TEXT GENERATED ALWAYS AS (upper(label)) STORED,
                PRIMARY KEY(group_id, item)
            ) WITHOUT ROWID;
            INSERT INTO "some""table" (group_id, item, label)
            VALUES ('alpha', 1, 'update'), ('alpha', 2, 'delete');
        "#,
        )
        .await;
        let mut data = load(&path, "some\"table", &ReadOptions::default())
            .await
            .unwrap();
        assert!(data.columns[3].generated);
        assert_eq!(
            serde_json::to_value(&data.rows[0].cells[1]).unwrap(),
            serde_json::json!({"kind":"integer","value":"1"})
        );
        let changes = [
            Change::Update {
                identity: identity(&mut data, 0),
                fields: vec![field(2, "it's saved")],
            },
            Change::Delete {
                identity: identity(&mut data, 1),
            },
            Change::Insert {
                fields: vec![field(0, "beta"), field(1, "3")],
            },
        ];
        save(&path, "some\"table", &data.version, &changes)
            .await
            .unwrap();
        let rows: Vec<(String, i64, String, String)> =
            sqlx::query_as(r#"SELECT * FROM "some""table" ORDER BY group_id, item"#)
                .fetch_all(&mut separate)
                .await
                .unwrap();
        assert_eq!(
            rows,
            [
                ("alpha".into(), 1, "it's saved".into(), "IT'S SAVED".into()),
                ("beta".into(), 3, "default".into(), "DEFAULT".into()),
            ]
        );
    }

    #[tokio::test]
    async fn statement_error_and_external_edits_roll_back_earlier_changes() {
        let (_dir, path, mut separate) = fixture(
            "CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT UNIQUE ON CONFLICT REPLACE);
             INSERT INTO items VALUES (1, 'original'), (2, 'taken');",
        )
        .await;
        let mut data = load(&path, "items", &ReadOptions::default()).await.unwrap();
        let changes = [
            Change::Update {
                identity: identity(&mut data, 0),
                fields: vec![field(1, "edited")],
            },
            Change::Insert {
                fields: vec![field(1, "taken")],
            },
        ];
        assert!(matches!(
            save(&path, "items", &data.version, &changes).await,
            Err(TableError::Constraint)
        ));

        let mut data = load(&path, "items", &ReadOptions::default()).await.unwrap();
        separate
            .execute("UPDATE items SET name='external' WHERE id=2")
            .await
            .unwrap();
        let changes = [
            Change::Insert {
                fields: vec![field(1, "discard this")],
            },
            Change::Delete {
                identity: identity(&mut data, 1),
            },
        ];
        assert!(matches!(
            save(&path, "items", &data.version, &changes).await,
            Err(TableError::RowChanged(2))
        ));
        let names: Vec<String> = sqlx::query_scalar("SELECT name FROM items ORDER BY id")
            .fetch_all(&mut separate)
            .await
            .unwrap();
        assert_eq!(names, ["original", "external"]);
    }

    #[tokio::test]
    async fn failed_commit_and_unsupported_rows_are_safe() {
        let (_dir, path, mut separate) = fixture(
            "CREATE TABLE parents(id INTEGER PRIMARY KEY);
             INSERT INTO parents VALUES (1);
             CREATE TABLE children(id INTEGER PRIMARY KEY, parent INTEGER REFERENCES parents(id) DEFERRABLE INITIALLY DEFERRED, data);
             INSERT INTO children VALUES (1, 1, X'00');",
        ).await;
        let data = load(&path, "children", &ReadOptions::default())
            .await
            .unwrap();
        assert!(data.rows[0].identity.is_none());
        assert_eq!(
            serde_json::to_value(&data.rows[0].cells[2]).unwrap(),
            serde_json::json!({"kind":"unavailable"})
        );
        let changes = [
            Change::Insert {
                fields: vec![field(1, "1")],
            },
            Change::Insert {
                fields: vec![field(1, "missing")],
            },
        ];
        assert!(matches!(
            save(&path, "children", &data.version, &changes).await,
            Err(TableError::Constraint)
        ));
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM children")
            .fetch_one(&mut separate)
            .await
            .unwrap();
        assert_eq!(count, 1);

        separate
            .execute("ALTER TABLE children ADD COLUMN added")
            .await
            .unwrap();
        assert!(matches!(
            save(&path, "children", &data.version, &changes).await,
            Err(TableError::TableChanged)
        ));
    }
}
