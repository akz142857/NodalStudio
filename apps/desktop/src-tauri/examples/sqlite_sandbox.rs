//! Native sandbox acceptance using production file grants, adapter and query engine.
#![allow(dead_code)]
#![cfg(not(test))]
#[path = "../src/file_access.rs"]
mod file_access;
mod purchase {
    pub const IS_MAS: bool = true;
}
use sqlx::{Connection, Executor};
use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use tauri::Manager;
use tokio_util::sync::CancellationToken;

#[tauri::command]
async fn choose_sqlite_fixture(app: tauri::AppHandle) -> Result<String, String> {
    let path =
        file_access::pick_workspace_path(app.clone(), file_access::SelectionKind::SqliteDirectory)
            .await?
            .ok_or("Cancelled")?;
    let _grant = file_access::access(Path::new(&path))?;
    if !Path::new(&path).join("NODAL_SQLITE_FIXTURE").is_file() {
        return Err("Choose the disposable SQLite fixture folder.".into());
    }
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&data).map_err(|e| e.to_string())?;
    std::fs::write(data.join("fixture-path"), path).map_err(|e| e.to_string())?;
    Ok("Permission saved. Run now, then quit and reopen to test persistence.".into())
}
#[tauri::command]
async fn run_sqlite_fixture(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let root = PathBuf::from(
        std::fs::read_to_string(data.join("fixture-path"))
            .map_err(|_| "Choose a fixture folder first.")?,
    );
    let _grant = file_access::access(&root)?;
    let path = root.join("fixture.sqlite");
    let before = std::fs::read(&path).map_err(|e| e.to_string())?;
    let mut conn = sqlite_adapter::connect(&path)
        .await
        .map_err(|e| e.to_string())?;
    sqlite_adapter::set_deadline(
        &mut conn,
        CancellationToken::new(),
        Instant::now() + Duration::from_secs(5),
    )
    .await
    .map_err(|e| e.to_string())?;
    let snapshot =
        sqlite_adapter::inspect_schema(&mut conn, uuid::Uuid::new_v4(), "fixture.sqlite")
            .await
            .map_err(|e| e.to_string())?;
    let request = query_engine::ExecuteQueryRequest {
        query_id: uuid::Uuid::new_v4(),
        sql: "SELECT value FROM fixture".into(),
        row_limit: 100,
        timeout_ms: 1000,
        max_cell_bytes: 1024,
        max_result_bytes: 1024 * 1024,
    };
    let rows = query_engine::execute_sqlite_query(&mut conn, &request, &CancellationToken::new())
        .await
        .map_err(|e| e.to_string())?;
    let denied = conn
        .execute("INSERT INTO fixture VALUES ('must not write')")
        .await
        .is_err();
    let token = CancellationToken::new();
    let signal = token.clone();
    let cancellation = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(50)).await;
        signal.cancel();
    });
    let started = Instant::now();
    let long=query_engine::ExecuteQueryRequest { sql:"WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT sum(x) FROM n".into(),..request};
    let cancelled = matches!(
        query_engine::execute_sqlite_query(&mut conn, &long, &token).await,
        Err(query_engine::QueryError::Cancelled)
    );
    cancellation.await.map_err(|e| e.to_string())?;
    conn.close().await.map_err(|e| e.to_string())?;
    let report = serde_json::json!({"sqliteVersion":snapshot.database.version,"tables":snapshot.schemas[0].tables.len(),"rows":rows.rows,"writeDenied":denied,"engineCancelled":cancelled,"cancelMs":started.elapsed().as_millis(),"mainFilePreserved":before==std::fs::read(&path).map_err(|e|e.to_string())?,"walPresent":root.join("fixture.sqlite-wal").exists()});
    std::fs::write(
        root.join("sqlite-acceptance.json"),
        serde_json::to_vec_pretty(&report).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(report)
}
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            choose_sqlite_fixture,
            run_sqlite_fixture
        ])
        .run(tauri::generate_context!(
            "examples/sqlite-ui/tauri.conf.json"
        ))
        .expect("SQLite sandbox fixture");
}
