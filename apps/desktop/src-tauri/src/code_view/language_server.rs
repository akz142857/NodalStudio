use std::{
    collections::VecDeque,
    env,
    ffi::OsString,
    io,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::Duration,
};

use reqwest::Url;
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{Mutex, mpsc},
    task::JoinHandle,
    time::timeout,
};

const MAX_FRAME: usize = 16 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(25);

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(super) enum Language {
    Go,
    Java,
    Php,
    Python,
    TypeScript,
    Rust,
    Clang,
    CSharp,
    Swift,
}

impl Language {
    pub(super) fn for_path(path: &Path) -> Option<(Self, &'static str)> {
        Some(
            match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
                "go" => (Self::Go, "go"),
                "java" => (Self::Java, "java"),
                "php" | "phtml" => (Self::Php, "php"),
                "py" | "pyw" | "pyi" => (Self::Python, "python"),
                "js" | "cjs" | "mjs" => (Self::TypeScript, "javascript"),
                "jsx" => (Self::TypeScript, "javascriptreact"),
                "ts" | "cts" | "mts" => (Self::TypeScript, "typescript"),
                "tsx" => (Self::TypeScript, "typescriptreact"),
                "rs" => (Self::Rust, "rust"),
                "c" => (Self::Clang, "c"),
                "cc" | "cpp" | "cxx" | "c++" | "h" | "hh" | "hpp" | "hxx" | "ixx" => {
                    (Self::Clang, "cpp")
                }
                "cs" => (Self::CSharp, "csharp"),
                "swift" | "swiftinterface" => (Self::Swift, "swift"),
                _ => return None,
            },
        )
    }

    pub(super) fn command(self) -> (&'static str, &'static str) {
        match self {
            Self::Go => ("gopls", "NODALSTUDIO_LSP_GO"),
            Self::Java => ("jdtls", "NODALSTUDIO_LSP_JAVA"),
            Self::Php => ("intelephense", "NODALSTUDIO_LSP_PHP"),
            Self::Python => ("pyright-langserver", "NODALSTUDIO_LSP_PYTHON"),
            Self::TypeScript => ("typescript-language-server", "NODALSTUDIO_LSP_TYPESCRIPT"),
            Self::Rust => ("rust-analyzer", "NODALSTUDIO_LSP_RUST"),
            Self::Clang => ("clangd", "NODALSTUDIO_LSP_CLANG"),
            Self::CSharp => ("roslyn-language-server", "NODALSTUDIO_LSP_CSHARP"),
            Self::Swift => ("sourcekit-lsp", "NODALSTUDIO_LSP_SWIFT"),
        }
    }

    pub(super) fn workspace_root(self, root: &Path, file: &Path) -> PathBuf {
        let markers: &[&str] = match self {
            Self::Go => &["go.mod", "go.work"],
            Self::TypeScript => &["tsconfig.json", "jsconfig.json", "package.json"],
            Self::Rust => &["Cargo.toml"],
            Self::Swift => &["Package.swift", "buildServer.json"],
            Self::Clang => &[
                "compile_commands.json",
                "compile_flags.txt",
                "build/compile_commands.json",
            ],
            _ => &[],
        };
        if markers.is_empty() {
            return root.to_path_buf();
        }
        let ancestors = || file.ancestors().skip(1).take_while(|p| p.starts_with(root));
        if self == Self::Go
            && let Some(workspace) = ancestors().find(|p| p.join("go.work").is_file())
        {
            return workspace.to_path_buf();
        }
        ancestors()
            .find(|dir| markers.iter().any(|marker| dir.join(marker).is_file()))
            .unwrap_or(root)
            .to_path_buf()
    }

    fn settings(self) -> Value {
        match self {
            Self::Java => json!({ "java": { "autobuild": { "enabled": false } } }),
            Self::Rust => json!({ "rust-analyzer": {
                "checkOnSave": false, "cargo": { "buildScripts": { "enable": false } },
                "procMacro": { "enable": false }
            } }),
            _ => json!({}),
        }
    }
}

pub(super) fn file_uri(path: &Path) -> Option<Url> {
    Url::from_file_path(path).ok()
}

