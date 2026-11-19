//! User-initiated, native-file exports. Bulk data stays in the desktop process.
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant},
};

use schema_model::{DatabaseType, ObjectKey, ObjectKind};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State, ipc::Channel};
use tauri_plugin_dialog::DialogExt;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{AppState, connection_credentials, connection_security, postgres_export, purchase};

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Format {
    Csv,
    Json,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DumpMode {
    StructureOnly,
    StructureAndData,
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Export {
    TableData {
        table: ObjectKey,
        columns: Vec<String>,
        format: Format,
        #[serde(default = "default_formula_protection")]
        protect_formulas: bool,
    },
    SqlDump {
        table: Option<ObjectKey>,
        schema: Option<String>,
        mode: DumpMode,
    },
}

const fn default_formula_protection() -> bool {
    true
}

impl Export {
    fn table(&self) -> Option<&ObjectKey> {
        match self {
            Self::TableData { table, .. } => Some(table),
            Self::SqlDump { table, .. } => table.as_ref(),
        }
    }

    fn file_stem(&self, database: &str) -> String {
        if let Self::SqlDump {
            schema: Some(schema),
            ..
        } = self
        {
            return format!("{database}-{schema}");
        }
        self.table().map_or_else(
            || database.to_owned(),
            |table| format!("{}-{}", table.schema, table.name),
        )
    }

    fn extension(&self) -> &'static str {
        match self {
            Self::TableData {
                format: Format::Csv,
                ..
            } => "csv",
            Self::TableData {
                format: Format::Json,
                ..
            } => "json",
            Self::SqlDump { .. } => "sql",
        }
    }

    fn validate(&self) -> Result<(), ExportError> {
        if let Self::SqlDump {
            schema: Some(schema),
            table,
            ..
        } = self
            && (table.is_some() || !valid_identifier(schema))
        {
            return Err(ExportError::SchemaUnavailable);
        }
        if self.table().is_some_and(|table| {
            table.kind != ObjectKind::Table
                || !valid_identifier(&table.schema)
                || !valid_identifier(&table.name)
        }) {
            return Err(ExportError::TableUnavailable);
        }
        if let Self::TableData { columns, .. } = self {
            let mut names = HashSet::new();
            if columns.is_empty()
                || columns.len() > 1600
                || columns
                    .iter()
                    .any(|name| !valid_identifier(name) || !names.insert(name))
            {
                return Err(ExportError::ColumnsUnavailable);
            }
        }
        Ok(())
    }
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty() && !value.contains('\0') && value.len() <= 1024
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Input {
    job_id: Uuid,
    source_id: Uuid,
    export: Export,
    locale: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ExportError {
    Unsupported,
    Busy,
    Cancelled,
    Connection,
    Tls,
    TableUnavailable,
    SchemaUnavailable,
    ColumnsUnavailable,
    Permission,
    PgDumpMissing,
    PgDumpVersion,
    SshDumpUnsupported,
    LockTimeout,
    ReadFailed,
    WriteFailed,
    DestinationExists,
}

#[derive(Clone, Serialize)]
#[serde(tag = "stage", rename_all = "camelCase")]
pub enum Progress {
    Exporting { bytes: u64 },
    Finalizing,
}

#[derive(Serialize)]
pub struct Receipt {
    path: String,
    bytes: u64,
}

#[derive(Default)]
struct JobRegistry {
    active: HashMap<Uuid, (Uuid, CancellationToken)>,
    exiting: bool,
}

#[derive(Default)]
pub struct Jobs {
    registry: Mutex<JobRegistry>,
    drained: tokio::sync::Notify,
}

#[derive(Debug, PartialEq, Eq)]
enum ExitAction {
    Allow,
    Wait,
    AlreadyWaiting,
}

struct RunningJob<'a> {
    jobs: &'a Jobs,
    id: Uuid,
    token: CancellationToken,
}

impl Jobs {
    fn start(&self, id: Uuid, source: Uuid) -> Result<RunningJob<'_>, ExportError> {
        let mut jobs = self.registry.lock().map_err(|_| ExportError::Busy)?;
        if jobs.exiting
            || jobs.active.contains_key(&id)
            || jobs.active.values().any(|(running, _)| *running == source)
        {
            return Err(ExportError::Busy);
        }
        let token = CancellationToken::new();
        jobs.active.insert(id, (source, token.clone()));
        Ok(RunningJob {
            jobs: self,
            id,
            token,
        })
    }

    fn cancel(&self, id: Uuid) -> bool {
        let Ok(jobs) = self.registry.lock() else {
            return false;
        };
        let Some((_, token)) = jobs.active.get(&id) else {
            return false;
        };
        token.cancel();
        true
    }

    pub fn has_active_jobs(&self) -> bool {
        !self
            .registry
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .active
            .is_empty()
    }

    fn request_exit(&self) -> ExitAction {
        let mut jobs = self
            .registry
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let already_exiting = std::mem::replace(&mut jobs.exiting, true);
        if jobs.active.is_empty() {
            return ExitAction::Allow;
        }
        if already_exiting {
            return ExitAction::AlreadyWaiting;
        }
        for (_, token) in jobs.active.values() {
            token.cancel();
        }
        ExitAction::Wait
    }

    async fn wait_for_idle(&self) {
        while self.has_active_jobs() {
            self.drained.notified().await;
        }
    }
}

impl Drop for RunningJob<'_> {
    fn drop(&mut self) {
        let mut jobs = self
            .jobs
            .registry
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        jobs.active.remove(&self.id);
        // Exit has a single waiter and notify_one preserves a permit if it hasn't started yet.
        if jobs.exiting && jobs.active.is_empty() {
            self.jobs.drained.notify_one();
        }
    }
}

