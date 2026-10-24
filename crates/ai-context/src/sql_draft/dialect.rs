use schema_model::DatabaseType;
use sqlparser::{
    ast::{CastKind, DataType, DateTimeField, Interval, TimezoneInfo},
    dialect::MySqlDialect,
    tokenizer::{Token, Tokenizer, Whitespace},
};

pub(super) fn prompt_rules(dialect: DatabaseType) -> (&'static str, &'static str) {
    match dialect {
        DatabaseType::PostgreSql => (
            "PostgreSQL",
            "Use PostgreSQL double quotes for identifiers where needed. Functions: count,sum,avg,min,max,coalesce,nullif,round,abs,lower,upper,length,date_trunc,date_part,now,current_date,current_timestamp only (unqualified or pg_catalog-qualified). Standard date/timestamp casts and INTERVAL literals are supported.",
        ),
        DatabaseType::MySql => (
            "MySQL",
            "Use MySQL backticks for database, table and column identifiers (escape an embedded backtick by doubling it), and single quotes for string literals. Use plain, case-consistent aliases. Use the exact database/table spelling from evidence, never PostgreSQL public or pg_catalog unless that is an actual permitted database. Functions: count,sum,avg,min,max,coalesce,nullif,round,abs,lower,upper,length,char_length,concat,ifnull,date,date_format,date_add,date_sub,datediff,year,month,day,dayofmonth,now,curdate,current_date,current_timestamp,utc_timestamp only, unqualified and unquoted. For monthly grouping use DATE_FORMAT(column, '%Y-%m'); for relative dates use DATE_SUB/CURDATE or INTERVAL 1 MONTH, after clarifying dates/timezone. Casts: CAST AS DATE, DATETIME, TIME, CHAR, DECIMAL, SIGNED or UNSIGNED. LIMIT count OFFSET offset and LIMIT offset,count are supported with both values <=5000. No PostgreSQL date_trunc/date_part, :: casts, ILIKE, aggregate FILTER, NULLS FIRST/LAST, double-quoted identifiers or ||. Never emit executable/version comments, optimizer hints, user variables, session settings, file functions or lock functions. Only the SQL draft is produced; the user must review it and choose Run separately.",
        ),
    }
}

pub(super) fn validate_mysql_tokens(sql: &str) -> Result<(), String> {
    let tokens = Tokenizer::new(&MySqlDialect {}, sql)
        .tokenize()
        .map_err(|_| "The generated MySQL SQL could not be parsed.")?;
    for token in tokens {
        let forbidden = match token {
            Token::Whitespace(Whitespace::MultiLineComment(comment)) => {
                comment.starts_with(['!', '+'])
                    || comment.to_ascii_uppercase().starts_with("M!")
                    || comment.contains("/*")
            }
            Token::Assignment | Token::StringConcat | Token::DoubleQuotedString(_) => true,
            Token::Word(word) => {
                word.quote_style == Some('"')
                    || (word.quote_style.is_none() && word.value.eq_ignore_ascii_case("INTO"))
            }
            _ => false,
        };
        if forbidden {
            return Err("MySQL drafts require standard quoting and cannot contain executable comments, hints, assignments, INTO or mode-dependent operators.".into());
        }
    }
    Ok(())
}

pub(super) fn function_supported(dialect: DatabaseType, name: &str) -> bool {
    [
        "count",
        "sum",
        "avg",
        "min",
        "max",
        "coalesce",
        "nullif",
        "round",
        "abs",
        "lower",
        "upper",
        "length",
        "now",
        "current_date",
        "current_timestamp",
    ]
    .contains(&name)
        || match dialect {
            DatabaseType::PostgreSql => ["date_trunc", "date_part"].contains(&name),
            DatabaseType::MySql => [
                "char_length",
                "concat",
                "ifnull",
                "date",
                "date_format",
                "date_add",
                "date_sub",
                "datediff",
                "year",
                "month",
                "day",
                "dayofmonth",
                "curdate",
                "utc_timestamp",
            ]
            .contains(&name),
        }
}

pub(super) fn cast_supported(dialect: DatabaseType, kind: &CastKind, data_type: &DataType) -> bool {
    match dialect {
        DatabaseType::PostgreSql => {
            matches!(kind, CastKind::Cast | CastKind::DoubleColon)
                && [
                    "DATE",
                    "TIMESTAMP",
                    "TIMESTAMP WITH TIME ZONE",
                    "TIMESTAMPTZ",
                    "TEXT",
                    "INTEGER",
                    "BIGINT",
                    "NUMERIC",
                    "DECIMAL",
                    "DOUBLE PRECISION",
                    "BOOLEAN",
                ]
                .contains(&data_type.to_string().as_str())
        }
        DatabaseType::MySql => {
            *kind == CastKind::Cast
                && match data_type {
                    DataType::Date
                    | DataType::Char(_)
                    | DataType::Decimal(_)
                    | DataType::Signed
                    | DataType::SignedInteger
                    | DataType::Unsigned
                    | DataType::UnsignedInteger => true,
                    DataType::Datetime(precision)
                    | DataType::Time(precision, TimezoneInfo::None) => {
                        precision.is_none_or(|p| p <= 6)
                    }
                    _ => false,
                }
        }
    }
}

pub(super) fn interval_supported(dialect: DatabaseType, interval: &Interval) -> bool {
    dialect == DatabaseType::PostgreSql
        || (interval.leading_precision.is_none()
            && interval.last_field.is_none()
            && interval.fractional_seconds_precision.is_none()
            && matches!(
                interval.leading_field,
                Some(
                    DateTimeField::Year
                        | DateTimeField::Quarter
                        | DateTimeField::Month
                        | DateTimeField::Week(None)
                        | DateTimeField::Day
                        | DateTimeField::Hour
                        | DateTimeField::Minute
                        | DateTimeField::Second
                        | DateTimeField::Microsecond
                )
            ))
}
