use crate::MySqlAdapterError;
use schema_model::{
    ConstraintDefinition, ConstraintType, ObjectDependency, ObjectKey, ObjectKind,
    ProgramDefinition, SchemaDefinition,
};
use sqlx::{MySqlPool, Row};

pub async fn load(
    pool: &MySqlPool,
    schema: &mut SchemaDefinition,
) -> Result<(), MySqlAdapterError> {
    load_routines(pool, schema).await?;
    load_triggers(pool, schema).await?;
    load_dependencies(pool, schema).await?;
    load_constraints(pool, schema).await?;
    Ok(())
}

async fn load_routines(
    pool: &MySqlPool,
    schema: &mut SchemaDefinition,
) -> Result<(), MySqlAdapterError> {
    let rows = sqlx::query("SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS kind, ROUTINE_DEFINITION AS definition, DTD_IDENTIFIER AS result_type, DEFINER AS owner FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=DATABASE()")
        .fetch_all(pool).await?;
    let params = sqlx::query("SELECT SPECIFIC_NAME AS routine_name, ROUTINE_TYPE AS kind, PARAMETER_MODE AS mode, PARAMETER_NAME AS name, DTD_IDENTIFIER AS data_type FROM information_schema.PARAMETERS WHERE SPECIFIC_SCHEMA=DATABASE() AND ORDINAL_POSITION>0 ORDER BY SPECIFIC_NAME,ROUTINE_TYPE,ORDINAL_POSITION").fetch_all(pool).await?;
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
    pool: &MySqlPool,
    schema: &mut SchemaDefinition,
) -> Result<(), MySqlAdapterError> {
    let rows = sqlx::query("SELECT TRIGGER_NAME AS name, EVENT_OBJECT_TABLE AS table_name, ACTION_TIMING AS timing, EVENT_MANIPULATION AS event_name, ACTION_STATEMENT AS definition, DEFINER AS owner FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE()")
        .fetch_all(pool).await?;
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
    pool: &MySqlPool,
    schema: &mut SchemaDefinition,
) -> Result<(), MySqlAdapterError> {
    // These catalogs were added in MySQL 8. Older servers still expose
    // routines/triggers; absence is not an error for the entire snapshot.
    let has_views: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM information_schema.tables WHERE TABLE_SCHEMA='information_schema' AND TABLE_NAME='VIEW_TABLE_USAGE'").fetch_one(pool).await?;
    if has_views > 0 {
        let rows = sqlx::query("SELECT VIEW_NAME AS name, TABLE_SCHEMA AS target_schema, TABLE_NAME AS target_name FROM information_schema.VIEW_TABLE_USAGE WHERE VIEW_SCHEMA=DATABASE()")
        .fetch_all(pool).await?;
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
    pool: &MySqlPool,
    schema: &mut SchemaDefinition,
) -> Result<(), MySqlAdapterError> {
    let has_checks: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM information_schema.tables WHERE TABLE_SCHEMA='information_schema' AND TABLE_NAME='CHECK_CONSTRAINTS'").fetch_one(pool).await?;
    if has_checks > 0 {
        let rows = sqlx::query("SELECT tc.TABLE_NAME AS table_name, tc.CONSTRAINT_NAME AS name, cc.CHECK_CLAUSE AS definition FROM information_schema.TABLE_CONSTRAINTS tc JOIN information_schema.CHECK_CONSTRAINTS cc ON cc.CONSTRAINT_SCHEMA=tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME=tc.CONSTRAINT_NAME WHERE tc.CONSTRAINT_SCHEMA=DATABASE() AND tc.CONSTRAINT_TYPE='CHECK'")
        .fetch_all(pool).await?;
        for row in rows {
            let table: String = row.try_get("table_name")?;
            if let Some(table) = schema.tables.iter_mut().find(|t| t.key.name == table) {
                table.constraints.push(ConstraintDefinition {
                    name: row.try_get("name")?,
                    constraint_type: ConstraintType::Check,
                    definition: row.try_get("definition")?,
                });
            }
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
