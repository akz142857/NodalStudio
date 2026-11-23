use std::fmt::Write;

use chrono::{DateTime, FixedOffset, Utc};
use schema_model::{ColumnDefinition, DatabaseInfo, DatabaseType, ObjectKey};

use super::{PaidOrdersDefinition, PaymentTimeStorage};

pub(super) fn validate_engine(database: &DatabaseInfo) -> Result<(), &'static str> {
    if database.database_type == DatabaseType::MySql
        && !database.version.to_ascii_lowercase().contains("mariadb")
        && database
            .version
            .split('.')
            .next()
            .and_then(|major| major.parse::<u16>().ok())
            .is_some_and(|major| major < 8)
    {
        return Err("Ontology requires MySQL 8.0 or later.");
    }
    Ok(())
}

pub(super) fn validate_key(
    engine: DatabaseType,
    order: &ColumnDefinition,
    payment: &ColumnDefinition,
) -> Result<(), &'static str> {
    let key_type = |column: &ColumnDefinition| match engine {
        DatabaseType::PostgreSql if column.type_schema == "pg_catalog" => {
            match column.type_name.as_str() {
                "int2" => Some("int2"),
                "int4" => Some("int4"),
                "int8" => Some("int8"),
                "uuid" => Some("uuid"),
                "text" => Some("text"),
                "varchar" => Some("varchar"),
                _ => None,
            }
        }
        DatabaseType::MySql => match column.type_name.as_str() {
            "tinyint" | "smallint" | "mediumint" | "int" | "bigint" => Some("integer"),
            "char" | "varchar" => Some("text"),
            _ => None,
        },
        DatabaseType::Sqlite => match column.type_name.as_str() {
            "INTEGER" => Some("integer"),
            "TEXT" => Some("text"),
            _ => None,
        },
        DatabaseType::PostgreSql => None,
    };
    let order_type = key_type(order);
    if order_type.is_some() && order_type == key_type(payment) {
        Ok(())
    } else {
        Err(match engine {
            DatabaseType::PostgreSql => {
                "Use matching PostgreSQL integer, UUID, or text types for the order ID and payment order ID."
            }
            _ => "Use compatible integer or text columns for the order ID and payment order ID.",
        })
    }
}

pub(super) fn validate_status(
    engine: DatabaseType,
    column: &ColumnDefinition,
) -> Result<(), &'static str> {
    let supported = match engine {
        DatabaseType::PostgreSql => {
            column.type_schema == "pg_catalog"
                && matches!(column.type_name.as_str(), "text" | "varchar" | "bpchar")
        }
        DatabaseType::MySql => matches!(
            column.type_name.as_str(),
            "char" | "varchar" | "tinytext" | "text" | "mediumtext" | "longtext" | "enum"
        ),
        DatabaseType::Sqlite => column.type_name == "TEXT",
    };
    supported
        .then_some(())
        .ok_or("Map payment status to a text or character column.")
}

#[derive(Clone, Copy)]
pub(super) enum PaymentTime {
    PostgresInstant,
    MySqlInstant,
    MySqlLocal(i32),
    SqliteIso,
    SqliteEpoch { units_per_second: i64 },
}

