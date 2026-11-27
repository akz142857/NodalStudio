//! Local `ESLint` checks for Code Review. Discovery reads metadata without starting Node.
#[cfg(feature = "code-extensions")]
mod vsix;

use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs::File,
    io::Read,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};

use rustix::process::{Pid, Signal, kill_process_group};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, State};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::{Child, Command},
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::{
    definition::normalize_source,
    files::review_relative_path,
    review::{FileVersion, Project, ReviewState},
};
use crate::{AppState, effective_settings};

const STALE: &str = "codeReviewStale";
const OFFLINE: &str = "eslintOffline";
const CONFIG: &str = "eslintConfig";
const MISSING: &str = "eslintMissing";
const UNSUPPORTED: &str = "eslintUnsupported";
const NODE: &str = "eslintNode";
const TRUST: &str = "eslintApproval";
const OUTPUT: &str = "eslintOutput";
const TOOL: &str = "eslintEngine";
const CANCELLED: &str = "eslintCancelled";
const TIMEOUT: &str = "timeout";
const MAX_INPUT: usize = 512 * 1024;
const MAX_OUTPUT: usize = 2 * 1024 * 1024;
const MAX_FINDINGS: usize = 2_000;
const CONFIG_NAMES: [&str; 6] = [
    "eslint.config.js",
    "eslint.config.mjs",
    "eslint.config.cjs",
    "eslint.config.ts",
    "eslint.config.mts",
    "eslint.config.cts",
];

#[derive(Default)]
pub(super) struct EslintSession(Mutex<SessionState>);

#[derive(Default)]
struct SessionState {
    approved: HashSet<String>,
    #[cfg(feature = "code-extensions")]
    extension_approved: HashSet<String>,
    #[cfg(feature = "code-extensions")]
    extension_generation: u64,
    active: Option<Active>,
    cancelled: VecDeque<Uuid>,
    closed: bool,
}

struct Active {
    id: Uuid,
    cancellation: CancellationToken,
    pid: Option<Pid>,
    #[cfg(feature = "code-extensions")]
    extension: bool,
}

impl Drop for Active {
    fn drop(&mut self) {
        self.cancellation.cancel();
        if let Some(pid) = self.pid {
            let _ = kill_process_group(pid, Signal::KILL);
        }
    }
}

impl EslintSession {
    pub(super) fn close(&self) {
        if let Ok(mut state) = self.0.lock() {
            state.closed = true;
            state.active = None;
            state.approved.clear();
            #[cfg(feature = "code-extensions")]
            state.clear_extension();
        }
    }

    fn clear_pid(&self, id: Uuid) {
        if let Ok(mut state) = self.0.lock()
            && let Some(active) = state.active.as_mut()
            && active.id == id
        {
            active.pid = None;
        }
    }

    #[cfg(feature = "code-extensions")]
    pub(super) fn revoke_extension(&self) {
        if let Ok(mut state) = self.0.lock() {
            state.clear_extension();
        }
    }
}

#[cfg(feature = "code-extensions")]
impl SessionState {
    fn clear_extension(&mut self) {
        self.extension_approved.clear();
        self.extension_generation = self.extension_generation.wrapping_add(1);
        if self.active.as_ref().is_some_and(|job| job.extension) {
            self.active = None;
        }
    }
}

struct RunGuard {
    project: Arc<Project>,
    id: Uuid,
}

impl Drop for RunGuard {
    fn drop(&mut self) {
        if let Ok(mut state) = self.project.eslint.0.lock()
            && state
                .active
                .as_ref()
                .is_some_and(|active| active.id == self.id)
        {
            state.active = None;
        }
    }
}

#[derive(Deserialize)]
struct Package {
    name: String,
    version: semver::Version,
}

