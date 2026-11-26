use crate::MySqlAdapterError;
use schema_model::{
    ConstraintDefinition, ConstraintType, ObjectDependency, ObjectKey, ObjectKind,
    ProgramDefinition, SchemaDefinition,
};
use sqlx::{MySqlConnection, Row};
use std::{collections::BTreeMap, fmt::Write};

pub async fn load(
    connection: &mut MySqlConnection,
    schema: &mut SchemaDefinition,
) -> Result<(), MySqlAdapterError> {
    load_routines(connection, schema).await?;
    load_triggers(connection, schema).await?;
    load_events(connection, schema).await?;
    load_dependencies(connection, schema).await?;
    load_constraints(connection, schema).await?;
    Ok(())
}

async fn load_events(
    connection: &mut MySqlConnection,
    schema: &mut SchemaDefinition,
) -> Result<(), MySqlAdapterError> {
    let rows = sqlx::query(
        "SELECT EVENT_NAME AS name, EVENT_DEFINITION AS definition, DEFINER AS owner, STATUS AS status, \
         CAST(EXECUTE_AT AS CHAR) AS execute_at, INTERVAL_VALUE AS interval_value, INTERVAL_FIELD AS interval_field, \
         CAST(STARTS AS CHAR) AS starts, CAST(ENDS AS CHAR) AS ends, TIME_ZONE AS time_zone, ON_COMPLETION AS completion \
         FROM information_schema.EVENTS WHERE EVENT_SCHEMA=DATABASE()",
    )
    .fetch_all(&mut *connection)
    .await?;
    for row in rows {
        let mut schedule = if let Some(at) = row.try_get::<Option<String>, _>("execute_at")? {
            format!("-- Schedule: AT {at}")
        } else {
            let value: Option<String> = row.try_get("interval_value")?;
            let unit: Option<String> = row.try_get("interval_field")?;
            format!(
                "-- Schedule: EVERY {} {}",
                value.unwrap_or_default(),
                unit.unwrap_or_default()
            )
        };
        for (field, label) in [("starts", "STARTS"), ("ends", "ENDS")] {
            if let Some(value) = row.try_get::<Option<String>, _>(field)? {
                let _ = write!(schedule, " {label} {value}");
            }
        }
        let zone: String = row.try_get("time_zone")?;
        let completion: String = row.try_get("completion")?;
        let body: Option<String> = row.try_get("definition")?;
        let mut definition =
            format!("{schedule}\n-- Time zone: {zone} · On completion: {completion}");
        if let Some(body) = body {
            definition.push_str("\n\n");
            definition.push_str(&body);
        }
        schema.programs.push(ProgramDefinition {
            key: ObjectKey::new(
                ObjectKind::Event,
                &schema.name,
                row.try_get::<String, _>("name")?,
            ),
            definition: Some(definition),
            arguments: String::new(),
            language: "SQL".into(),
            result_type: None,
            owner: row.try_get("owner")?,
            table: None,
            enabled: row.try_get("status")?,
        });
    }
    Ok(())
}

async fn load_routines(
    connection: &mut MySqlConnection,
    schema: &mut SchemaDefinition,
) -> Result<(), MySqlAdapterError> {
    let rows = sqlx::query("SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS kind, ROUTINE_DEFINITION AS definition, DTD_IDENTIFIER AS result_type, DEFINER AS owner FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=DATABASE()")
        .fetch_all(&mut *connection).await?;
    let params = sqlx::query("SELECT SPECIFIC_NAME AS routine_name, ROUTINE_TYPE AS kind, PARAMETER_MODE AS mode, PARAMETER_NAME AS name, DTD_IDENTIFIER AS data_type FROM information_schema.PARAMETERS WHERE SPECIFIC_SCHEMA=DATABASE() AND ORDINAL_POSITION>0 ORDER BY SPECIFIC_NAME,ROUTINE_TYPE,ORDINAL_POSITION").fetch_all(&mut *connection).await?;
    let mut parameters: std::collections::BTreeMap<(String, String), Vec<String>> =
        std::collections::BTreeMap::new();
    for p in params {
        parameters
            .entry((p.try_get("routine_name")?, p.try_get("kind")?))
            .or_default()
            .push(format!(
                "{} {} {}",
                p.try_get::<String, _>("mode")?,
                p.try_get::<String, _>("name")?,
                p.try_get::<String, _>("data_type")?
            ));
    }
    for row in rows {
        let name: String = row.try_get("name")?;
        let kind: String = row.try_get("kind")?;
        let arguments = parameters
            .get(&(name, kind))
            .map(|p| p.join(", "))
            .unwrap_or_default();
        schema.programs.push(ProgramDefinition {
            key: ObjectKey::new(
                if row.try_get::<String, _>("kind")? == "PROCEDURE" {
                    ObjectKind::Procedure
                } else {
                    ObjectKind::Function
                },
                &schema.name,
                row.try_get::<String, _>("name")?,
            ),
            definition: row.try_get("definition")?,
            arguments,
            language: "SQL".into(),
            result_type: row.try_get("result_type")?,
            owner: row.try_get("owner")?,
            table: None,
            enabled: None,
        });
    }
    Ok(())
}