pub fn handle_app_event(app: &AppHandle, event: tauri::RunEvent) {
    use tauri::Manager;
    if matches!(event, tauri::RunEvent::Exit) {
        // AppKit's Quit reaches Exit directly, without a cancellable ExitRequested event.
        if let Some(jobs) = app.try_state::<Jobs>() {
            jobs.request_exit();
            if jobs.has_active_jobs() {
                tauri::async_runtime::block_on(jobs.wait_for_idle());
            }
        }
        return;
    }
    let tauri::RunEvent::ExitRequested { api, code, .. } = event else {
        return;
    };
    let Some(jobs) = app.try_state::<Jobs>() else {
        return;
    };
    match jobs.request_exit() {
        ExitAction::Allow => {}
        ExitAction::AlreadyWaiting => api.prevent_exit(),
        ExitAction::Wait => {
            api.prevent_exit();
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                app.state::<Jobs>().wait_for_idle().await;
                app.exit(code.unwrap_or(0));
            });
        }
    }
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State by value"
)]
pub fn cancel_database_export(job_id: Uuid, jobs: State<'_, Jobs>) -> bool {
    jobs.cancel(job_id)
}

#[tauri::command]
pub async fn export_database_file(
    app: AppHandle,
    input: Input,
    on_progress: Channel<Progress>,
    state: State<'_, AppState>,
    jobs: State<'_, Jobs>,
) -> Result<Option<Receipt>, ExportError> {
    input.export.validate()?;
    if purchase::IS_MAS && matches!(input.export, Export::SqlDump { .. }) {
        return Err(ExportError::Unsupported);
    }
    let job = jobs.start(input.job_id, input.source_id)?;
    let profile = state
        .store
        .get_data_source(input.source_id)
        .await
        .map_err(|_| ExportError::Connection)?
        .ok_or(ExportError::Connection)?;
    if profile.database_type != DatabaseType::PostgreSql {
        return Err(ExportError::Unsupported);
    }
    connection_credentials::require_binding(&profile).map_err(|_| ExportError::Connection)?;
    let executable = if matches!(input.export, Export::SqlDump { .. }) {
        postgres_export::DumpClient::require_direct(&profile)?;
        Some(postgres_export::find_pg_dump().ok_or(ExportError::PgDumpMissing)?)
    } else {
        None
    };
    let stem = input.export.file_stem(&profile.database);
    let token = &job.token;
    let destination = tokio::select! {
        biased;
        () = token.cancelled() => return Err(ExportError::Cancelled),
        selection = choose_destination(app, &input, &stem) => selection?,
    };
    let Some(destination) = destination else {
        return Ok(None);
    };
    destination.ensure_available()?;
    let _ = on_progress.send(Progress::Exporting { bytes: 0 });
    let mut last_update = Instant::now();
    let mut progress = |bytes| {
        if last_update.elapsed() >= Duration::from_millis(500) {
            last_update = Instant::now();
            let _ = on_progress.send(Progress::Exporting { bytes });
        }
    };
    let (password, tunnel, timeout) = tokio::select! {
        biased;
        () = token.cancelled() => return Err(ExportError::Cancelled),
        setup = prepare_connection(&state, &profile) => setup?,
    };
    let temp = destination.create_temp()?;
    let options = crate::connection_options_from_profile(&profile, &password)
        .with_socket(tunnel.postgres_socket())
        .with_connect_timeout(Duration::from_secs(u64::from(timeout)));
    match input.export {
        Export::TableData {
            table,
            columns,
            format,
            protect_formulas,
        } => {
            tokio::select! {
                biased;
                () = token.cancelled() => return Err(ExportError::Cancelled),
                result = postgres_export::write_table(&options, &temp, &table, &columns, format, protect_formulas, &mut progress) => result?,
            }
        }
        Export::SqlDump {
            table,
            schema,
            mode,
        } => {
            let executable = executable.ok_or(ExportError::PgDumpMissing)?;
            let target = if let Some(table) = &table {
                let partitioned = tokio::select! {
                    biased;
                    () = token.cancelled() => return Err(ExportError::Cancelled),
                    result = postgres_export::is_partitioned(&options, table) => result?,
                };
                postgres_export::DumpTarget::Table { table, partitioned }
            } else {
                schema.as_deref().map_or(
                    postgres_export::DumpTarget::Database,
                    postgres_export::DumpTarget::Schema,
                )
            };
            let client = tokio::select! {
                biased;
                () = token.cancelled() => return Err(ExportError::Cancelled),
                client = postgres_export::DumpClient::new(&profile, &password, timeout) => client?,
            };
            let mut command = client.command(&executable, target, mode)?;
            postgres_export::write_dump(&mut command, &temp, token, &mut progress).await?;
        }
    }
    if token.is_cancelled() {
        return Err(ExportError::Cancelled);
    }
    let _ = on_progress.send(Progress::Finalizing);
    destination.commit(temp, token.clone()).await.map(Some)
}