struct Tool {
    file: PathBuf,
    node: PathBuf,
    entry: PathBuf,
    config: PathBuf,
    cwd: PathBuf,
    version: String,
    identity: String,
    context: String,
    #[cfg(feature = "code-extensions")]
    extension: Option<vsix::Server>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ToolInfo {
    tool_id: String,
    context: String,
    node: PathBuf,
    entry: PathBuf,
    config: PathBuf,
    cwd: PathBuf,
    version: String,
    approved: bool,
    #[cfg(feature = "code-extensions")]
    #[serde(skip_serializing_if = "Option::is_none")]
    extension: Option<vsix::ServerInfo>,
}

impl Tool {
    fn info(&self, session: &EslintSession) -> Result<ToolInfo, String> {
        let state = session.0.lock().map_err(|_| TOOL)?;
        if state.closed {
            return Err(STALE.into());
        }
        #[cfg(feature = "code-extensions")]
        let extension = self.extension.as_ref();
        #[cfg(feature = "code-extensions")]
        let approved = extension.map_or_else(
            || state.approved.contains(&self.identity),
            |server| {
                server.generation == state.extension_generation
                    && state.extension_approved.contains(&self.identity)
            },
        );
        #[cfg(not(feature = "code-extensions"))]
        let approved = state.approved.contains(&self.identity);
        #[cfg(feature = "code-extensions")]
        let entry = extension.map_or(self.entry.as_path(), vsix::Server::library);
        #[cfg(not(feature = "code-extensions"))]
        let entry = self.entry.as_path();
        Ok(ToolInfo {
            tool_id: self.identity.clone(),
            context: self.context.clone(),
            node: self.node.clone(),
            entry: entry.to_owned(),
            config: self.config.clone(),
            cwd: self.cwd.clone(),
            version: self.version.clone(),
            approved,
            #[cfg(feature = "code-extensions")]
            extension: extension.map(vsix::Server::info),
        })
    }
}

fn read_bounded(path: &Path, limit: usize) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    File::open(path)
        .and_then(|file| file.take(limit as u64 + 1).read_to_end(&mut bytes))
        .map_err(|_| TOOL)?;
    if bytes.len() > limit {
        return Err(TOOL.into());
    }
    Ok(bytes)
}

type DigestKey = (PathBuf, u64, u64, u64, i64, i64);

fn cached_file_digest(
    path: &Path,
    limit: usize,
    read_error: &'static str,
) -> Result<[u8; 32], String> {
    static CACHE: OnceLock<Mutex<HashMap<DigestKey, [u8; 32]>>> = OnceLock::new();
    let meta = path.metadata().map_err(|_| read_error)?;
    if !meta.is_file() || meta.len() > limit as u64 {
        return Err(read_error.into());
    }
    let key = (
        path.to_path_buf(),
        meta.dev(),
        meta.ino(),
        meta.len(),
        meta.ctime(),
        meta.ctime_nsec(),
    );
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(map) = cache.lock()
        && let Some(digest) = map.get(&key)
    {
        return Ok(*digest);
    }
    let bytes = read_bounded(path, limit).map_err(|_| read_error)?;
    let digest: [u8; 32] = Sha256::digest(&bytes).into();
    if let Ok(mut map) = cache.lock() {
        if map.len() >= 128 {
            map.clear();
        }
        map.insert(key, digest);
    }
    Ok(digest)
}

fn project_file(path: &Path, root: &Path) -> Option<PathBuf> {
    path.canonicalize()
        .ok()
        .filter(|p| p.starts_with(root) && p.is_file())
}

fn find_node(root: &Path) -> Option<PathBuf> {
    let path = std::env::var_os("PATH").unwrap_or_default();
    std::env::split_paths(&path)
        .filter(|dir| dir.is_absolute() && !dir.starts_with(root))
        .chain(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].map(PathBuf::from))
        .filter_map(|dir| dir.join("node").canonicalize().ok())
        .find(|node| {
            !node.starts_with(root)
                && node
                    .metadata()
                    .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
        })
}

