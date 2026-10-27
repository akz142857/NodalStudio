//! Explicit isolated acceptance helper. Reads only metadata from disposable loopback catalogs.
use chrono::Utc;
use schema_model::{ConnectionSecurity, DataSourceProfile, DatabaseType, ObjectKey, SslMode};
use semantic_model::ObjectAnnotation;
use snapshot_store::{
    LocalSnapshotStore,
    change_review::{ReviewRequest, ReviewWorkspace},
};
use uuid::Uuid;

fn request(w: &ReviewWorkspace, action: &str, key: Option<String>, text: &str) -> ReviewRequest {
    ReviewRequest {
        source_id: w.source_id,
        revision: w.revision.clone(),
        prepared_at: Utc::now().to_rfc3339(),
        operation_id: Uuid::new_v4(),
        action: action.into(),
        item_key: key,
        item_keys: vec![],
        text: Some(text.into()),
    }
}
#[tokio::main]
#[allow(clippy::too_many_lines)]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    if std::env::var("NODAL_REVIEW_ACCEPTANCE").as_deref() != Ok("1") {
        return Err("Explicit acceptance opt-in required".into());
    }
    let args: Vec<_> = std::env::args().collect();
    let path = args.get(1).ok_or("Pass isolated store path")?;
    if !path.contains("change-review") {
        return Err("Refusing non-acceptance store path".into());
    }
    if let Some(parent) = std::path::Path::new(path).parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mode = args.get(2).map_or("init", String::as_str);
    let store = LocalSnapshotStore::open_path(path).await?;
    for (engine, port_env, source_id) in [
        (
            DatabaseType::PostgreSql,
            "NODAL_REVIEW_PG_PORT",
            "94cf1fa6-d075-4e5c-9bd8-567064ab3101",
        ),
        (
            DatabaseType::MySql,
            "NODAL_REVIEW_MYSQL_PORT",
            "94cf1fa6-d075-4e5c-9bd8-567064ab3102",
        ),
    ] {
        if mode == "settings" {
            continue;
        }
        let port: u16 = std::env::var(port_env)?.parse()?;
        let source = Uuid::parse_str(source_id)?;
        let snapshot = if engine == DatabaseType::PostgreSql {
            let pool = sqlx::postgres::PgPoolOptions::new().after_connect(|c, _| Box::pin(async move { sqlx::query("SET default_transaction_read_only = on").execute(c).await?; Ok(()) }))
                .connect(&format!("postgres://nodalstudio:acceptance-fixture-only@127.0.0.1:{port}/nodalstudio_test")).await?;
            let snapshot = postgres_adapter::inspect_schema(&pool, source).await?;
            pool.close().await;
            snapshot
        } else {
            let pool = sqlx::mysql::MySqlPoolOptions::new()
                .after_connect(|c, _| {
                    Box::pin(async move {
                        sqlx::query("SET SESSION TRANSACTION READ ONLY")
                            .execute(c)
                            .await?;
                        Ok(())
                    })
                })
                .connect(&format!(
                    "mysql://nodalstudio:acceptance-fixture-only@127.0.0.1:{port}/nodalstudio_test"
                ))
                .await?;
            let snapshot = mysql_adapter::inspect_schema(&pool, source).await?;
            pool.close().await;
            snapshot
        };
        if mode == "init" {
            let profile = DataSourceProfile {
                id: source,
                display_name: format!("P0 Review {engine:?}"),
                database_type: engine,
                host: "127.0.0.1".into(),
                port,
                database: "nodalstudio_test".into(),
                username: "nodalstudio".into(),
                ssl_mode: SslMode::Disable,
                security: ConnectionSecurity::default(),
                created_at: Utc::now(),
                updated_at: Utc::now(),
            };
            store.save_verified_source(&profile, &snapshot).await?;
            let mut settings = settings_model::DataSourceSettings::defaults_for(source);
            settings.refresh.interval_seconds = 0;
            settings.legacy_storage_migration_version = 3;
            store.save_data_source_settings(&settings).await?;
            keyring::Entry::new("com.claycosmos.nodalstudio.datasource", source_id)?
                .set_password("acceptance-fixture-only")?;
            let table = snapshot
                .schemas
                .iter()
                .flat_map(|s| &s.tables)
                .find(|t| t.key.name == "orders")
                .ok_or("fixture orders missing")?;
            store
                .save_annotation(&ObjectAnnotation {
                    source_id: source,
                    object_key: table.key.clone(),
                    description: Some("每笔订单必须关联客户；金额字段用于记录订单总额。".into()),
                    tags: vec!["acceptance".into()],
                    owner: Some("P0 fixture".into()),
                    is_core: true,
                    updated_at: Utc::now(),
                })
                .await?;
            let w = store.change_review(source).await?;
            if w.initialized {
                return Err(
                    "Fixture already initialized; use capture or a fresh isolated store".into(),
                );
            }
            let w = store
                .apply_change_review(&request(&w, "start", None, ""))
                .await?;
            let note = w
                .items
                .iter()
                .find(|i| i.kind == "annotation")
                .ok_or("missing initial statement")?;
            let w = store
                .apply_change_review(&request(
                    &w,
                    "confirm",
                    Some(note.key.clone()),
                    "每笔订单必须关联客户；金额字段用于记录订单总额。",
                ))
                .await?;
            let w = store
                .apply_change_review(&request(&w, "complete", None, ""))
                .await?;
            assert!(w.completed);
        } else {
            store.save_captured_snapshot(&snapshot).await?;
        }
        let mut w = store.change_review(source).await?;
        if mode == "exercise" {
            assert!(
                !w.completed,
                "external fixture change must produce a new round"
            );
            let old_baseline = w.baseline;
            let note = w
                .items
                .iter()
                .find(|i| i.kind == "annotation")
                .ok_or("statement must require review")?;
            w = store
                .apply_change_review(&request(
                    &w,
                    "defer",
                    Some(note.key.clone()),
                    "检查新字段含义",
                ))
                .await?;
            assert!(
                store
                    .apply_change_review(&request(&w, "complete", None, ""))
                    .await
                    .is_err()
            );
            let reopened = LocalSnapshotStore::open_path(path).await?;
            w = reopened.change_review(source).await?;
            assert_eq!(w.baseline, old_baseline);
            assert!(w.items.iter().any(|i| i.status == "deferred"));
            let note = w.items.iter().find(|i| i.kind == "annotation").unwrap();
            w = store
                .apply_change_review(&request(
                    &w,
                    "confirm",
                    Some(note.key.clone()),
                    "订单结构已复核；新备注字段不会改变客户关联。",
                ))
                .await?;
            while let Some(i) = w.items.iter().find(|i| i.status != "resolved") {
                if !i.actions.contains(&"seen".to_owned()) {
                    return Err("unexpected blocking impact".into());
                }
                w = store
                    .apply_change_review(&request(&w, "seen", Some(i.key.clone()), ""))
                    .await?;
            }
            w = store
                .apply_change_review(&request(&w, "complete", None, ""))
                .await?;
            assert!(w.completed);
            assert_eq!(w.baseline, Some(snapshot.id));
            let note = store
                .list_annotations(source)
                .await?
                .into_iter()
                .find(|a| {
                    a.object_key
                        == ObjectKey::table(
                            if engine == DatabaseType::PostgreSql {
                                "app"
                            } else {
                                "nodalstudio_test"
                            },
                            "orders",
                        )
                })
                .ok_or("annotation disappeared")?;
            assert_eq!(note.tags, vec!["acceptance"]);
        }
        println!(
            "{}",
            serde_json::to_string(
                &serde_json::json!({"engine":engine,"sourceId":source,"target":w.target,"baseline":w.baseline,"completed":w.completed,"pending":w.items.iter().filter(|i| i.status != "resolved").count(),"events":w.events.len()})
            )?
        );
    }
    if mode == "init" || mode == "settings" {
        let mut app = settings_model::AppSettings::default();
        app.general.language = serde_json::from_value(serde_json::json!("zhCn"))?;
        app.general.theme = serde_json::from_value(serde_json::json!("light"))?;
        app.general.last_source_id = Some(Uuid::parse_str("94cf1fa6-d075-4e5c-9bd8-567064ab3101")?);
        app.general.ui_scale_percent = 125;
        app.updates.automatic_checks = false;
        app.legacy_storage_migration_version = 3;
        store.save_app_settings(&app).await?;
    }
    Ok(())
}
