use crate::{QueryCell, QueryError, value::text_cell};
use sqlx::{Column, Decode, MySql, Row, TypeInfo, ValueRef, mysql::MySqlRow};

pub(crate) fn cells_from_row(
    row: &MySqlRow,
    max_cell_bytes: usize,
) -> Result<(Vec<QueryCell>, usize), QueryError> {
    let mut bytes = 0usize;
    let cells = row
        .columns()
        .iter()
        .enumerate()
        .map(|(index, column)| {
            let raw = row.try_get_raw(index).map_err(|_| QueryError::Internal)?;
            if raw.is_null() {
                return Ok(QueryCell::Null);
            }
            // This function is used only with raw_sql's text protocol. Decode the wire bytes
            // directly, without a lossy numeric conversion or a type compatibility cast.
            let value =
                <&[u8] as Decode<MySql>>::decode(raw).map_err(|_| QueryError::UnsupportedType)?;
            bytes = bytes.saturating_add(value.len());
            cell_from_bytes(column.type_info().name(), value, max_cell_bytes)
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok((cells, bytes))
}

fn cell_from_bytes(kind: &str, bytes: &[u8], limit: usize) -> Result<QueryCell, QueryError> {
    if matches!(
        kind,
        "BINARY"
            | "VARBINARY"
            | "TINYBLOB"
            | "BLOB"
            | "MEDIUMBLOB"
            | "LONGBLOB"
            | "BIT"
            | "GEOMETRY"
    ) {
        return Ok(QueryCell::Binary {
            byte_length: bytes.len(),
        });
    }
    let text = std::str::from_utf8(bytes).map_err(|_| QueryError::UnsupportedType)?;
    Ok(match kind {
        "BOOLEAN" if matches!(text, "0" | "1") => QueryCell::Boolean { value: text == "1" },
        "BOOLEAN" | "TINYINT" | "TINYINT UNSIGNED" | "SMALLINT" | "SMALLINT UNSIGNED"
        | "MEDIUMINT" | "MEDIUMINT UNSIGNED" | "INT" | "INT UNSIGNED" | "FLOAT" | "DOUBLE"
        | "YEAR" => text
            .parse::<f64>()
            .ok()
            .filter(|value| value.is_finite())
            .map_or_else(
                || text_cell(text, limit),
                |value| QueryCell::Number { value },
            ),
        "JSON" if bytes.len() <= limit => serde_json::from_str(text).map_or_else(
            |_| text_cell(text, limit),
            |value| QueryCell::Json {
                value,
                raw: Some(text.to_owned()),
                truncated: false,
            },
        ),
        // BIGINT/UNSIGNED/DECIMAL remain exact; dates and durations remain server text.
        _ => text_cell(text, limit),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_exact_values_and_utf8_boundaries() {
        for (kind, value) in [
            ("BIGINT UNSIGNED", "18446744073709551615"),
            ("DECIMAL", "1234567890.123456789"),
            ("TIME", "-838:59:59.999999"),
        ] {
            assert_eq!(
                cell_from_bytes(kind, value.as_bytes(), 100).unwrap(),
                QueryCell::Text {
                    value: value.into(),
                    truncated: false
                }
            );
        }
        assert_eq!(
            cell_from_bytes("TEXT", "你好".as_bytes(), 5).unwrap(),
            QueryCell::Text {
                value: "你".into(),
                truncated: true
            }
        );
        assert_eq!(
            cell_from_bytes("BLOB", &[0, 255], 10).unwrap(),
            QueryCell::Binary { byte_length: 2 }
        );
        assert_eq!(
            cell_from_bytes("BOOLEAN", b"2", 10).unwrap(),
            QueryCell::Number { value: 2.0 }
        );
    }
}