fn server_executables(
    language: Language,
    root: &Path,
) -> Result<(Vec<PathBuf>, OsString), ServerError> {
    let (name, override_key) = language.command();
    let mut directories: Vec<PathBuf> = env::var_os("PATH").map_or_else(Vec::new, |path| {
        env::split_paths(&path)
            .filter(|p| p.is_absolute() && !p.starts_with(root))
            .collect()
    });
    let home = env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" });
    if let Some(home) = home {
        let home = PathBuf::from(home);
        directories.extend(
            ["go/bin", ".cargo/bin", ".dotnet/tools", ".local/bin"].map(|dir| home.join(dir)),
        );
    }
    #[cfg(unix)]
    directories.extend(
        [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/local/go/bin",
            "/usr/bin",
            "/bin",
        ]
        .map(PathBuf::from),
    );
    let explicit = env::var_os(override_key).map(PathBuf::from);
    let executables: Vec<PathBuf> = if let Some(explicit) = explicit {
        usable_executable(&explicit, root)
            .then_some(explicit)
            .into_iter()
            .collect()
    } else {
        let names: &[&str] = if language == Language::TypeScript {
            &["tsgo", name, "tsc"]
        } else {
            &[name]
        };
        names
            .iter()
            .filter_map(|name| {
                directories
                    .iter()
                    .flat_map(|dir| {
                        let path = dir.join(name);
                        if cfg!(windows) {
                            vec![
                                path.with_extension("exe"),
                                path.with_extension("cmd"),
                                path.with_extension("bat"),
                            ]
                        } else {
                            vec![path]
                        }
                    })
                    .find(|path| {
                        usable_executable(path, root)
                            && (*name != "tsc" || !legacy_typescript_compiler(path))
                    })
            })
            .collect()
    };
    if executables.is_empty() {
        return Err(ServerError::Missing);
    }
    Ok((
        executables,
        env::join_paths(directories).map_err(|_| ServerError::Transport)?,
    ))
}

fn usable_executable(path: &Path, root: &Path) -> bool {
    path.is_absolute()
        && path.is_file()
        && path
            .canonicalize()
            .is_ok_and(|resolved| !resolved.starts_with(root))
}

fn legacy_typescript_compiler(path: &Path) -> bool {
    let Ok(executable) = path.canonicalize() else {
        return false;
    };
    let Some(package) = executable.parent().and_then(Path::parent) else {
        return false;
    };
    let Ok(manifest) = std::fs::File::open(package.join("package.json")) else {
        return false;
    };
    let Ok(package) = serde_json::from_reader::<_, Value>(std::io::Read::take(manifest, 64 * 1024))
    else {
        return false;
    };
    package["name"].as_str() == Some("typescript")
        && package["version"]
            .as_str()
            .and_then(|version| semver::Version::parse(version).ok())
            .is_some_and(|version| version.major < 7)
}

#[derive(Debug)]
pub(super) enum ServerError {
    Missing,
    Transport,
    Request,
}

pub(super) struct LanguageServer {
    connection: Connection,
    opened: VecDeque<(Url, String)>,
}

impl LanguageServer {
    pub(super) async fn start(
        language: Language,
        root: &Path,
        project_root: &Path,
    ) -> Result<Self, ServerError> {
        let (executables, search_path) = server_executables(language, project_root)?;
        let mut failure = ServerError::Transport;
        for executable in executables {
            match Self::start_with(language, root, &executable, &search_path).await {
                Ok(server) => return Ok(server),
                Err(error) => failure = error,
            }
        }
        Err(failure)
    }

    async fn start_with(
        language: Language,
        root: &Path,
        executable: &Path,
        search_path: &std::ffi::OsStr,
    ) -> Result<Self, ServerError> {
        let root_uri = file_uri(root).ok_or(ServerError::Transport)?;
        let folders = json!([{ "uri": root_uri.as_str(), "name": root.file_name().and_then(|name| name.to_str()).unwrap_or("Project") }]);
        let settings = language.settings();
        let mut connection = Connection::start(
            language,
            root,
            executable,
            search_path,
            folders.clone(),
            settings.clone(),
        )?;
        let options = match language {
            Language::Java => json!({
                "workspaceFolders": [root_uri.as_str()],
                "extendedClientCapabilities": { "classFileContentsSupport": true },
                "settings": settings
            }),
            Language::Php => json!({
                "storagePath": connection.scratch.path(),
                "globalStoragePath": connection.scratch.path()
            }),
            Language::CSharp => json!({ "autoLoadProjects": 100 }),
            Language::TypeScript => json!({ "disableAutomaticTypingAcquisition": true }),
            _ => Value::Null,
        };
        let initialized = connection
            .request(
                "initialize",
                json!({
                    "processId": std::process::id(),
                    "clientInfo": { "name": "Nodal Studio" },
                    "rootUri": root_uri.as_str(),
                    "workspaceFolders": folders,
                    "initializationOptions": options,
                    "capabilities": {
                        "general": { "positionEncodings": ["utf-16"] },
                        "workspace": { "configuration": true, "workspaceFolders": true },
                        "textDocument": { "definition": { "linkSupport": true }, "documentHighlight": {},
                            "documentSymbol": { "hierarchicalDocumentSymbolSupport": true } },
                        "experimental": { "sourcekit/workspace/getReferenceDocument": true }
                    }
                }),
            )
            .await?;
        if initialized
            .pointer("/capabilities/positionEncoding")
            .and_then(Value::as_str)
            .is_some_and(|encoding| encoding != "utf-16")
        {
            return Err(ServerError::Request);
        }
        connection.notify("initialized", json!({})).await?;
        if !settings.as_object().is_some_and(serde_json::Map::is_empty) {
            connection
                .notify(
                    "workspace/didChangeConfiguration",
                    json!({ "settings": settings }),
                )
                .await?;
        }
        Ok(Self {
            connection,
            opened: VecDeque::new(),
        })
    }