impl PaymentTime {
    pub(super) fn resolve(
        engine: DatabaseType,
        column: &ColumnDefinition,
        storage: Option<PaymentTimeStorage>,
    ) -> Result<Self, &'static str> {
        use PaymentTimeStorage::{
            Iso8601, SingaporeDateTime, UnixMilliseconds, UnixSeconds, UtcDateTime,
        };
        match (engine, column.type_name.as_str(), storage) {
            (DatabaseType::PostgreSql, "timestamptz", None)
                if column.type_schema == "pg_catalog" =>
            {
                Ok(Self::PostgresInstant)
            }
            (DatabaseType::MySql, "timestamp", None) => Ok(Self::MySqlInstant),
            (DatabaseType::MySql, "datetime", Some(UtcDateTime)) => Ok(Self::MySqlLocal(0)),
            (DatabaseType::MySql, "datetime", Some(SingaporeDateTime)) => Ok(Self::MySqlLocal(8)),
            (DatabaseType::Sqlite, _, Some(Iso8601)) if sqlite_text_time(column) => {
                Ok(Self::SqliteIso)
            }
            (DatabaseType::Sqlite, "INTEGER", Some(UnixSeconds)) => Ok(Self::SqliteEpoch {
                units_per_second: 1,
            }),
            (DatabaseType::Sqlite, "INTEGER", Some(UnixMilliseconds)) => Ok(Self::SqliteEpoch {
                units_per_second: 1000,
            }),
            (DatabaseType::PostgreSql, _, _) => {
                Err("Map payment time to a PostgreSQL timestamp with time zone.")
            }
            (DatabaseType::MySql, _, _) => {
                Err("Choose a MySQL TIMESTAMP, or a DATETIME with its storage time zone.")
            }
            (DatabaseType::Sqlite, _, _) => {
                Err("Choose ISO 8601 text or an INTEGER Unix timestamp with the correct unit.")
            }
        }
    }

    fn bound(self, instant: DateTime<FixedOffset>) -> String {
        match self {
            Self::PostgresInstant => unreachable!("PostgreSQL uses its native timestamp literals"),
            Self::MySqlInstant
            | Self::SqliteEpoch {
                units_per_second: 1,
            } => instant.timestamp().to_string(),
            Self::SqliteEpoch { .. } => instant.timestamp_millis().to_string(),
            Self::MySqlLocal(hours) => {
                let offset = FixedOffset::east_opt(hours * 3600).expect("supported storage offset");
                format!(
                    "'{}'",
                    instant.with_timezone(&offset).format("%Y-%m-%d %H:%M:%S")
                )
            }
            Self::SqliteIso => format!(
                "'{}'",
                instant
                    .with_timezone(&Utc)
                    .format("%Y-%m-%dT%H:%M:%S.000000000Z")
            ),
        }
    }

    fn normalize(self) -> &'static str {
        match self {
            Self::PostgresInstant => unreachable!("PostgreSQL uses native instants"),
            Self::MySqlInstant => "raw_time",
            Self::MySqlLocal(_) => {
                "CASE WHEN DATE_ADD(raw_time, INTERVAL 0 SECOND) IS NOT NULL THEN raw_time END"
            }
            Self::SqliteEpoch {
                units_per_second: 1,
            } => {
                "CASE WHEN typeof(raw_time) = 'integer' AND datetime(raw_time, 'unixepoch') IS NOT NULL THEN raw_time END"
            }
            Self::SqliteEpoch { .. } => {
                "CASE WHEN typeof(raw_time) = 'integer' AND datetime(raw_time / 1000.0, 'unixepoch') IS NOT NULL THEN raw_time END"
            }
            Self::SqliteIso => SQLITE_ISO_TIME,
        }
    }

    fn display(self) -> String {
        let mysql_format = "'%Y-%m-%dT%H:%i:%s.%fZ'";
        match self {
            Self::PostgresInstant => unreachable!("PostgreSQL uses native instants"),
            Self::MySqlInstant => format!(
                "DATE_FORMAT(TIMESTAMPADD(MICROSECOND, CAST(fp.first_paid_at * 1000000 AS SIGNED), '1970-01-01 00:00:00.000000'), {mysql_format})"
            ),
            Self::MySqlLocal(hours) => format!(
                "DATE_FORMAT(TIMESTAMPADD(HOUR, {}, fp.first_paid_at), {mysql_format})",
                -hours
            ),
            Self::SqliteIso => "fp.first_paid_at".into(),
            Self::SqliteEpoch {
                units_per_second: 1,
            } => "strftime('%Y-%m-%dT%H:%M:%SZ', fp.first_paid_at, 'unixepoch')".into(),
            Self::SqliteEpoch { .. } => {
                "strftime('%Y-%m-%dT%H:%M:%fZ', fp.first_paid_at / 1000.0, 'unixepoch')".into()
            }
        }
    }
}

fn sqlite_text_time(column: &ColumnDefinition) -> bool {
    let declared = column
        .formatted_type
        .split('(')
        .next()
        .unwrap_or_default()
        .trim();
    column.type_name == "TEXT"
        || ["DATE", "DATETIME", "TIMESTAMP"]
            .iter()
            .any(|name| declared.eq_ignore_ascii_case(name))
}

// Normalize the whole second separately. SQLite's date functions round long fractions,
// which could otherwise move a payment immediately before midnight to the next month.
const SQLITE_ISO_PARTS: &str = r",
time_parts AS (
    SELECT order_id, raw_time,
           substr(raw_time, 1, 19) AS wall_second,
           CASE
               WHEN substr(raw_time, -1) = 'Z' THEN 'Z'
               WHEN glob('[+-][0-9][0-9]:[0-9][0-9]', substr(raw_time, -6)) THEN substr(raw_time, -6)
               ELSE ''
           END AS zone_suffix
    FROM matched_payments
),
time_fraction AS (
    SELECT order_id, raw_time, wall_second, zone_suffix,
           substr(raw_time, 20, length(raw_time) - 19 - length(zone_suffix)) AS fraction
    FROM time_parts
)";

const SQLITE_ISO_TIME: &str = r"CASE
               WHEN typeof(raw_time) = 'text'
                AND instr(raw_time, char(0)) = 0
                AND glob('[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9][ T][0-9][0-9]:[0-9][0-9]:[0-9][0-9]', wall_second)
                AND strftime('%Y-%m-%dT%H:%M:%S', wall_second, '+0 seconds') = replace(wall_second, ' ', 'T')
                AND (fraction = '' OR (substr(fraction, 1, 1) = '.'
                     AND length(fraction) BETWEEN 2 AND 10
                     AND NOT glob('*[^0-9]*', substr(fraction, 2))))
               THEN strftime('%Y-%m-%dT%H:%M:%S', wall_second || zone_suffix)
                    || '.' || substr(substr(fraction, 2) || '000000000', 1, 9) || 'Z'
           END";

