//! Resolves symbols through the language server that owns the source file.
use std::{
    collections::{BTreeMap, VecDeque},
    path::{Path, PathBuf},
    sync::{
        Arc, Weak,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use cap_std::fs::Dir;
use futures_util::{StreamExt, stream};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::{
    files::{MAX_FILE_BYTES, Repository, read_nested, review_relative_path},
    language_server::{
        ActivityState, Language, LanguageServer, ServerError, SharedActivity, WorkProgress,
        file_uri,
    },
};

const MAX_SERVERS: usize = 12;
const MAX_SOURCES: usize = 128;
const MAX_TARGETS: usize = 16;
const MAX_HIGHLIGHTS: usize = 1000;
const MAX_OUTLINE_SYMBOLS: usize = 1500;
const MAX_OUTLINE_DEPTH: usize = 16;
const SOURCE_UNAVAILABLE: &str = "definitionSourceUnavailable";

type ServerKey = (Language, PathBuf);

#[derive(Default)]
struct Server {
    session: Mutex<Option<LanguageServer>>,
    activity: SharedActivity,
}

#[derive(Default)]
pub(super) struct Definitions {
    pub(super) enabled: Arc<AtomicBool>,
    pub(super) stopped: CancellationToken,
    servers: Mutex<VecDeque<(ServerKey, Arc<Server>)>>,
    sources: Mutex<VecDeque<(Uuid, Dependency)>>,
    startup: Mutex<Startup>,
}

#[derive(Default)]
enum Startup {
    #[default]
    Discovering,
    Workspaces(PathBuf, Vec<(ServerKey, Arc<Server>)>),
    Failed,
}

#[derive(Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub(crate) enum LanguageServiceStatus {
    Offline,
    Disabled,
    Discovering,
    Workspaces { workspaces: Vec<LanguageWorkspace> },
    Failed,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LanguageWorkspace {
    language: Language,
    root: String,
    command: &'static str,
    state: ActivityState,
    progress: Option<WorkProgress>,
    last_task: Option<String>,
}

#[derive(Clone)]
struct Dependency {
    uri: Url,
    language: Language,
    server: Weak<Server>,
    root: PathBuf,
}

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Debug)]
pub(crate) struct DefinitionPosition {
    line: u32,
    character: u32,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum DefinitionOrigin {
    Workspace { path: String },
    Dependency { id: Uuid },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SourcePosition {
    origin: DefinitionOrigin,
    position: DefinitionPosition,
    text: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DefinitionRequest {
    #[serde(flatten)]
    source: SourcePosition,
    pub(super) enable: bool,
}

#[derive(Deserialize, Serialize)]
pub(crate) struct DocumentHighlightRange {
    start: DefinitionPosition,
    end: DefinitionPosition,
}

#[derive(Deserialize)]
pub(crate) struct DocumentOutlineRequest {
    origin: DefinitionOrigin,
    text: String,
    pub(super) enable: bool,
}

#[derive(Serialize)]
pub(crate) struct OutlineSymbol {
    name: String,
    kind: u32,
    position: DefinitionPosition,
    children: Vec<Self>,
}

#[derive(Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub(crate) enum DocumentOutlineResult {
    Offline,
    Disabled,
    MissingServer { command: &'static str },
    ServerFailed { command: &'static str },
    Stale,
    Unavailable,
    Ready { symbols: Vec<OutlineSymbol> },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DefinitionTarget {
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_id: Option<Uuid>,
    position: DefinitionPosition,
}

#[derive(Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub(crate) enum DefinitionResult {
    Offline,
    Disabled,
    Unsupported,
    MissingServer { command: &'static str },
    Stale,
    Unavailable,
    NotFound,
    Resolved { targets: Vec<DefinitionTarget> },
}

#[derive(Clone, Copy)]
enum SymbolRequest {
    Definition(DefinitionPosition),
    DocumentHighlight(DefinitionPosition),
    DocumentSymbols,
}

impl Definitions {
    pub(super) async fn while_running<T>(&self, task: impl Future<Output = T>) -> Option<T> {
        tokio::select! {
            biased;
            _ = self.stopped.cancelled() => None,
            output = task => Some(output),
        }
    }
    pub(super) fn with_grant(enabled: Arc<AtomicBool>) -> Self {
        Self {
            enabled,
            ..Self::default()
        }
    }

    pub(super) fn is_enabled(&self) -> bool {
        !cfg!(feature = "mac-app-store") && self.enabled.load(Ordering::Relaxed)
    }

    pub(super) async fn status(&self) -> LanguageServiceStatus {
        if !self.is_enabled() {
            return LanguageServiceStatus::Disabled;
        }
        match &*self.startup.lock().await {
            Startup::Discovering => LanguageServiceStatus::Discovering,
            Startup::Failed => LanguageServiceStatus::Failed,
            Startup::Workspaces(project_root, servers) => LanguageServiceStatus::Workspaces {
                workspaces: servers
                    .iter()
                    .filter_map(|((language, root), server)| {
                        let activity = server.activity.lock().ok()?;
                        Some(LanguageWorkspace {
                            language: *language,
                            root: root
                                .strip_prefix(project_root)
                                .unwrap_or(root)
                                .to_string_lossy()
                                .replace('\\', "/"),
                            command: language.command().0,
                            state: activity.state,
                            progress: activity.progress(),
                            last_task: activity.last_task(),
                        })
                    })
                    .collect(),
            },
        }
    }

    pub(super) async fn prewarm(&self, discovered: Option<(PathBuf, Vec<Origin>)>) {
        let Some((project_root, origins)) = discovered else {
            *self.startup.lock().await = Startup::Failed;
            return;
        };
        let mut work = Vec::new();
        let mut workspaces = Vec::new();
        for origin in origins {
            let key = (origin.language, origin.root.clone());
            let server = self.server(key.clone()).await;
            workspaces.push((key, Arc::clone(&server)));
            work.push((server, origin));
        }
        *self.startup.lock().await = Startup::Workspaces(project_root.clone(), workspaces);
        let project_root = &project_root;
        stream::iter(work)
            .for_each_concurrent(2, |(server, origin)| async move {
                let mut session = server.session.lock().await;
                if let Ok(client) = connect(&server, &mut session, project_root, &origin).await
                    && client
                        .open(&origin.uri, origin.language_id, &origin.text)
                        .await
                        .is_err()
                {
                    server.disconnect(&mut session);
                }
            })
            .await;
    }

    pub(super) async fn lookup(
        &self,
        project_root: PathBuf,
        directory: Repository,
        input: DefinitionRequest,
    ) -> DefinitionResult {
        if cfg!(feature = "mac-app-store") {
            return DefinitionResult::Unsupported;
        }
        let SourcePosition {
            origin,
            position,
            text,
        } = input.source;
        if !position_in_text(&text, position) {
            return DefinitionResult::Stale;
        }
        let origin = match self
            .checked_origin(&project_root, &directory, origin, &text)
            .await
        {
            Ok(origin) => origin,
            Err(result) => return result,
        };
        if input.enable {
            self.enabled.store(true, Ordering::Relaxed);
        }
        if !self.enabled.load(Ordering::Relaxed) {
            return DefinitionResult::Disabled;
        }

        let server = self.server((origin.language, origin.root.clone())).await;
        let response = match query_symbol(
            &server,
            &project_root,
            &origin,
            SymbolRequest::Definition(position),
        )
        .await
        {
            Ok(value) => value,
            Err(error) => return server_failure(origin.language, &error),
        };
        let mut targets = Vec::new();
        for (uri, position) in locations(&response) {
            if let Some(target) = self
                .target(&project_root, &directory, &origin, &server, uri, position)
                .await
            {
                targets.push(target);
            }
        }
        if targets.is_empty() {
            DefinitionResult::NotFound
        } else {
            DefinitionResult::Resolved { targets }
        }
    }

    pub(super) async fn highlights(
        &self,
        project_root: &Path,
        directory: &Repository,
        input: SourcePosition,
    ) -> Vec<DocumentHighlightRange> {
        if cfg!(feature = "mac-app-store") || !self.enabled.load(Ordering::Relaxed) {
            return Vec::new();
        }
        let SourcePosition {
            origin,
            position,
            text,
        } = input;
        if !position_in_text(&text, position) {
            return Vec::new();
        }
        let Ok(origin) = self
            .checked_origin(project_root, directory, origin, &text)
            .await
        else {
            return Vec::new();
        };
        let server = self.server((origin.language, origin.root.clone())).await;
        let response = query_symbol(
            &server,
            project_root,
            &origin,
            SymbolRequest::DocumentHighlight(position),
        )
        .await;
        response.map_or_else(
            |_| Vec::new(),
            |value| document_highlights(&value, &origin.uri),
        )
    }

    pub(super) async fn outline(
        &self,
        project_root: &Path,
        directory: &Repository,
        input: DocumentOutlineRequest,
    ) -> DocumentOutlineResult {
        if cfg!(feature = "mac-app-store") {
            return DocumentOutlineResult::Unavailable;
        }
        if !input.enable && !self.enabled.load(Ordering::Relaxed) {
            return DocumentOutlineResult::Disabled;
        }
        let origin = match self
            .checked_origin(project_root, directory, input.origin, &input.text)
            .await
        {
            Ok(origin) => origin,
            Err(DefinitionResult::Stale) => return DocumentOutlineResult::Stale,
            Err(_) => return DocumentOutlineResult::Unavailable,
        };
        if input.enable {
            self.enabled.store(true, Ordering::Relaxed);
        }
        let server = self.server((origin.language, origin.root.clone())).await;
        match query_symbol(
            &server,
            project_root,
            &origin,
            SymbolRequest::DocumentSymbols,
        )
        .await
        {
            Ok(value) => {
                let line_lengths: Vec<_> = origin
                    .text
                    .split('\n')
                    .map(|line| line.encode_utf16().count())
                    .collect();
                let mut budget = MAX_OUTLINE_SYMBOLS;
                DocumentOutlineResult::Ready {
                    symbols: outline_symbols(&value, &origin.uri, &line_lengths, 0, &mut budget),
                }
            }
            Err(ServerError::Missing) => DocumentOutlineResult::MissingServer {
                command: origin.language.command().0,
            },
            Err(ServerError::Transport | ServerError::Request) => {
                DocumentOutlineResult::ServerFailed {
                    command: origin.language.command().0,
                }
            }
        }
    }

    async fn checked_origin(
        &self,
        project_root: &Path,
        directory: &Repository,
        source: DefinitionOrigin,
        text: &str,
    ) -> Result<Origin, DefinitionResult> {
        if text.len() as u64 > MAX_FILE_BYTES {
            return Err(DefinitionResult::Stale);
        }
        let origin = self
            .resolve_origin(project_root, directory, source)
            .await
            .ok_or(DefinitionResult::Unsupported)?;
        if origin.text != text {
            return Err(DefinitionResult::Stale);
        }
        Ok(origin)
    }

    async fn resolve_origin(
        &self,
        project_root: &Path,
        directory: &Repository,
        origin: DefinitionOrigin,
    ) -> Option<Origin> {
        let (file, root) = match origin {
            DefinitionOrigin::Workspace { path } => {
                let file = project_root.join(review_relative_path(&path, false).ok()?);
                (file, None)
            }
            DefinitionOrigin::Dependency { id } => {
                let source = self.dependency(id).await?;
                let file = local_path(&source.uri)?;
                (file, Some(source))
            }
        };
        let (language, language_id) = Language::for_path(&file)?;
        let root = root.map_or_else(
            || language.workspace_root(project_root, &file),
            |source| source.root,
        );
        let text = normalize_source(&read_source(project_root, directory, &file)?);
        Some(Origin {
            uri: file_uri(&file)?,
            text,
            root,
            language,
            language_id,
        })
    }

    async fn server(&self, key: ServerKey) -> Arc<Server> {
        let mut servers = self.servers.lock().await;
        let server = servers
            .iter()
            .position(|(existing, _)| *existing == key)
            .and_then(|index| servers.remove(index))
            .map_or_else(|| Arc::new(Server::default()), |(_, server)| server);
        if servers.len() == MAX_SERVERS {
            let unused = servers
                .iter()
                .position(|(_, server)| Arc::strong_count(server) == 1);
            servers.remove(unused.unwrap_or_default());
        }
        servers.push_back((key, Arc::clone(&server)));
        server
    }

    async fn target(
        &self,
        project_root: &Path,
        directory: &Repository,
        origin: &Origin,
        server: &Arc<Server>,
        uri: Url,
        position: DefinitionPosition,
    ) -> Option<DefinitionTarget> {
        let mut uri = uri;
        let path = if uri.scheme() == "file" {
            let file = local_path(&uri)?.canonicalize().ok()?;
            if let Ok(relative) = file.strip_prefix(project_root) {
                let relative = relative.to_str()?.replace('\\', "/");
                let path = review_relative_path(&relative, false).ok()?;
                read_nested(&directory.dir, &path, MAX_FILE_BYTES).ok()?;
                return Some(DefinitionTarget {
                    path: relative,
                    source_id: None,
                    position,
                });
            }
            Language::for_path(&file)?;
            uri = file_uri(&file)?;
            file.to_string_lossy().into_owned()
        } else {
            match (origin.language, uri.scheme()) {
                (Language::Java, "jdt") => {
                    let name = uri.path_segments()?.next_back()?;
                    let class = name
                        .strip_suffix(".java")
                        .or_else(|| name.strip_suffix(".class"))?;
                    format!("JDK or library/{class}.java")
                }
                (Language::Swift, "sourcekit-lsp") => {
                    "Swift dependencies/Generated interface.swift".to_owned()
                }
                _ => return None,
            }
        };
        let dependency = Dependency {
            uri,
            language: origin.language,
            server: Arc::downgrade(server),
            root: origin.root.clone(),
        };
        let mut sources = self.sources.lock().await;
        let id = sources
            .iter()
            .position(|(_, source)| {
                source.uri == dependency.uri && Weak::ptr_eq(&source.server, &dependency.server)
            })
            .and_then(|index| sources.remove(index))
            .map_or_else(Uuid::new_v4, |(id, _)| id);
        if sources.len() == MAX_SOURCES {
            sources.pop_front();
        }
        sources.push_back((id, dependency));
        Some(DefinitionTarget {
            path,
            source_id: Some(id),
            position,
        })
    }

    async fn dependency(&self, id: Uuid) -> Option<Dependency> {
        self.sources
            .lock()
            .await
            .iter()
            .find(|(key, _)| *key == id)
            .map(|(_, source)| source.clone())
    }

    pub(super) async fn source(
        &self,
        project_root: &Path,
        directory: &Repository,
        id: Uuid,
    ) -> Result<String, &'static str> {
        let source = self.dependency(id).await.ok_or(SOURCE_UNAVAILABLE)?;
        if let Some(path) = local_path(&source.uri) {
            return read_source(project_root, directory, &path).ok_or(SOURCE_UNAVAILABLE);
        }
        let server = source.server.upgrade().ok_or(SOURCE_UNAVAILABLE)?;
        let mut session = server.session.lock().await;
        let client = session.as_mut().ok_or(SOURCE_UNAVAILABLE)?;
        let (method, content_key) = match (source.language, source.uri.scheme()) {
            (Language::Java, "jdt") => ("java/classFileContents", None),
            (Language::Swift, "sourcekit-lsp") => {
                ("sourcekit/workspace/getReferenceDocument", Some("content"))
            }
            _ => return Err(SOURCE_UNAVAILABLE),
        };
        let value = client
            .request(method, json!({ "uri": source.uri.as_str() }))
            .await
            .map_err(|_| SOURCE_UNAVAILABLE)?;
        let text = content_key
            .map_or(&value, |key| &value[key])
            .as_str()
            .filter(|text| !text.is_empty() && text.len() as u64 <= MAX_FILE_BYTES)
            .ok_or(SOURCE_UNAVAILABLE)?;
        Ok(text.to_owned())
    }
}

pub(super) struct Origin {
    uri: Url,
    text: String,
    root: PathBuf,
    language: Language,
    language_id: &'static str,
}

pub(super) fn warmup_sources(
    project_root: &Path,
    directory: &Repository,
    paths: Vec<String>,
) -> Vec<Origin> {
    // Start one workspace per language. Other workspace roots still open on demand.
    let mut candidates: BTreeMap<Language, Vec<_>> = BTreeMap::new();
    for path in paths {
        let relative = Path::new(&path);
        if let Some((language, language_id)) = Language::for_path(relative) {
            let in_sources = path.starts_with("src/") || path.contains("/src/");
            let typed = language_id.starts_with("typescript");
            let priority = (typed, in_sources);
            candidates
                .entry(language)
                .or_default()
                .push((priority, path, language_id));
        }
    }
    candidates
        .into_iter()
        .filter_map(|(language, mut files)| {
            files.sort_by_key(|(priority, _, _)| std::cmp::Reverse(*priority));
            files.into_iter().find_map(|(_, path, language_id)| {
                let file = project_root.join(path);
                let text = normalize_source(&read_source(project_root, directory, &file)?);
                Some(Origin {
                    uri: file_uri(&file)?,
                    root: language.workspace_root(project_root, &file),
                    text,
                    language,
                    language_id,
                })
            })
        })
        .collect()
}

impl Server {
    fn disconnect(&self, session: &mut Option<LanguageServer>) {
        *session = None;
        if let Ok(mut activity) = self.activity.lock() {
            activity.fail(ActivityState::Failed);
        }
    }
}

async fn connect<'a>(
    server: &Server,
    session: &'a mut Option<LanguageServer>,
    project_root: &Path,
    origin: &Origin,
) -> Result<&'a mut LanguageServer, ServerError> {
    // An idle connection can fail before the next user request.
    if server
        .activity
        .lock()
        .is_ok_and(|activity| activity.state == ActivityState::Failed)
    {
        *session = None;
    }
    if session.is_none() {
        let result = LanguageServer::start(
            origin.language,
            &origin.root,
            project_root,
            &server.activity,
        )
        .await;
        if let Ok(mut activity) = server.activity.lock() {
            match &result {
                Ok(_) if activity.state == ActivityState::Starting => {
                    activity.state = ActivityState::Connected
                }
                Err(ServerError::Missing) => activity.fail(ActivityState::Missing),
                Err(_) => activity.fail(ActivityState::Failed),
                Ok(_) => {}
            }
        }
        *session = Some(result?);
    }
    session.as_mut().ok_or(ServerError::Transport)
}

async fn query_symbol(
    server: &Server,
    project_root: &Path,
    origin: &Origin,
    request: SymbolRequest,
) -> Result<Value, ServerError> {
    let mut session = match request {
        SymbolRequest::Definition(_) | SymbolRequest::DocumentSymbols => {
            server.session.lock().await
        }
        SymbolRequest::DocumentHighlight(_) => server
            .session
            .try_lock()
            .map_err(|_| ServerError::Request)?,
    };
    let client = connect(server, &mut session, project_root, origin).await?;
    let result = request_symbol(client, origin, request).await;
    if matches!(&result, Err(ServerError::Transport)) {
        server.disconnect(&mut session);
    }
    result
}

async fn request_symbol(
    client: &mut LanguageServer,
    origin: &Origin,
    request: SymbolRequest,
) -> Result<Value, ServerError> {
    client
        .open(&origin.uri, origin.language_id, &origin.text)
        .await?;
    let mut params = json!({ "textDocument": { "uri": origin.uri.as_str() } });
    let (method, position, attempts) = match request {
        SymbolRequest::Definition(position) => ("textDocument/definition", Some(position), 5),
        SymbolRequest::DocumentHighlight(position) => {
            ("textDocument/documentHighlight", Some(position), 1)
        }
        SymbolRequest::DocumentSymbols => ("textDocument/documentSymbol", None, 2),
    };
    if let Some(position) = position {
        params["position"] = json!(position);
    }
    for attempt in 1..=attempts {
        let value = client.request(method, params.clone()).await?;
        if attempt == attempts || (!value.is_null() && !value.as_array().is_some_and(Vec::is_empty))
        {
            return Ok(value);
        }
        // Project import or indexing can still be running after initialize.
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
    Ok(Value::Null)
}

fn outline_symbols(
    response: &Value,
    uri: &Url,
    lines: &[usize],
    depth: usize,
    budget: &mut usize,
) -> Vec<OutlineSymbol> {
    let mut symbols = Vec::new();
    if depth >= MAX_OUTLINE_DEPTH {
        return symbols;
    }
    for entry in response
        .as_array()
        .into_iter()
        .flatten()
        .take(MAX_OUTLINE_SYMBOLS)
    {
        if *budget == 0 {
            break;
        }
        if entry
            .pointer("/location/uri")
            .is_some_and(|location| location.as_str() != Some(uri.as_str()))
        {
            continue;
        }
        let (Some(name), Some(kind), Some(position)) = (
            entry["name"]
                .as_str()
                .filter(|name| !name.trim().is_empty()),
            entry["kind"]
                .as_u64()
                .and_then(|kind| u32::try_from(kind).ok()),
            entry
                .pointer("/selectionRange/start")
                .or_else(|| entry.pointer("/location/range/start"))
                .and_then(|value| serde_json::from_value::<DefinitionPosition>(value.clone()).ok()),
        ) else {
            continue;
        };
        if lines
            .get(position.line as usize)
            .is_none_or(|length| position.character as usize > *length)
        {
            continue;
        }
        *budget -= 1;
        symbols.push(OutlineSymbol {
            name: name.to_owned(),
            kind,
            position,
            children: outline_symbols(&entry["children"], uri, lines, depth + 1, budget),
        });
    }
    symbols.sort_by_key(|symbol| (symbol.position.line, symbol.position.character));
    symbols
}

fn document_highlights(response: &Value, uri: &Url) -> Vec<DocumentHighlightRange> {
    response
        .as_array()
        .into_iter()
        .flatten()
        .take(MAX_HIGHLIGHTS)
        .filter(|entry| {
            entry
                .get("uri")
                .is_none_or(|file| file.as_str() == Some(uri.as_str()))
        })
        .filter_map(|entry| serde_json::from_value(entry.get("range")?.clone()).ok())
        .collect()
}

fn locations(response: &Value) -> Vec<(Url, DefinitionPosition)> {
    let entries = response
        .as_array()
        .map_or_else(|| std::slice::from_ref(response), Vec::as_slice);
    let mut found = Vec::new();
    for entry in entries.iter().take(MAX_TARGETS) {
        let uri = entry["targetUri"]
            .as_str()
            .or_else(|| entry["uri"].as_str());
        let position = entry
            .pointer("/targetSelectionRange/start")
            .or_else(|| entry.pointer("/range/start"));
        if let Some(uri) = uri.and_then(|uri| Url::parse(uri).ok())
            && let Some(position) = position.and_then(|position| {
                serde_json::from_value::<DefinitionPosition>(position.clone()).ok()
            })
            && !found.contains(&(uri.clone(), position))
        {
            found.push((uri, position));
        }
    }
    found
}

fn local_path(uri: &Url) -> Option<PathBuf> {
    uri.to_file_path().ok()
}

fn read_source(project_root: &Path, directory: &Repository, file: &Path) -> Option<String> {
    let canonical;
    let file = if file.starts_with(project_root) {
        file
    } else {
        canonical = file.canonicalize().ok()?;
        &canonical
    };
    let text = if let Ok(relative) = file.strip_prefix(project_root) {
        let path = review_relative_path(&relative.to_str()?.replace('\\', "/"), false).ok()?;
        read_nested(&directory.dir, &path, MAX_FILE_BYTES).ok()?
    } else {
        Language::for_path(file)?;
        let parent = Dir::open_ambient_dir(file.parent()?, cap_std::ambient_authority()).ok()?;
        read_nested(&parent, Path::new(file.file_name()?), MAX_FILE_BYTES).ok()?
    };
    (!text.contains('\0')).then_some(text)
}

pub(super) fn normalize_source(text: &str) -> String {
    text.strip_prefix('\u{feff}')
        .unwrap_or(text)
        .replace("\r\n", "\n")
        .replace('\r', "\n")
}

fn position_in_text(text: &str, position: DefinitionPosition) -> bool {
    text.split('\n')
        .nth(position.line as usize)
        .is_some_and(|line| (position.character as usize) < line.encode_utf16().count())
}

fn server_failure(language: Language, error: &ServerError) -> DefinitionResult {
    match error {
        ServerError::Missing => DefinitionResult::MissingServer {
            command: language.command().0,
        },
        ServerError::Transport | ServerError::Request => DefinitionResult::Unavailable,
    }
}

#[cfg(all(test, not(feature = "mac-app-store")))]
mod tests {
    use super::*;

    #[test]
    fn highlights_accept_document_ranges_and_ignore_foreign_locations() {
        let uri = Url::parse("file:///work/main.go").unwrap();
        let range =
            json!({ "start": { "line": 1, "character": 4 }, "end": { "line": 1, "character": 9 } });
        let results = document_highlights(
            &json!([
                { "range": range, "kind": 2 },
                { "uri": "file:///work/other.go", "range": range },
                { "range": { "start": { "line": 0, "character": 0 } } }
            ]),
            &uri,
        );
        assert_eq!(serde_json::to_value(results).unwrap(), json!([range]));
    }

    #[test]
    fn outline_preserves_children_and_uses_current_file_selection_ranges() {
        let input = json!([
            { "name": "Report", "kind": 23, "selectionRange": { "start": { "line": 0, "character": 5 } },
              "children": [
                { "name": "summary", "kind": 6, "selectionRange": { "start": { "line": 1, "character": 8 } } },
                { "name": "invalid", "kind": 6, "selectionRange": { "start": { "line": 1, "character": 100 } } }
              ] },
            { "name": "other", "kind": 12, "location": { "uri": "file:///work/other.go", "range": { "start": { "line": 1, "character": 8 } } } },
            { "name": "local", "kind": 12, "location": { "uri": "file:///work/main.go", "range": { "start": { "line": 1, "character": 21 } } } }
        ]);
        let mut budget = MAX_OUTLINE_SYMBOLS;
        let uri = Url::parse("file:///work/main.go").unwrap();
        let result = outline_symbols(&input, &uri, &[16, 30], 0, &mut budget);
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].name, "Report");
        assert_eq!(result[0].children.len(), 1);
        assert_eq!(
            result[0].children[0].position,
            DefinitionPosition {
                line: 1,
                character: 8
            }
        );
        assert_eq!(result[1].name, "local");
    }

    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "Uses configured TypeScript and Rust language servers against the NodalStudio checkout."]
    async fn real_project_outlines() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .canonicalize()
            .unwrap();
        let (directory, _) = Repository::open_directory(&root, None).unwrap();
        let definitions = Definitions::default();
        for (path, expected) in [
            ("apps/frontend/src/App.tsx", "App"),
            (
                "apps/desktop/src-tauri/src/code_view/review.rs",
                "ReviewState",
            ),
        ] {
            let text = normalize_source(&std::fs::read_to_string(root.join(path)).unwrap());
            let result = definitions
                .outline(
                    &root,
                    &directory,
                    DocumentOutlineRequest {
                        origin: DefinitionOrigin::Workspace { path: path.into() },
                        text,
                        enable: true,
                    },
                )
                .await;
            let DocumentOutlineResult::Ready { symbols } = result else {
                panic!("{path}: {}", serde_json::to_string(&result).unwrap());
            };
            assert!(
                symbols.iter().any(|symbol| symbol.name == expected),
                "{path}"
            );
            println!(
                "{path}: {} top-level symbols, including {expected}",
                symbols.len()
            );
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "Uses an installed gopls and Go toolchain."]
    async fn real_document_highlights_respect_symbol_scope() {
        let scratch = tempfile::tempdir().unwrap();
        let root = scratch.path().canonicalize().unwrap();
        let text = "package main\n\
            type report struct{}\n\
            func (report) sum(value int) int { return value + value }\n\
            func other(value int) int { return value }\n\
            func main() { r := report{}; r.sum(1); r.sum(2); other(3) }\n";
        std::fs::write(
            root.join("go.mod"),
            "module review.test/highlights\n\ngo 1.22\n",
        )
        .unwrap();
        std::fs::write(root.join("main.go"), text).unwrap();
        let (directory, _) = Repository::open_directory(&root, None).unwrap();
        let definitions = Definitions::default();
        let method_call = DefinitionPosition {
            line: 4,
            character: text
                .lines()
                .nth(4)
                .unwrap()
                .find("sum")
                .unwrap()
                .try_into()
                .unwrap(),
        };
        let select = |position| SourcePosition {
            origin: DefinitionOrigin::Workspace {
                path: "main.go".into(),
            },
            position,
            text: text.into(),
        };
        assert!(
            definitions
                .highlights(&root, &directory, select(method_call))
                .await
                .is_empty()
        );
        assert!(matches!(
            query_fixture(&definitions, &root, "main.go", text, method_call).await,
            DefinitionResult::Resolved { .. }
        ));

        for (position, symbol, lines) in [
            (method_call, "sum", vec![2, 4, 4]),
            (
                DefinitionPosition {
                    line: 2,
                    character: 18,
                },
                "value",
                vec![2, 2, 2],
            ),
            (
                DefinitionPosition {
                    line: 3,
                    character: 5,
                },
                "other",
                vec![3, 4],
            ),
        ] {
            let mut highlights = definitions
                .highlights(&root, &directory, select(position))
                .await;
            highlights.sort_by_key(|range| (range.start.line, range.start.character));
            assert_eq!(
                highlights
                    .iter()
                    .map(|range| range.start.line)
                    .collect::<Vec<_>>(),
                lines
            );
            for range in highlights {
                let line = text.lines().nth(range.start.line as usize).unwrap();
                assert_eq!(
                    &line[range.start.character as usize..range.end.character as usize],
                    symbol
                );
            }
        }
    }

