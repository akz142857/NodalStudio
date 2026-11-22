use super::{Direction, Sort, Table, TableError, identifier};
use serde::{Deserialize, Serialize};
use sqlx::{QueryBuilder, Row, Sqlite, TypeInfo, ValueRef, sqlite::SqliteRow};

const CURSOR_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(super) struct PageCursor {
    version: String,
    values: Vec<Boundary>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase")]
enum Boundary {
    Null,
    Integer(String),
    Real(String),
    Text(String),
    Binary(Vec<u8>),
}

impl Boundary {
    fn bind(&self, query: &mut QueryBuilder<Sqlite>) -> Result<(), TableError> {
        match self {
            Self::Integer(value) => {
                query.push_bind(
                    value
                        .parse::<i64>()
                        .map_err(|_| TableError::InvalidBrowse)?,
                );
            }
            Self::Real(value) => {
                let number = value
                    .parse::<f64>()
                    .map_err(|_| TableError::InvalidBrowse)?;
                if number.is_nan() {
                    return Err(TableError::InvalidBrowse);
                }
                query.push_bind(number);
            }
            Self::Text(text) if text.len() <= CURSOR_BYTES => {
                query.push_bind(text.clone());
            }
            Self::Binary(bytes) if bytes.len() <= CURSOR_BYTES => {
                query.push_bind(bytes.clone());
            }
            _ => return Err(TableError::InvalidBrowse),
        }
        Ok(())
    }
}

pub(super) struct BrowseOrder {
    fields: Vec<String>,
    direction: Direction,
    nullable_first: bool,
}

impl BrowseOrder {
    pub(super) fn new(table: &Table, sort: Option<&Sort>) -> Result<Option<Self>, TableError> {
        if table.cursor_key.is_empty() {
            return Ok(None);
        }
        let key = table.cursor_key.clone();
        let Some(sort) = sort else {
            return Ok(Some(Self {
                fields: key,
                direction: Direction::Asc,
                nullable_first: false,
            }));
        };
        let column = table
            .columns
            .iter()
            .find(|column| column.name == sort.column)
            .ok_or(TableError::InvalidBrowse)?;
        let field = identifier(&column.name);
        let nullable_first = !column.not_null && !key.contains(&field);
        let fields = std::iter::once(field.clone())
            .chain(key.into_iter().filter(|part| *part != field))
            .collect();
        Ok(Some(Self {
            fields,
            direction: sort.direction,
            nullable_first,
        }))
    }

    pub(super) fn add_projection(&self, query: &mut QueryBuilder<Sqlite>) {
        for field in &self.fields {
            query.push(format!(
                ", CASE WHEN length(CAST({field} AS BLOB)) > {CURSOR_BYTES} THEN NULL ELSE {field} END"
            ));
        }
        query
            .push(", (")
            .push(
                self.fields
                    .iter()
                    .map(|field| format!("length(CAST({field} AS BLOB)) > {CURSOR_BYTES}"))
                    .collect::<Vec<_>>()
                    .join(" OR "),
            )
            .push(")");
    }

    pub(super) fn add_order(&self, query: &mut QueryBuilder<Sqlite>) {
        let direction = if self.direction == Direction::Desc {
            "DESC"
        } else {
            "ASC"
        };
        query.push(" ORDER BY ").push(
            self.fields
                .iter()
                .map(|field| format!("{field} {direction}"))
                .collect::<Vec<_>>()
                .join(", "),
        );
    }

    pub(super) fn add_boundary(
        &self,
        query: &mut QueryBuilder<Sqlite>,
        table: &Table,
        cursor: &PageCursor,
    ) -> Result<(), TableError> {
        let values = &cursor.values;
        if cursor.version != table.version || values.len() != self.fields.len() {
            return Err(TableError::InvalidBrowse);
        }
        let first = &self.fields[0];
        let descending = self.direction == Direction::Desc;
        query.push("(");
        if matches!(values[0], Boundary::Null) {
            if !self.nullable_first || values.len() < 2 {
                return Err(TableError::InvalidBrowse);
            }
            if !descending {
                query.push(first).push(" IS NOT NULL OR ");
            }
            query.push("(").push(first).push(" IS NULL AND ");
            self.add_comparison(query, &self.fields[1..], &values[1..])?;
            query.push(")");
        } else {
            if descending && self.nullable_first {
                query.push(first).push(" IS NULL OR ");
            }
            self.add_comparison(query, &self.fields, values)?;
        }
        query.push(")");
        Ok(())
    }

    fn add_comparison(
        &self,
        query: &mut QueryBuilder<Sqlite>,
        fields: &[String],
        values: &[Boundary],
    ) -> Result<(), TableError> {
        let tuple = fields.len() > 1;
        if tuple {
            query.push("(");
        }
        query.push(fields.join(", "));
        if tuple {
            query.push(")");
        }
        query.push(if self.direction == Direction::Desc {
            " < "
        } else {
            " > "
        });
        if tuple {
            query.push("(");
        }
        for (index, value) in values.iter().enumerate() {
            if index != 0 {
                query.push(", ");
            }
            value.bind(query)?;
        }
        if tuple {
            query.push(")");
        }
        Ok(())
    }

    pub(super) fn cursor(
        &self,
        table: &Table,
        row: &SqliteRow,
    ) -> Result<Option<PageCursor>, TableError> {
        let start = table.columns.len();
        let end = start + self.fields.len();
        if row.try_get::<Option<bool>, _>(end)?.unwrap_or(false) {
            return Ok(None);
        }
        let mut values = Vec::new();
        for index in start..end {
            let raw = row.try_get_raw(index)?;
            let value = if raw.is_null() {
                Boundary::Null
            } else {
                match raw.type_info().name() {
                    "INTEGER" => {
                        Boundary::Integer(row.try_get_unchecked::<i64, _>(index)?.to_string())
                    }
                    "REAL" => Boundary::Real(row.try_get_unchecked::<f64, _>(index)?.to_string()),
                    "TEXT" => match row.try_get_unchecked(index) {
                        Ok(text) => Boundary::Text(text),
                        Err(_) => return Ok(None),
                    },
                    "BLOB" => Boundary::Binary(row.try_get_unchecked(index)?),
                    _ => return Ok(None),
                }
            };
            values.push(value);
        }
        if serde_json::to_vec(&values)
            .map_err(|_| TableError::Database)?
            .len()
            > CURSOR_BYTES
        {
            return Ok(None);
        }
        Ok(Some(PageCursor {
            version: table.version.clone(),
            values,
        }))
    }
}