async fn prepare_connection(
    state: &AppState,
    profile: &schema_model::DataSourceProfile,
) -> Result<(String, connection_security::Tunnel, u16), ExportError> {
    let profile_id = profile.id;
    let security = profile.security.clone();
    let (password, ssh_password) = tokio::task::spawn_blocking(move || {
        let password = crate::credential_entry(profile_id)
            .and_then(|key| key.get_password().map_err(|_| String::new()))
            .map_err(|_| ExportError::Connection)?;
        let ssh_password = connection_credentials::resolve_ssh(Some(profile_id), &security, None)
            .map_err(|_| ExportError::Connection)?;
        Ok::<_, ExportError>((password, ssh_password))
    })
    .await
    .map_err(|_| ExportError::Connection)??;
    let settings = state
        .store
        .get_data_source_settings(profile.id)
        .await
        .map_err(|_| ExportError::Connection)?;
    connection_security::validate(&profile.security, profile.ssl_mode)
        .map_err(|_| ExportError::Tls)?;
    let tunnel = connection_security::Tunnel::open(
        &profile.security,
        &profile.host,
        profile.port,
        profile.database_type,
        ssh_password.as_deref(),
    )
    .await
    .map_err(|_| ExportError::Connection)?;
    Ok((
        password,
        tunnel,
        settings.refresh.connection_timeout_seconds,
    ))
}

