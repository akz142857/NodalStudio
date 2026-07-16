use sqlx::{
    Column, Row, TypeInfo, ValueRef,
    postgres::{PgRow, PgValueFormat},
};

use crate::{QueryCell, QueryError};

pub(crate) fn cells_from_row(
    row: &PgRow,
    max_cell_bytes: usize,
) -> Result<(Vec<QueryCell>, usize), QueryError> {
    let mut bytes: usize = 0;
    let cells = row
        .columns()
        .iter()
        .enumerate()
        .map(|(index, column)| {
            let raw = row.try_get_raw(index).map_err(|_| QueryError::Internal)?;
            if raw.is_null() {
                return Ok(QueryCell::Null);
            }
            if raw.format() != PgValueFormat::Text {
                return Err(QueryError::UnsupportedType);
            }
            let text = raw.as_str().map_err(|_| QueryError::UnsupportedType)?;
            bytes = bytes.saturating_add(text.len());
            Ok(cell_from_text(
                column.type_info().name(),
                text,
                max_cell_bytes,
            ))
        })
        .collect::<Result<Vec<_>, QueryError>>()?;
    Ok((cells, bytes))
}

fn cell_from_text(database_type: &str, text: &str, max_cell_bytes: usize) -> QueryCell {
    match database_type.to_ascii_lowercase().as_str() {
        "bool" => QueryCell::Boolean {
            value: matches!(text, "t" | "true" | "1"),
        },
        "int2" | "int4" | "float4" | "float8" => text
            .parse::<f64>()
            .ok()
            .filter(|value| value.is_finite())
            .map_or_else(
                || text_cell(text, max_cell_bytes),
                |value| QueryCell::Number { value },
            ),
        "json" | "jsonb" if text.len() <= max_cell_bytes => serde_json::from_str(text).map_or_else(
            |_| text_cell(text, max_cell_bytes),
            |value| QueryCell::Json {
                value,
                truncated: false,
            },
        ),
        "bytea" => QueryCell::Binary {
            byte_length: text
                .strip_prefix("\\x")
                .map_or(text.len(), |hex| hex.len() / 2),
        },
        _ => text_cell(text, max_cell_bytes),
    }
}

fn text_cell(text: &str, max_cell_bytes: usize) -> QueryCell {
    let truncated = text.len() > max_cell_bytes;
    let value = if truncated {
        truncate_utf8(text, max_cell_bytes).to_owned()
    } else {
        text.to_owned()
    };
    QueryCell::Text { value, truncated }
}

fn truncate_utf8(value: &str, max_bytes: usize) -> &str {
    if value.len() <= max_bytes {
        return value;
    }
    let mut boundary = max_bytes;
    while boundary > 0 && !value.is_char_boundary(boundary) {
        boundary -= 1;
    }
    &value[..boundary]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_large_numbers_as_text() {
        assert_eq!(
            cell_from_text("int8", "9223372036854775807", 64),
            QueryCell::Text {
                value: "9223372036854775807".into(),
                truncated: false,
            }
        );
        assert_eq!(
            cell_from_text("numeric", "1234567890.123456789", 64),
            QueryCell::Text {
                value: "1234567890.123456789".into(),
                truncated: false,
            }
        );
    }

    #[test]
    fn truncates_on_utf8_boundary() {
        assert_eq!(
            text_cell("你好 world", 5),
            QueryCell::Text {
                value: "你".into(),
                truncated: true,
            }
        );
    }
}