fn discover(project: &Project, path: &str) -> Result<Tool, String> {
    project.directory()?;
    let relative = review_relative_path(path, false).map_err(|_| UNSUPPORTED)?;
    if !relative
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| {
            matches!(
                ext.to_ascii_lowercase().as_str(),
                "js" | "jsx" | "ts" | "tsx" | "mjs" | "cjs" | "mts" | "cts"
            )
        })
    {
        return Err(UNSUPPORTED.into());
    }
    let root = project.root.canonicalize().map_err(|_| STALE)?;
    let file = root.join(relative);
    if file.canonicalize().as_ref().ok() != Some(&file) || !file.is_file() {
        return Err(STALE.into());
    }
    let parents = file
        .parent()
        .ok_or(STALE)?
        .ancestors()
        .take_while(|dir| dir.starts_with(&root));
    let manifest_path = parents
        .clone()
        .find_map(|dir| project_file(&dir.join("node_modules/eslint/package.json"), &root))
        .ok_or(MISSING)?;
    let config = parents
        .flat_map(|dir| CONFIG_NAMES.map(|name| dir.join(name)))
        .find(|candidate| candidate.symlink_metadata().is_ok())
        .ok_or(CONFIG)?;
    let cwd = config.parent().ok_or(CONFIG)?.to_owned();
    let config = project_file(&config, &root).ok_or(CONFIG)?;
    if !config
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| matches!(ext, "js" | "mjs" | "cjs"))
    {
        return Err(UNSUPPORTED.into());
    }
    let manifest = read_bounded(&manifest_path, MAX_INPUT)?;
    let package: Package = serde_json::from_slice(&manifest).map_err(|_| UNSUPPORTED)?;
    if package.name != "eslint" || !matches!(package.version.major, 9 | 10) {
        return Err(UNSUPPORTED.into());
    }
    let entry = manifest_path
        .parent()
        .and_then(|p| project_file(&p.join("bin/eslint.js"), &root))
        .ok_or(MISSING)?;
    let node = find_node(&root).ok_or(NODE)?;
    let metadata = node.metadata().map_err(|_| NODE)?;
    let stamp = (
        metadata.dev(),
        metadata.ino(),
        metadata.len(),
        metadata.ctime(),
        metadata.ctime_nsec(),
    );
    let mut identity = Sha256::new();
    identity.update(serde_json::to_vec(&(&node, &entry, &cwd, &config, stamp)).map_err(|_| TOOL)?);
    identity.update(Sha256::digest(manifest));
    identity.update(cached_file_digest(&entry, MAX_INPUT, TOOL)?);
    let tool_id = format!("{:x}", identity.finalize());
    let mut context = Sha256::new();
    context.update(&tool_id);
    context.update(cached_file_digest(&config, MAX_INPUT, CONFIG)?);
    Ok(Tool {
        file,
        node,
        entry,
        config,
        cwd,
        version: package.version.to_string(),
        identity: tool_id,
        context: format!("{:x}", context.finalize()),
        #[cfg(feature = "code-extensions")]
        extension: None,
    })
}

fn discover_provider(
    handle: &AppHandle,
    project: &Project,
    path: &str,
    extension_sha256: Option<&str>,
) -> Result<Tool, String> {
    let tool = discover(project, path)?;
    let Some(sha256) = extension_sha256 else {
        return Ok(tool);
    };
    #[cfg(feature = "code-extensions")]
    {
        vsix::select_server(handle, project, sha256, tool)
    }
    #[cfg(not(feature = "code-extensions"))]
    {
        let _ = (handle, sha256);
        Err(UNSUPPORTED.into())
    }
}

async fn check_settings(app: &AppState) -> Result<(), String> {
    if effective_settings(&app.store, None)
        .await?
        .app
        .privacy
        .offline_mode
    {
        return Err(OFFLINE.into());
    }
    Ok(())
}

async fn resolve(
    handle: AppHandle,
    project: Arc<Project>,
    path: String,
    extension_sha256: Option<String>,
) -> Result<Tool, String> {
    tokio::task::spawn_blocking(move || {
        discover_provider(&handle, &project, &path, extension_sha256.as_deref())
    })
    .await
    .map_err(|_| TOOL)?
}

#[tauri::command]
pub(crate) async fn inspect_code_eslint(
    handle: AppHandle,
    project_id: Uuid,
    path: String,
    extension_sha256: Option<String>,
    state: State<'_, ReviewState>,
    app: State<'_, AppState>,
) -> Result<ToolInfo, String> {
    check_settings(&app).await?;
    let project = state.project(project_id)?;
    resolve(handle, project.clone(), path, extension_sha256)
        .await?
        .info(&project.eslint)
}