struct Destination {
    path: PathBuf,
}

impl Destination {
    fn ensure_available(&self) -> Result<(), ExportError> {
        match self.path.symlink_metadata() {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(ExportError::WriteFailed),
            Ok(_) => Err(ExportError::DestinationExists),
        }
    }

    fn create_temp(&self) -> Result<tempfile::NamedTempFile, ExportError> {
        self.ensure_available()?;
        let parent = self.path.parent().ok_or(ExportError::WriteFailed)?;
        tempfile::Builder::new()
            .prefix(".nodalstudio-export-")
            .suffix(".part")
            .tempfile_in(parent)
            .map_err(|_| ExportError::WriteFailed)
    }

    async fn commit(
        self,
        temp: tempfile::NamedTempFile,
        token: CancellationToken,
    ) -> Result<Receipt, ExportError> {
        tokio::task::spawn_blocking(move || {
            let file = temp.as_file();
            file.sync_all().map_err(|_| ExportError::WriteFailed)?;
            let bytes = file.metadata().map_err(|_| ExportError::WriteFailed)?.len();
            if token.is_cancelled() {
                return Err(ExportError::Cancelled);
            }
            temp.persist_noclobber(&self.path)
                .map_err(|error| match error.error.kind() {
                    std::io::ErrorKind::AlreadyExists => ExportError::DestinationExists,
                    _ => ExportError::WriteFailed,
                })?;
            Ok(Receipt {
                bytes,
                path: self.path.to_string_lossy().into_owned(),
            })
        })
        .await
        .map_err(|_| ExportError::WriteFailed)?
    }
}

async fn choose_destination(
    app: AppHandle,
    input: &Input,
    stem: &str,
) -> Result<Option<Destination>, ExportError> {
    let extension = input.export.extension();
    let stem: String = stem
        .chars()
        .take(96)
        .map(|value| {
            if value.is_alphanumeric() || matches!(value, '-' | '_') {
                value
            } else {
                '_'
            }
        })
        .collect();
    let variant = if matches!(
        input.export,
        Export::SqlDump {
            mode: DumpMode::StructureOnly,
            ..
        }
    ) {
        "-structure"
    } else {
        ""
    };
    let name = format!(
        "{stem}{variant}-{}.{extension}",
        chrono::Local::now().format("%Y%m%d-%H%M%S")
    );
    let chinese = input.locale.as_deref() == Some("zh-CN");
    tokio::task::spawn_blocking(move || {
        let picker = app.dialog().file().set_title(if chinese {
            "保存数据库导出文件"
        } else {
            "Save database export"
        });
        if purchase::IS_MAS {
            return picker
                .blocking_pick_folder()
                .map(|folder| {
                    let path = folder
                        .into_path()
                        .map_err(|_| ExportError::WriteFailed)?
                        .join(&name);
                    Ok(Destination { path })
                })
                .transpose();
        }
        picker
            .set_file_name(&name)
            .add_filter(extension.to_ascii_uppercase(), &[extension])
            .blocking_save_file()
            .map(|file| {
                let path = file.into_path().map_err(|_| ExportError::WriteFailed)?;
                if path
                    .extension()
                    .and_then(|value| value.to_str())
                    .is_none_or(|value| !value.eq_ignore_ascii_case(extension))
                {
                    return Err(ExportError::WriteFailed);
                }
                Ok(Destination { path })
            })
            .transpose()
    })
    .await
    .map_err(|_| ExportError::WriteFailed)?
}

#[cfg(test)]
#[path = "database_export_tests.rs"]
mod tests;
