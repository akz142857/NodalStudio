use crate::{PostgresAdapterError, find_schema_mut};
use schema_model::{ObjectDependency, ObjectKey, ObjectKind, ProgramDefinition, SchemaDefinition};
use sqlx::{PgPool, Row};

pub async fn load(
    pool: &PgPool,
    schemas: &mut [SchemaDefinition],
) -> Result<(), PostgresAdapterError> {
    load_routines(pool, schemas).await?;
    load_triggers(pool, schemas).await?;
    load_dependencies(pool, schemas).await?;
    Ok(())
}

async fn load_routines(
    pool: &PgPool,
    schemas: &mut [SchemaDefinition],
) -> Result<(), PostgresAdapterError> {
    let rows = sqlx::query(r"SELECT n.nspname AS schema_name,
      p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS name,
      p.prokind::text AS kind, pg_get_functiondef(p.oid) AS definition,
      pg_get_function_arguments(p.oid) AS arguments, l.lanname AS language, pg_get_function_result(p.oid) AS result_type,
      pg_get_userbyid(p.proowner) AS owner
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      JOIN pg_language l ON l.oid=p.prolang
      WHERE p.prokind IN ('f','p') AND n.nspname <> 'information_schema'
      AND n.nspname NOT LIKE 'pg\_%' ESCAPE '\'").fetch_all(pool).await?;
    for row in rows {
        let schema: String = row.try_get("schema_name")?;
        find_schema_mut(schemas, &schema)?
            .programs
            .push(ProgramDefinition {
                key: ObjectKey::new(
                    if row.try_get::<String, _>("kind")? == "p" {
                        ObjectKind::Procedure
                    } else {
                        ObjectKind::Function
                    },
                    &schema,
                    row.try_get::<String, _>("name")?,
                ),
                definition: row.try_get("definition")?,
                arguments: row.try_get("arguments")?,
                language: row.try_get("language")?,
                result_type: row.try_get("result_type")?,
                owner: row.try_get("owner")?,
                table: None,
                enabled: None,
            });
    }
    Ok(())
}

async fn load_triggers(
    pool: &PgPool,
    schemas: &mut [SchemaDefinition],
) -> Result<(), PostgresAdapterError> {
    let rows = sqlx::query(
        r"SELECT n.nspname AS schema_name, c.relname AS table_name,
      quote_ident(c.relname) || '.' || quote_ident(t.tgname) AS name, c.relkind::text AS relation_kind, pg_get_triggerdef(t.oid, true) AS definition,
      t.tgenabled::text AS enabled, pg_get_userbyid(c.relowner) AS owner
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE NOT t.tgisinternal AND n.nspname <> 'information_schema'
      AND n.nspname NOT LIKE 'pg\_%' ESCAPE '\'",
    )
    .fetch_all(pool)
    .await?;
    for row in rows {
        let schema: String = row.try_get("schema_name")?;
        let table: String = row.try_get("table_name")?;
        let name: String = row.try_get("name")?;
        find_schema_mut(schemas, &schema)?
            .programs
            .push(ProgramDefinition {
                key: ObjectKey::new(ObjectKind::Trigger, &schema, name),
                definition: row.try_get("definition")?,
                arguments: String::new(),
                language: "SQL".into(),
                result_type: None,
                owner: row.try_get("owner")?,
                table: Some(ObjectKey::new(
                    if row.try_get::<String, _>("relation_kind")? == "v" {
                        ObjectKind::View
                    } else {
                        ObjectKind::Table
                    },
                    &schema,
                    table,
                )),
                enabled: row.try_get("enabled")?,
            });
    }
    Ok(())
}

async fn load_dependencies(
    pool: &PgPool,
    schemas: &mut [SchemaDefinition],
) -> Result<(), PostgresAdapterError> {
    // Only catalog-confirmed edges among supported objects. SQL bodies stored as
    // strings and dynamic SQL are not fully tracked by PostgreSQL's pg_depend.
    let rows = sqlx::query(r"WITH objects AS (
      SELECT 'pg_class'::regclass::oid AS classid,c.oid,n.nspname AS schema_name,c.relname::text AS name,
        CASE WHEN c.relkind IN ('v','m') THEN 'view' ELSE 'table' END AS kind
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p','f','v','m')
      UNION ALL SELECT 'pg_proc'::regclass::oid,p.oid,n.nspname,
        p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
        CASE WHEN p.prokind='p' THEN 'procedure' ELSE 'function' END
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.prokind IN ('f','p')
      UNION ALL SELECT 'pg_trigger'::regclass::oid,t.oid,n.nspname,quote_ident(c.relname) || '.' || quote_ident(t.tgname),'trigger'
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal
      UNION ALL SELECT 'pg_type'::regclass::oid,t.oid,n.nspname,t.typname,'enum'
      FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE t.typtype='e'
    ), edges AS (
      SELECT classid,objid,refclassid,refobjid FROM pg_depend
      UNION ALL SELECT 'pg_class'::regclass::oid,r.ev_class,d.refclassid,d.refobjid
      FROM pg_rewrite r JOIN pg_depend d ON d.classid='pg_rewrite'::regclass AND d.objid=r.oid
    ) SELECT DISTINCT s.schema_name AS ss,s.name AS sn,s.kind AS sk,t.schema_name AS ts,t.name AS tn,t.kind AS tk
      FROM edges d JOIN objects s ON s.classid=d.classid AND s.oid=d.objid
      JOIN objects t ON t.classid=d.refclassid AND t.oid=d.refobjid
      WHERE (s.classid,s.oid) <> (t.classid,t.oid)
        AND s.schema_name <> 'information_schema' AND t.schema_name <> 'information_schema'
        AND s.schema_name NOT LIKE 'pg\_%' ESCAPE '\' AND t.schema_name NOT LIKE 'pg\_%' ESCAPE '\'").fetch_all(pool).await?;
    for row in rows {
        let schema: String = row.try_get("ss")?;
        let kind = |value: String| match value.as_str() {
            "view" => ObjectKind::View,
            "function" => ObjectKind::Function,
            "procedure" => ObjectKind::Procedure,
            "trigger" => ObjectKind::Trigger,
            "enum" => ObjectKind::Enum,
            _ => ObjectKind::Table,
        };
        find_schema_mut(schemas, &schema)?
            .dependencies
            .push(ObjectDependency {
                source: ObjectKey::new(
                    kind(row.try_get("sk")?),
                    &schema,
                    row.try_get::<String, _>("sn")?,
                ),
                target: ObjectKey::new(
                    kind(row.try_get("tk")?),
                    row.try_get::<String, _>("ts")?,
                    row.try_get::<String, _>("tn")?,
                ),
            });
    }
    Ok(())
}