#[tauri::command]
pub(crate) async fn approve_code_eslint(
    handle: AppHandle,
    project_id: Uuid,
    path: String,
    tool_id: String,
    extension_sha256: Option<String>,
    state: State<'_, ReviewState>,
    app: State<'_, AppState>,
) -> Result<(), String> {
    check_settings(&app).await?;
    let project = state.project(project_id)?;
    let tool = resolve(handle, project.clone(), path, extension_sha256).await?;
    if tool.identity != tool_id {
        return Err(STALE.into());
    }
    let mut state = project.eslint.0.lock().map_err(|_| TOOL)?;
    if state.closed {
        return Err(STALE.into());
    }
    #[cfg(feature = "code-extensions")]
    if let Some(server) = tool.extension {
        if server.generation != state.extension_generation {
            return Err(STALE.into());
        }
        state.extension_approved.insert(tool_id);
        return Ok(());
    }
    state.approved.insert(tool_id);
    Ok(())
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn revoke_code_eslint(
    project_id: Uuid,
    state: State<'_, ReviewState>,
) -> Result<(), String> {
    let project = state.project(project_id)?;
    let mut state = project.eslint.0.lock().map_err(|_| TOOL)?;
    state.active = None;
    state.approved.clear();
    #[cfg(feature = "code-extensions")]
    state.clear_extension();
    Ok(())
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn cancel_code_eslint(
    project_id: Uuid,
    request_id: Uuid,
    state: State<'_, ReviewState>,
) -> Result<(), String> {
    let project = state.project(project_id)?;
    let mut state = project.eslint.0.lock().map_err(|_| TOOL)?;
    if state
        .active
        .as_ref()
        .is_some_and(|active| active.id == request_id)
    {
        state.active = None;
    } else {
        // The cancellation message can arrive while the run command is being dispatched.
        if state.cancelled.len() == 64 {
            state.cancelled.pop_front();
        }
        state.cancelled.push_back(request_id);
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EslintInput {
    request_id: Uuid,
    path: String,
    compare: bool,
    evidence: Option<String>,
    digest: String,
    context: String,
    limit: usize,
    extension_sha256: Option<String>,
}

fn capture(
    handle: &AppHandle,
    project: &Project,
    input: &EslintInput,
) -> Result<(Tool, String), String> {
    let doc = project.read(&input.path, input.compare)?;
    if doc.index_only {
        return Err("eslintIndex".into());
    }
    if input.compare && (input.evidence.is_none() || doc.evidence != input.evidence) {
        return Err(STALE.into());
    }
    let FileVersion::Text(text) = doc.after else {
        return Err(STALE.into());
    };
    let text = normalize_source(&text);
    if text.len() > MAX_INPUT || format!("{:x}", Sha256::digest(&text)) != input.digest {
        return Err(STALE.into());
    }
    let tool = discover_provider(
        handle,
        project,
        &input.path,
        input.extension_sha256.as_deref(),
    )?;
    if tool.context != input.context {
        return Err(STALE.into());
    }
    Ok((tool, text))
}

fn start(
    tool: &Tool,
    project: &Project,
    id: Uuid,
    server_entry: Option<&Path>,
) -> Result<(Child, CancellationToken), String> {
    {
        let state = project.eslint.0.lock().map_err(|_| TOOL)?;
        if state.active.as_ref().is_none_or(|active| active.id != id) {
            return Err(CANCELLED.into());
        }
    }
    let mut command = Command::new(&tool.node);
    if let Some(server) = server_entry {
        command.arg(server).arg("--stdio");
    } else {
        command
            .arg(&tool.entry)
            .args(["--stdin", "--stdin-filename"])
            .arg(&tool.file)
            .args(["--format", "json", "--no-color"]);
    }
    command
        .current_dir(&tool.cwd)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("ESLINT_USE_FLAT_CONFIG", "true")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(if server_entry.is_some() {
            Stdio::null()
        } else {
            Stdio::piped()
        })
        .process_group(0)
        .kill_on_drop(true);
    let child = command.spawn().map_err(|_| TOOL)?;
    let pid = child
        .id()
        .and_then(|raw| i32::try_from(raw).ok())
        .and_then(Pid::from_raw);
    let mut state = project.eslint.0.lock().map_err(|_| TOOL)?;
    let Some(active) = state.active.as_mut().filter(|active| active.id == id) else {
        if let Some(pid) = pid {
            let _ = kill_process_group(pid, Signal::KILL);
        }
        return Err(CANCELLED.into());
    };
    active.pid = pid;
    Ok((child, active.cancellation.clone()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    file_path: PathBuf,
    messages: Vec<Finding>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Finding {
    rule_id: Option<String>,
    severity: u8,
    fatal: Option<bool>,
    message: String,
    line: Option<usize>,
    column: Option<usize>,
    end_line: Option<usize>,
    end_column: Option<usize>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EslintReport {
    ignored: bool,
    findings: Vec<Finding>,
    total: usize,
}

fn decode_output(
    status: Option<i32>,
    stdout: &[u8],
    target: &Path,
    limit: usize,
) -> Result<EslintReport, String> {
    match status {
        Some(0 | 1) => (),
        Some(2) => return Err(CONFIG.into()),
        _ => return Err(TOOL.into()),
    }
    let mut reports: Vec<Report> = serde_json::from_slice(stdout).map_err(|_| OUTPUT)?;
    let mut findings = match reports.pop() {
        Some(report) if reports.is_empty() && report.file_path == target => report.messages,
        None => {
            return Ok(EslintReport {
                ignored: true,
                findings: vec![],
                total: 0,
            });
        }
        Some(_) => return Err(OUTPUT.into()),
    };
    let ignored = findings.len() == 1
        && findings[0].rule_id.is_none()
        && findings[0].line.is_none()
        && findings[0].severity == 1
        && findings[0].fatal != Some(true)
        && findings[0].message.starts_with("File ignored");
    let total = if ignored { 0 } else { findings.len() };
    findings.truncate(total.min(limit).min(MAX_FINDINGS));
    Ok(EslintReport {
        ignored,
        findings,
        total,
    })
}

async fn bounded_output<R: AsyncRead + Unpin>(reader: R) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    reader
        .take(MAX_OUTPUT as u64 + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| OUTPUT)?;
    if bytes.len() > MAX_OUTPUT {
        return Err(OUTPUT.into());
    }
    Ok(bytes)
}

async fn communicate(
    mut child: Child,
    text: String,
    project: &Project,
    id: Uuid,
) -> Result<(Option<i32>, Vec<u8>), String> {
    let mut stdin = child.stdin.take().ok_or(TOOL)?;
    let stdout = child.stdout.take().ok_or(TOOL)?;
    let stderr = child.stderr.take().ok_or(TOOL)?;
    let send = async move {
        match stdin.write_all(text.as_bytes()).await {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::BrokenPipe => Ok(()),
            Err(_) => Err(TOOL.into()),
        }
    };
    let wait = async {
        let status = child.wait().await.map_err(|_| String::from(TOOL))?;
        project.eslint.clear_pid(id);
        Ok(status)
    };
    let ((), out, _, status) =
        tokio::try_join!(send, bounded_output(stdout), bounded_output(stderr), wait)?;
    Ok((status.code(), out))
}

async fn watch_offline(app: &AppState) -> String {
    let mut rx = app.subscribe_offline();
    if rx.wait_for(|offline| *offline).await.is_ok() {
        OFFLINE.into()
    } else {
        std::future::pending::<String>().await
    }
}

#[tauri::command]
pub(crate) async fn run_code_eslint(
    handle: AppHandle,
    project_id: Uuid,
    input: EslintInput,
    state: State<'_, ReviewState>,
    app: State<'_, AppState>,
) -> Result<EslintReport, String> {
    let project = state.project(project_id)?;
    let id = input.request_id;
    let limit = input.limit;
    {
        let mut session = project.eslint.0.lock().map_err(|_| TOOL)?;
        if session.closed {
            return Err(STALE.into());
        }
        if let Some(index) = session
            .cancelled
            .iter()
            .position(|cancelled| *cancelled == id)
        {
            session.cancelled.remove(index);
            return Err(CANCELLED.into());
        }
        session.active = Some(Active {
            id,
            cancellation: CancellationToken::new(),
            pid: None,
            #[cfg(feature = "code-extensions")]
            extension: input.extension_sha256.is_some(),
        });
    }
    let _guard = RunGuard {
        project: project.clone(),
        id,
    };
    check_settings(&app).await?;
    let capture_project = project.clone();
    let (tool, text) =
        tokio::task::spawn_blocking(move || capture(&handle, &capture_project, &input))
            .await
            .map_err(|_| TOOL)??;
    check_settings(&app).await?;
    if !tool.info(&project.eslint)?.approved {
        return Err(TRUST.into());
    }
    #[cfg(feature = "code-extensions")]
    let server = if let Some(extension) = &tool.extension {
        let script = extension.script_bytes();
        Some(
            tokio::task::spawn_blocking(move || vsix::stage_script(&script))
                .await
                .map_err(|_| TOOL)??,
        )
    } else {
        None
    };
    #[cfg(feature = "code-extensions")]
    let server_entry = server.as_ref().map(tempfile::NamedTempFile::path);
    #[cfg(not(feature = "code-extensions"))]
    let server_entry = None;
    let (child, cancellation) = start(&tool, &project, id, server_entry)?;
    let report = async {
        #[cfg(feature = "code-extensions")]
        if let Some(server) = &tool.extension {
            return vsix::lint(child, &tool, server, text, limit).await;
        }
        let (status, stdout) = communicate(child, text, &project, id).await?;
        decode_output(status, &stdout, &tool.file, limit)
    };
    tokio::select! {
        biased;
        () = cancellation.cancelled() => Err(CANCELLED.into()),
        reason = watch_offline(&app) => Err(reason),
        result = tokio::time::timeout(Duration::from_secs(12), report) => result.map_err(|_| TIMEOUT)?,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn report_distinguishes_rule_errors_parse_errors_and_ignored_files() {
        let target = Path::new("/project/index.ts");
        let json = br#"[{"filePath":"/project/index.ts","messages":[
            {"ruleId":"no-debugger","severity":2,"message":"Unexpected debugger.","line":2,"column":6,"endLine":2,"endColumn":14},
            {"ruleId":null,"fatal":true,"severity":2,"message":"Parsing error","line":4,"column":1}
        ]}]"#;
        let report = decode_output(Some(1), json, target, 2).unwrap();
        assert_eq!(report.total, 2);
        assert_eq!(report.findings[0].end_column, Some(14));
        assert_eq!(report.findings[1].fatal, Some(true));
        assert_eq!(
            decode_output(Some(1), json, target, 1)
                .unwrap()
                .findings
                .len(),
            1
        );
        assert!(decode_output(Some(0), b"[]", target, 1).unwrap().ignored);
        assert_eq!(
            decode_output(Some(2), json, target, 1).err().as_deref(),
            Some(CONFIG)
        );
        assert_eq!(
            decode_output(Some(1), json, Path::new("/different.js"), 1)
                .err()
                .as_deref(),
            Some(OUTPUT)
        );
    }

    #[tokio::test]
    async fn cancelling_the_native_process_group_kills_its_children() {
        use tokio::io::{AsyncBufReadExt, BufReader};
        let mut child = Command::new("/bin/sh")
            .args(["-c", "/bin/sleep 30 & echo $!; wait"])
            .stdout(Stdio::piped())
            .process_group(0)
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let active = Active {
            id: Uuid::new_v4(),
            cancellation: CancellationToken::new(),
            #[cfg(feature = "code-extensions")]
            extension: true,
            pid: child
                .id()
                .and_then(|id| i32::try_from(id).ok())
                .and_then(Pid::from_raw),
        };
        let mut reader = BufReader::new(child.stdout.take().unwrap());
        let mut descendant = String::new();
        tokio::time::timeout(Duration::from_secs(2), reader.read_line(&mut descendant))
            .await
            .unwrap()
            .unwrap();
        assert!(descendant.trim().parse::<i32>().is_ok());
        let cancellation = active.cancellation.clone();
        assert!(active.pid.is_some());
        drop(active);
        assert!(cancellation.is_cancelled());
        tokio::time::timeout(Duration::from_secs(2), child.wait())
            .await
            .unwrap()
            .unwrap();
        // The descendant inherits stdout. EOF now means both it and its parent closed the pipe.
        let mut extra = String::new();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(2), reader.read_line(&mut extra))
                .await
                .unwrap()
                .unwrap(),
            0
        );
    }
}