    #[test]
    fn definition_locations_accept_lsp_locations_and_selection_links() {
        let response = json!([
            { "uri": "file:///work/a.py", "range": { "start": { "line": 2, "character": 4 } } },
            { "targetUri": "file:///work/b.py", "targetSelectionRange": { "start": { "line": 8, "character": 10 } } },
            { "targetUri": "file:///work/b.py", "targetSelectionRange": { "start": { "line": 8, "character": 10 } } },
            { "uri": "file:///work/c.py", "range": { "start": { "line": -1, "character": 0 } } }
        ]);
        let targets = locations(&response);
        assert_eq!(targets.len(), 2);
        assert_eq!(
            targets[1].1,
            DefinitionPosition {
                line: 8,
                character: 10
            }
        );
        assert!(position_in_text(
            "🦀 symbol",
            DefinitionPosition {
                line: 0,
                character: 3
            }
        ));
        assert!(!position_in_text(
            "🦀",
            DefinitionPosition {
                line: 0,
                character: 2
            }
        ));
    }

    #[derive(Deserialize)]
    struct Fixture {
        name: String,
        root: PathBuf,
        origin: String,
        cases: Vec<FixtureCase>,
    }

    #[derive(Deserialize)]
    struct FixtureCase {
        symbol: String,
        target: String,
        external: bool,
    }

    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "Uses installed language servers and the NODALSTUDIO_LSP_TEST_FIXTURES JSON manifest."]
    async fn real_language_server_definitions() {
        let manifest = std::env::var_os("NODALSTUDIO_LSP_TEST_FIXTURES").expect("fixture manifest");
        let fixtures: Vec<Fixture> =
            serde_json::from_slice(&std::fs::read(manifest).unwrap()).unwrap();
        let mut tasks = tokio::task::JoinSet::new();
        for fixture in fixtures {
            tasks.spawn(check_fixture(fixture));
        }
        let mut passed = true;
        while let Some(result) = tasks.join_next().await {
            passed &= result.unwrap();
        }
        assert!(
            passed,
            "One or more language servers failed the definition fixture"
        );
    }

    async fn check_fixture(fixture: Fixture) -> bool {
        let root = fixture.root.canonicalize().unwrap();
        let definitions = Definitions::default();
        let text = normalize_source(&std::fs::read_to_string(root.join(&fixture.origin)).unwrap());
        for case in fixture.cases {
            let offset = text.find(&case.symbol).expect("symbol at the call site");
            let position = DefinitionPosition {
                line: text[..offset]
                    .bytes()
                    .filter(|byte| *byte == b'\n')
                    .count()
                    .try_into()
                    .unwrap(),
                character: text[..offset]
                    .rsplit('\n')
                    .next()
                    .unwrap()
                    .encode_utf16()
                    .count()
                    .try_into()
                    .unwrap(),
            };
            let result = query_fixture(&definitions, &root, &fixture.origin, &text, position).await;
            let serialized = serde_json::to_string(&result).unwrap();
            let DefinitionResult::Resolved { targets } = result else {
                eprintln!("{} {}: {serialized}", fixture.name, case.symbol);
                return false;
            };
            let Some(target) = targets
                .iter()
                .find(|target| target.path.ends_with(&case.target))
            else {
                eprintln!(
                    "{} {} expected {}: {serialized}",
                    fixture.name, case.symbol, case.target
                );
                return false;
            };
            if case.external != target.source_id.is_some() {
                eprintln!(
                    "{} {} unexpected source kind: {serialized}",
                    fixture.name, case.symbol
                );
                return false;
            }
            let (directory, _) = Repository::open_directory(&root, None).unwrap();
            let source = if let Some(id) = target.source_id {
                definitions.source(&root, &directory, id).await.ok()
            } else {
                read_source(&root, &directory, &root.join(&target.path))
            };
            let Some(source) = source else {
                eprintln!(
                    "{} {} could not open: {serialized}",
                    fixture.name, case.symbol
                );
                return false;
            };
            let definition_line = normalize_source(&source)
                .lines()
                .nth(target.position.line as usize)
                .map(str::to_owned)
                .unwrap_or_default();
            if !definition_line.contains(&case.symbol) {
                eprintln!(
                    "{} {} unexpected line {definition_line:?}: {serialized}",
                    fixture.name, case.symbol
                );
                return false;
            }
            println!(
                "{} {} → {}:{}:{}",
                fixture.name,
                case.symbol,
                target.path,
                target.position.line + 1,
                target.position.character + 1
            );
        }
        true
    }

    async fn query_fixture(
        definitions: &Definitions,
        root: &Path,
        origin: &str,
        text: &str,
        position: DefinitionPosition,
    ) -> DefinitionResult {
        let mut result = DefinitionResult::NotFound;
        for _ in 0..3 {
            let (directory, _) = Repository::open_directory(root, None).unwrap();
            result = definitions
                .lookup(
                    root.to_path_buf(),
                    directory,
                    DefinitionRequest {
                        source: SourcePosition {
                            origin: DefinitionOrigin::Workspace {
                                path: origin.to_owned(),
                            },
                            position,
                            text: text.to_owned(),
                        },
                        enable: true,
                    },
                )
                .await;
            if matches!(
                &result,
                DefinitionResult::Resolved { .. } | DefinitionResult::MissingServer { .. }
            ) {
                break;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        result
    }
}