async fn load_triggers(
    connection: &mut MySqlConnection,
    schema: &mut SchemaDefinition,
) -> Result<(), MySqlAdapterError> {
    let rows = sqlx::query("SELECT TRIGGER_NAME AS name, EVENT_OBJECT_TABLE AS table_name, ACTION_TIMING AS timing, EVENT_MANIPULATION AS event_name, ACTION_STATEMENT AS definition, DEFINER AS owner FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE()")
        .fetch_all(&mut *connection).await?;
    for row in rows {
        let key = ObjectKey::new(
            ObjectKind::Trigger,
            &schema.name,
            row.try_get::<String, _>("name")?,
        );
        let table = ObjectKey::table(&schema.name, row.try_get::<String, _>("table_name")?);
        schema.dependencies.push(ObjectDependency {
            source: key.clone(),
            target: table.clone(),
        });
        schema.programs.push(ProgramDefinition {
            key,
            definition: Some(format!(
                "{} {}\n{}",
                row.try_get::<String, _>("timing")?,
                row.try_get::<String, _>("event_name")?,
                row.try_get::<String, _>("definition")?
            )),
            arguments: String::new(),
            language: "SQL".into(),
            result_type: None,
            owner: row.try_get("owner")?,
            table: Some(table),
            enabled: Some("enabled".into()),
        });
    }
    Ok(())
}

async fn load_dependencies(
    connection: &mut MySqlConnection,
    schema: &mut SchemaDefinition,
) -> Result<(), MySqlAdapterError> {
    // These catalogs were added in MySQL 8. Older servers still expose
    // routines/triggers; absence is not an error for the entire snapshot.
    let has_views: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM information_schema.tables WHERE TABLE_SCHEMA='information_schema' AND TABLE_NAME='VIEW_TABLE_USAGE'").fetch_one(&mut *connection).await?;
    if has_views > 0 {
        let rows = sqlx::query("SELECT VIEW_NAME AS name, TABLE_SCHEMA AS target_schema, TABLE_NAME AS target_name FROM information_schema.VIEW_TABLE_USAGE WHERE VIEW_SCHEMA=DATABASE()")
        .fetch_all(&mut *connection).await?;
        for row in rows {
            let target_schema: String = row.try_get("target_schema")?;
            let target_name: String = row.try_get("target_name")?;
            let is_view = target_schema == schema.name
                && schema.views.iter().any(|v| v.key.name == target_name);
            schema.dependencies.push(ObjectDependency {
                source: ObjectKey::new(
                    ObjectKind::View,
                    &schema.name,
                    row.try_get::<String, _>("name")?,
                ),
                target: ObjectKey::new(
                    if is_view {
                        ObjectKind::View
                    } else {
                        ObjectKind::Table
                    },
                    target_schema,
                    target_name,
                ),
            });
        }
    }
    Ok(())
}

async fn load_constraints(
    connection: &mut MySqlConnection,
    schema: &mut SchemaDefinition,
) -> Result<(), MySqlAdapterError> {
    for (table_name, name, definition) in read_checks(connection, &schema.name).await? {
        if let Ok(table) = crate::table_mut(schema, &table_name) {
            table.constraints.push(ConstraintDefinition {
                name,
                constraint_type: ConstraintType::Check,
                definition,
            });
        }
    }
    for table in &mut schema.tables {
        for index in table.indexes.iter().filter(|i| i.unique && !i.primary) {
            table.constraints.push(ConstraintDefinition {
                name: index.name.clone(),
                constraint_type: ConstraintType::Unique,
                definition: index
                    .definition
                    .clone()
                    .unwrap_or_else(|| format!("UNIQUE ({})", index.columns.join(", "))),
            });
        }
    }
    Ok(())
}

async fn read_checks(
    connection: &mut MySqlConnection,
    database: &str,
) -> Result<Vec<(String, String, String)>, MySqlAdapterError> {
    let columns: Vec<String> = sqlx::query_scalar(
        "SELECT COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = 'information_schema' AND TABLE_NAME = 'CHECK_CONSTRAINTS'",
    )
    .fetch_all(&mut *connection)
    .await?;
    if columns.is_empty() {
        return Ok(Vec::new());
    }
    if columns
        .iter()
        .any(|column| column.eq_ignore_ascii_case("TABLE_NAME"))
    {
        // MariaDB includes the owning table and can reuse a check name on another table.
        return Ok(sqlx::query_as(
            "SELECT TABLE_NAME, CONSTRAINT_NAME, CHECK_CLAUSE
             FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = ?",
        )
        .bind(database)
        .fetch_all(&mut *connection)
        .await?);
    }
    // MySQL check names are unique within a schema, but their owning tables
    // live in a separate catalog. Read both without a server-side nested loop.
    let definitions: Vec<(String, String)> = sqlx::query_as(
        "SELECT CONSTRAINT_NAME, CHECK_CLAUSE
         FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = ?",
    )
    .bind(database)
    .fetch_all(&mut *connection)
    .await?;
    if definitions.is_empty() {
        return Ok(Vec::new());
    }
    let mut definitions: BTreeMap<_, _> = definitions.into_iter().collect();
    let owners: Vec<(String, String)> = sqlx::query_as(
        "SELECT TABLE_NAME, CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS
         WHERE CONSTRAINT_SCHEMA = ? AND TABLE_SCHEMA = ? AND CONSTRAINT_TYPE = 'CHECK'",
    )
    .bind(database)
    .bind(database)
    .fetch_all(&mut *connection)
    .await?;
    Ok(owners
        .into_iter()
        .filter_map(|(table, name)| {
            let definition = definitions.remove(&name)?;
            Some((table, name, definition))
        })
        .collect())
}