pub(super) struct SqliteKey<'a> {
    pub(super) storage: &'static str,
    pub(super) collation: &'a str,
}

impl SqliteKey<'_> {
    fn invalid_rows(&self) -> String {
        let invalid = |column| {
            let storage = self.storage;
            let wrong_type = format!("typeof({column}) <> '{storage}'");
            if storage == "text" {
                format!("({wrong_type} OR length({column}) = 0 OR instr({column}, char(0)) > 0)")
            } else {
                wrong_type
            }
        };
        let reference = invalid("order_reference");
        let key = invalid("order_id");
        format!(
            "
    UNION ALL
    SELECT 1 FROM successful_payments WHERE order_reference IS NOT NULL AND {reference}
    UNION ALL
    SELECT 1 FROM matched_payments WHERE {key}"
        )
    }
}

pub(super) fn order_sql(
    definition: &PaidOrdersDefinition,
    time: PaymentTime,
    sqlite_key: Option<&SqliteKey<'_>>,
    starts_at: DateTime<FixedOffset>,
    ends_before: DateTime<FixedOffset>,
    ids_only: bool,
) -> String {
    let order = &definition.order;
    let payment = &definition.payment;
    let mysql = sqlite_key.is_none();
    let delimiter = if mysql { '`' } else { '"' };
    let quote = |identifier: &str| {
        let doubled = format!("{delimiter}{delimiter}");
        format!(
            "{delimiter}{}{delimiter}",
            identifier.replace(delimiter, &doubled)
        )
    };
    let table = |key: &ObjectKey| format!("{}.{}", quote(&key.schema), quote(&key.name));
    let order_table = table(&order.table);
    let payment_table = table(&payment.table);
    let order_id = quote(&order.id_column);
    let payment_order_id = quote(&payment.order_id_column);
    let status = quote(&payment.status_column);
    let paid_at = quote(&payment.paid_at_column);
    // UNIX_TIMESTAMP can read the internal instant directly from a TIMESTAMP column.
    // Do this before projecting into a CTE that MySQL may materialize.
    let raw_time = if matches!(time, PaymentTime::MySqlInstant) {
        format!("CASE WHEN YEAR(p.{paid_at}) > 0 THEN UNIX_TIMESTAMP(p.{paid_at}) END")
    } else {
        format!("p.{paid_at}")
    };
    let status_match = if mysql {
        let mut literal = String::from("X'");
        for byte in payment.success_value.bytes() {
            let _ = write!(literal, "{byte:02x}");
        }
        literal.push('\'');
        format!("CAST(CONVERT(p.{status} USING utf8mb4) AS BINARY) = {literal}")
    } else {
        let escaped = payment.success_value.replace('\'', "''");
        format!("p.{status} COLLATE BINARY = '{escaped}'")
    };
    // SQLite can declare a different collation on the primary index.
    let collation = sqlite_key
        .map(|key| format!(" COLLATE {}", quote(key.collation)))
        .unwrap_or_default();
    let invalid_keys = sqlite_key.map(SqliteKey::invalid_rows).unwrap_or_default();
    let (parts, from) = if matches!(time, PaymentTime::SqliteIso) {
        (SQLITE_ISO_PARTS, "time_fraction")
    } else {
        ("", "matched_payments")
    };
    let normalized = time.normalize();
    let start = time.bound(starts_at);
    let end = time.bound(ends_before);
    let (projection, invalid) = if ids_only {
        let text_type = if mysql { "CHAR" } else { "TEXT" };
        (
            format!("CAST(fp.order_id AS {text_type}) AS order_id"),
            "NULL",
        )
    } else {
        (
            format!("fp.order_id, {} AS first_paid_at", time.display()),
            "NULL, 'A successful payment has an invalid order ID or payment time. Check the selected fields and storage format.'",
        )
    };
    format!(
        "WITH successful_payments AS (
    SELECT p.{payment_order_id} AS order_reference, {raw_time} AS raw_time
    FROM {payment_table} AS p
    WHERE {status_match} AND p.{paid_at} IS NOT NULL
),
matched_payments AS (
    SELECT o.{order_id} AS order_id, p.raw_time
    FROM {order_table} AS o
    JOIN successful_payments AS p ON o.{order_id}{collation} = p.order_reference
){parts},
normalized_payments AS (
    SELECT order_id, {normalized} AS paid_at
    FROM {from}
),
first_payments AS (
    SELECT order_id, MIN(paid_at) AS first_paid_at,
           MAX(CASE WHEN paid_at IS NULL THEN 1 ELSE 0 END) AS invalid_time
    FROM normalized_payments
    GROUP BY order_id{collation}
),
invalid_payments AS (
    SELECT 1 FROM first_payments WHERE invalid_time = 1{invalid_keys}
)
SELECT {projection}
FROM first_payments AS fp
WHERE fp.first_paid_at >= {start}
  AND fp.first_paid_at < {end}
  AND NOT EXISTS (SELECT 1 FROM invalid_payments)
UNION ALL
SELECT {invalid}
WHERE EXISTS (SELECT 1 FROM invalid_payments)
ORDER BY order_id;"
    )
}