    pub(super) async fn open(
        &mut self,
        uri: &Url,
        language: &str,
        text: &str,
    ) -> Result<(), ServerError> {
        if let Some(index) = self.opened.iter().position(|(opened, _)| opened == uri) {
            let (_, previous) = self.opened.remove(index).ok_or(ServerError::Transport)?;
            if previous == text {
                self.opened.push_back((uri.clone(), previous));
                return Ok(());
            }
            self.close(uri).await?;
        }
        if self.opened.len() == 8
            && let Some((old, _)) = self.opened.pop_front()
        {
            self.close(&old).await?;
        }
        self.connection.notify("textDocument/didOpen", json!({
            "textDocument": { "uri": uri.as_str(), "languageId": language, "version": 1, "text": text }
        })).await?;
        self.opened.push_back((uri.clone(), text.to_owned()));
        Ok(())
    }

    async fn close(&mut self, uri: &Url) -> Result<(), ServerError> {
        self.connection
            .notify(
                "textDocument/didClose",
                json!({ "textDocument": { "uri": uri.as_str() } }),
            )
            .await
    }

    pub(super) async fn request(
        &mut self,
        method: &str,
        params: Value,
    ) -> Result<Value, ServerError> {
        self.connection.request(method, params).await
    }
}

struct Connection {
    child: Child,
    writer: Arc<Mutex<ChildStdin>>,
    responses: mpsc::Receiver<Value>,
    reader: JoinHandle<()>,
    scratch: tempfile::TempDir,
    next_id: u64,
}

impl Connection {
    fn start(
        language: Language,
        root: &Path,
        executable: &Path,
        search_path: &std::ffi::OsStr,
        folders: Value,
        settings: Value,
    ) -> Result<Self, ServerError> {
        let scratch = tempfile::tempdir().map_err(|_| ServerError::Transport)?;
        let mut process = Command::new(executable);
        process
            .current_dir(root)
            .env("PATH", search_path)
            .kill_on_drop(true)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        match language {
            Language::Java => {
                process
                    .arg("-configuration")
                    .arg(scratch.path().join("config"))
                    .arg("-data")
                    .arg(scratch.path().join("workspace"))
                    .env_remove("CLIENT_PORT")
                    .env_remove("CLIENT_HOST");
            }
            Language::TypeScript => {
                if matches!(
                    executable.file_stem().and_then(std::ffi::OsStr::to_str),
                    Some("tsc" | "tsgo")
                ) {
                    process.arg("--lsp");
                }
                process.arg("--stdio");
            }
            Language::Php | Language::Python => {
                process.arg("--stdio");
            }
            Language::CSharp => {
                process.args(["--stdio", "--telemetryLevel", "off"]);
            }
            Language::Go | Language::Rust | Language::Clang | Language::Swift => {}
        }
        let mut child = process.spawn().map_err(|_| ServerError::Transport)?;
        let stdin = child.stdin.take().ok_or(ServerError::Transport)?;
        let mut stdout = BufReader::new(child.stdout.take().ok_or(ServerError::Transport)?);
        let writer = Arc::new(Mutex::new(stdin));
        let reply_writer = Arc::clone(&writer);
        let (send, responses) = mpsc::channel(16);
        let reader = tokio::spawn(async move {
            while let Ok(message) = read_frame(&mut stdout).await {
                let Some(id) = message.get("id") else {
                    continue;
                };
                if let Some(method) = message.get("method").and_then(Value::as_str) {
                    let reply = server_reply(id, method, &message["params"], &folders, &settings);
                    if write_frame(&mut *reply_writer.lock().await, &reply)
                        .await
                        .is_err()
                    {
                        break;
                    }
                } else if send.send(message).await.is_err() {
                    break;
                }
            }
        });
        Ok(Self {
            child,
            writer,
            responses,
            reader,
            scratch,
            next_id: 0,
        })
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<Value, ServerError> {
        self.next_id += 1;
        let id = self.next_id;
        timeout(REQUEST_TIMEOUT, async {
            self.send(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))
                .await?;
            while let Some(reply) = self.responses.recv().await {
                if reply["id"].as_u64() != Some(id) {
                    continue;
                }
                return if reply.get("error").is_some() {
                    Err(ServerError::Request)
                } else {
                    Ok(reply["result"].clone())
                };
            }
            Err(ServerError::Transport)
        })
        .await
        .map_err(|_| ServerError::Transport)?
    }

