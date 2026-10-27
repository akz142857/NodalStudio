//! Separate native acceptance executable; never linked into the shipping app.
#![allow(dead_code)]
#![cfg(not(test))]
#[path = "../src/connection_security.rs"]
mod connection_security;
#[path = "../src/file_access.rs"]
mod file_access;
#[path = "../src/git_readiness.rs"]
mod git_readiness;
mod purchase {
    pub const IS_MAS: bool = true;
}
use schema_model::{
    ConnectionSecurity, DatabaseInfo, DatabaseSnapshot, DatabaseType, SshAuthentication, SshConfig,
};
use std::path::{Path, PathBuf};
use tauri::Manager;

#[tauri::command]
async fn choose_fixture(app: tauri::AppHandle) -> Result<String, String> {
    let path =
        file_access::pick_workspace_path(app.clone(), file_access::SelectionKind::Repository)
            .await?
            .ok_or("Cancelled")?;
    let _scope = file_access::access(Path::new(&path))?;
    if !Path::new(&path).join("NODAL_SANDBOX_FIXTURE").is_file() {
        return Err("Choose the disposable sandbox fixture folder.".into());
    }
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("fixture-path.txt"), &path).map_err(|e| e.to_string())?;
    Ok("Fixture permission saved. Run now or after restarting.".into())
}
async fn ssh_query(
    root: &Path,
    authentication: SshAuthentication,
    trusted: bool,
) -> Result<i32, String> {
    let hosts = root.join(if trusted {
        "known_hosts"
    } else {
        "wrong_known_hosts"
    });
    let key = root.join("client");
    for path in [&hosts, &key] {
        file_access::remember(path)?;
    }
    let security = ConnectionSecurity {
        ssh: Some(SshConfig {
            host: "127.0.0.1".into(),
            port: 55482,
            username: "nodaltest".into(),
            authentication,
            private_key: Some(key.to_string_lossy().into()),
            known_hosts: Some(hosts.to_string_lossy().into()),
        }),
        ..Default::default()
    };
    let tunnel = connection_security::Tunnel::open(
        &security,
        "127.0.0.1",
        5432,
        DatabaseType::PostgreSql,
        Some("nodal-sandbox-fixture-only"),
    )
    .await?;
    let options = postgres_adapter::PostgresConnectionOptions::from_fields(
        "127.0.0.1",
        5432,
        "postgres",
        "postgres",
        "nodal-sandbox-fixture-only",
        postgres_adapter::PostgresSslMode::Disable,
    )
    .with_socket(tunnel.postgres_socket());
    let pool = postgres_adapter::connect(&options)
        .await
        .map_err(|e| e.to_string())?;
    let result = sqlx::query_scalar::<_, i32>("SELECT 42")
        .fetch_one(&pool)
        .await
        .map_err(|e| e.to_string());
    pool.close().await;
    drop(tunnel);
    result
}
#[tauri::command]
async fn run_fixture(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let root = PathBuf::from(
        std::fs::read_to_string(
            app.path()
                .app_data_dir()
                .map_err(|e| e.to_string())?
                .join("fixture-path.txt"),
        )
        .map_err(|_| "Choose fixture first")?,
    );
    let _scope = file_access::access(&root)?;

    if !root.join("NODAL_SANDBOX_FIXTURE").is_file() {
        return Err("Fixture marker missing".into());
    }
    let mut report = serde_json::json!({"tempDirectory":std::env::temp_dir(),"fixture":root});
    let snapshot = DatabaseSnapshot::new(
        uuid::Uuid::new_v4(),
        DatabaseInfo {
            name: "sandbox_fixture".into(),
            database_type: DatabaseType::PostgreSql,
            version: "17".into(),
        },
        vec![],
    );
    let rendered = git_workspace::render_workspace(&git_workspace::WorkspaceInput {
        snapshot: &snapshot,
        annotations: &[],
        domain_groups: &[],
        saved_views: &[],
        provenance: &[],
        lineage: &[],
        relationships: &[],
    })
    .map_err(|e| e.to_string())?;
    report["gitReadiness"] = serde_json::json!(git_readiness::has_git_marker(&root));
    report["gitCli"] = match std::process::Command::new("/usr/bin/git")
        .args([
            "-C",
            root.to_str().unwrap(),
            "rev-parse",
            "--is-inside-work-tree",
        ])
        .output()
    {
        Ok(output) => {
            serde_json::json!({"success":output.status.success(),"output":String::from_utf8_lossy(&output.stdout),"error":String::from_utf8_lossy(&output.stderr)})
        }
        Err(error) => serde_json::json!({"error":error.to_string()}),
    };
    let untouched = root.join("unrelated.txt");
    let before = std::fs::read(&untouched).map_err(|e| e.to_string())?;
    report["git"] = match git_workspace::write_workspace(&root, &rendered)
        .and_then(|_| git_workspace::read_workspace(&root))
    {
        Ok(w) => serde_json::json!({"roundTrip":w.manifest.database_name=="sandbox_fixture"}),
        Err(e) => serde_json::json!({"error":e.to_string()}),
    };
    report["unrelatedFilePreserved"] =
        serde_json::json!(std::fs::read(&untouched).map_err(|e| e.to_string())? == before);
    for (name, mode, trusted) in [
        ("privateKey", SshAuthentication::PrivateKey, true),
        ("wrongHostKey", SshAuthentication::PrivateKey, false),
        ("password", SshAuthentication::Password, true),
        ("agent", SshAuthentication::Agent, true),
    ] {
        report[name] = match ssh_query(&root, mode, trusted).await {
            Ok(value) => serde_json::json!({"answer":value}),
            Err(error) => serde_json::json!({"error":error}),
        };
    }
    std::fs::write(
        root.join("compatibility-result.json"),
        serde_json::to_vec_pretty(&report).unwrap(),
    )
    .map_err(|e| e.to_string())?;
    let log = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("compatibility-result.json");
    std::fs::write(log, serde_json::to_vec_pretty(&report).unwrap()).map_err(|e| e.to_string())?;
    Ok(report)
}
fn main() {
    if connection_security::run_askpass_helper() {
        return;
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![choose_fixture, run_fixture])
        .run(tauri::generate_context!("examples/tauri.conf.json"))
        .expect("sandbox fixture app");
}