    async fn notify(&mut self, method: &str, params: Value) -> Result<(), ServerError> {
        timeout(
            REQUEST_TIMEOUT,
            self.send(&json!({ "jsonrpc": "2.0", "method": method, "params": params })),
        )
        .await
        .map_err(|_| ServerError::Transport)?
    }

    async fn send(&self, value: &Value) -> Result<(), ServerError> {
        write_frame(&mut *self.writer.lock().await, value)
            .await
            .map_err(|_| ServerError::Transport)
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        self.reader.abort();
        let _ = self.child.start_kill();
    }
}

fn server_reply(
    id: &Value,
    method: &str,
    params: &Value,
    folders: &Value,
    settings: &Value,
) -> Value {
    let result = match method {
        "workspace/configuration" => {
            let section = |item: &Value| {
                item["section"]
                    .as_str()
                    .filter(|name| !name.is_empty())
                    .map_or_else(
                        || settings.clone(),
                        |path| {
                            path.split('.')
                                .fold(settings, |value, key| &value[key])
                                .clone()
                        },
                    )
            };
            Value::Array(
                params["items"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(section)
                    .collect(),
            )
        }
        "workspace/workspaceFolders" => folders.clone(),
        "workspace/applyEdit" => json!({ "applied": false }),
        "client/registerCapability"
        | "client/unregisterCapability"
        | "window/workDoneProgress/create"
        | "window/showMessageRequest" => Value::Null,
        _ => {
            return json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "Method not supported" } });
        }
    };
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

async fn read_frame(reader: &mut (impl tokio::io::AsyncBufRead + Unpin)) -> io::Result<Value> {
    let mut length = None;
    let mut budget = 8192;
    loop {
        let mut header = String::new();
        let bytes = reader.take(budget).read_line(&mut header).await?;
        if bytes == 0 || bytes as u64 == budget {
            return Err(io::ErrorKind::InvalidData.into());
        }
        budget -= bytes as u64;
        let line = header.trim_end_matches(['\r', '\n']);
        if line.is_empty() && length.is_some() {
            break;
        }
        if let Some((key, value)) = line.split_once(':')
            && key.eq_ignore_ascii_case("Content-Length")
        {
            length = value
                .trim()
                .parse::<usize>()
                .ok()
                .filter(|len| *len <= MAX_FRAME);
            if length.is_none() {
                return Err(io::ErrorKind::InvalidData.into());
            }
        }
    }
    let mut data = vec![0; length.ok_or(io::ErrorKind::InvalidData)?];
    reader.read_exact(&mut data).await?;
    Ok(serde_json::from_slice(&data)?)
}

async fn write_frame(
    writer: &mut (impl tokio::io::AsyncWrite + Unpin),
    value: &Value,
) -> io::Result<()> {
    let body = serde_json::to_vec(value)?;
    writer
        .write_all(format!("Content-Length: {}\r\n\r\n", body.len()).as_bytes())
        .await?;
    writer.write_all(&body).await?;
    writer.flush().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_legacy_typescript_compilers_but_keeps_native_compilers() {
        let directory = tempfile::tempdir().unwrap();
        let manifest = directory.path().join("package.json");
        let bin = directory.path().join("bin");
        std::fs::create_dir(&bin).unwrap();
        let compiler = bin.join("tsc");
        std::fs::write(&compiler, "").unwrap();
        std::fs::write(&manifest, r#"{"name":"typescript","version":"5.9.3"}"#).unwrap();
        assert!(legacy_typescript_compiler(&compiler));
        std::fs::write(&manifest, r#"{"name":"typescript","version":"7.0.2"}"#).unwrap();
        assert!(!legacy_typescript_compiler(&compiler));
    }

    #[test]
    fn typescript_uses_the_nearest_package_inside_the_review_root() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let package = root.join("apps/frontend");
        let source = package.join("src");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(package.join("tsconfig.json"), "{}").unwrap();
        std::fs::write(root.join("package.json"), "{}").unwrap();
        assert_eq!(
            Language::TypeScript.workspace_root(root, &source.join("App.tsx")),
            package
        );
        assert_eq!(
            Language::TypeScript.workspace_root(root, &root.join("tool.js")),
            root
        );
    }
}
