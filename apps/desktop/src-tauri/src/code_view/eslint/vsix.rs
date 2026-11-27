//! Read-only client for the `ESLint` language server shipped in the supported VSIX.
use std::{
    io::Write,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tauri::AppHandle;
use tokio::{
    io::BufReader,
    process::{Child, ChildStdin, ChildStdout},
};

use super::{
    CONFIG, EslintReport, Finding, MAX_FINDINGS, MAX_INPUT, MISSING, OUTPUT, Project, STALE, TOOL,
    Tool, project_file, read_bounded,
};
use crate::code_view::{
    extensions,
    language_server::{Language, file_uri, read_frame, write_frame},
};

pub(super) struct Server {
    package: extensions::EslintServer,
    library: PathBuf,
    pub(super) generation: u64,
}

#[derive(Serialize)]
pub(super) struct ServerInfo {
    entry: PathBuf,
    version: String,
}

impl Server {
    pub(super) fn library(&self) -> &Path {
        &self.library
    }

    pub(super) fn info(&self) -> ServerInfo {
        ServerInfo {
            entry: self.package.entry.clone(),
            version: self.package.version.clone(),
        }
    }

    pub(super) fn script_bytes(&self) -> Vec<u8> {
        self.package.script.clone()
    }
}

pub(super) fn stage_script(script: &[u8]) -> Result<tempfile::NamedTempFile, String> {
    let mut file = tempfile::Builder::new()
        .suffix(".cjs")
        .tempfile()
        .map_err(|_| TOOL)?;
    file.write_all(script).map_err(|_| TOOL)?;
    file.flush().map_err(|_| TOOL)?;
    Ok(file)
}

pub(super) fn select_server(
    handle: &AppHandle,
    project: &Project,
    sha256: &str,
    mut tool: Tool,
) -> Result<Tool, String> {
    let generation = project
        .eslint
        .0
        .lock()
        .map_err(|_| TOOL)?
        .extension_generation;
    let package = extensions::eslint_server(handle, project.key(), sha256).map_err(|_| STALE)?;
    let package_dir = tool.entry.parent().and_then(Path::parent).ok_or(MISSING)?;
    let root = project.root.canonicalize().map_err(|_| STALE)?;
    let library = project_file(&package_dir.join("lib/api.js"), &root).ok_or(MISSING)?;
    let library_digest = Sha256::digest(read_bounded(&library, MAX_INPUT)?);
    let fingerprint =
        serde_json::to_vec(&(&package.entry, &library, sha256, generation)).map_err(|_| TOOL)?;
    let combine = |value: &str| {
        let mut digest = Sha256::new();
        digest.update(value);
        digest.update(&fingerprint);
        digest.update(library_digest);
        format!("{:x}", digest.finalize())
    };
    tool.identity = combine(&tool.identity);
    tool.context = combine(&tool.context);
    tool.extension = Some(Server {
        package,
        library,
        generation,
    });
    Ok(tool)
}

struct Connection<'a> {
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    uri: &'a str,
    folder: Value,
    settings: Value,
    library: &'a Path,
    library_loaded: bool,
    validated: bool,
}

impl Connection<'_> {
    async fn send(&mut self, message: Value) -> Result<(), String> {
        write_frame(&mut self.input, &message)
            .await
            .map_err(|_| OUTPUT.into())
    }

    async fn request(&mut self, id: u32, method: &str, params: Value) -> Result<Value, String> {
        self.send(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))
            .await?;
        for _ in 0..256 {
            let message = read_frame(&mut self.output).await.map_err(|_| OUTPUT)?;
            if let Some(method) = message["method"].as_str() {
                if let Some(id) = message.get("id") {
                    self.reply(id, method, &message["params"]).await?;
                } else {
                    self.observe(method, &message["params"])?;
                }
            } else if message["id"].as_u64() == Some(id.into()) {
                return message.get("result").cloned().ok_or_else(|| OUTPUT.into());
            }
        }
        Err(OUTPUT.into())
    }

    async fn reply(&mut self, id: &Value, method: &str, params: &Value) -> Result<(), String> {
        let result = match method {
            "workspace/configuration" => {
                let items = params["items"].as_array().ok_or(OUTPUT)?;
                Value::Array(
                    items
                        .iter()
                        .map(|item| {
                            if item["scopeUri"].as_str() == Some(self.uri)
                                && item["section"].as_str().is_none_or(str::is_empty)
                            {
                                self.settings.clone()
                            } else {
                                Value::Null
                            }
                        })
                        .collect(),
                )
            }
            "workspace/workspaceFolders" => json!([self.folder]),
            "workspace/applyEdit" => json!({ "applied": false }),
            "client/registerCapability"
            | "client/unregisterCapability"
            | "workspace/diagnostic/refresh" => Value::Null,
            "eslint/noLibrary" => return Err(MISSING.into()),
            "eslint/noConfig" => return Err(CONFIG.into()),
            _ => {
                return self.send(json!({
                    "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "Method unavailable" }
                })).await;
            }
        };
        self.send(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
            .await
    }

    fn observe(&mut self, method: &str, params: &Value) -> Result<(), String> {
        if method == "eslint/status" && params["uri"].as_str() == Some(self.uri) {
            if params["state"].as_u64() != Some(1) {
                return Err(CONFIG.into());
            }
            self.validated = true;
        }
        if method == "window/logMessage"
            && let Some(path) = params["message"]
                .as_str()
                .and_then(|message| message.strip_prefix("ESLint library loaded from: "))
        {
            if Path::new(path) != self.library {
                return Err(STALE.into());
            }
            self.library_loaded = true;
        }
        Ok(())
    }
}

pub(super) async fn lint(
    mut child: Child,
    tool: &Tool,
    server: &Server,
    text: String,
    limit: usize,
) -> Result<EslintReport, String> {
    let root = file_uri(&tool.cwd).ok_or(OUTPUT)?;
    let uri = file_uri(&tool.file).ok_or(OUTPUT)?;
    let (_, language_id) = Language::for_path(&tool.file).ok_or(OUTPUT)?;
    let folder = json!({
        "uri": root.as_str(), "name": tool.cwd.file_name().unwrap_or_default().to_string_lossy(),
    });
    let package_modules = server.library.ancestors().nth(3).ok_or(MISSING)?;
    let mut connection = Connection {
        input: child.stdin.take().ok_or(TOOL)?,
        output: BufReader::new(child.stdout.take().ok_or(TOOL)?),
        uri: uri.as_str(),
        settings: json!({
            "validate": "on", "format": false, "useESLintClass": true, "useFlatConfig": true,
            "onIgnoredFiles": "warn", "workspaceFolder": folder,
            "workingDirectory": { "directory": tool.cwd, "!cwd": false },
            "nodePath": package_modules,
            "options": { "cwd": tool.cwd, "overrideConfigFile": tool.config },
        }),
        folder,
        library: &server.library,
        library_loaded: false,
        validated: false,
    };
    let initialized = connection
        .request(
            1,
            "initialize",
            json!({
                "processId": std::process::id(),
                "rootUri": root.as_str(), "workspaceFolders": [connection.folder],
                "capabilities": {
                    "general": { "positionEncodings": ["utf-16"] },
                    "workspace": { "configuration": true, "workspaceFolders": true },
                    "textDocument": { "diagnostic": {} },
                },
            }),
        )
        .await?;
    if initialized["capabilities"]["diagnosticProvider"]["identifier"].as_str() != Some("eslint") {
        return Err(OUTPUT.into());
    }
    connection
        .send(json!({ "jsonrpc": "2.0", "method": "initialized", "params": {} }))
        .await?;
    connection.send(json!({
        "jsonrpc": "2.0", "method": "textDocument/didOpen",
        "params": { "textDocument": { "uri": uri.as_str(), "languageId": language_id, "version": 1, "text": text } },
    })).await?;
    let report = connection
        .request(
            2,
            "textDocument/diagnostic",
            json!({
                "textDocument": { "uri": uri.as_str() }, "identifier": "eslint",
            }),
        )
        .await?;
    if !connection.library_loaded || !connection.validated {
        return Err(OUTPUT.into());
    }
    decode_report(report, limit)
}

#[derive(Deserialize)]
struct Diagnostic {
    source: String,
    message: String,
    code: Option<Value>,
    severity: u8,
    range: Range,
}

#[derive(Deserialize)]
struct Range {
    start: Position,
    end: Position,
}

#[derive(Deserialize)]
struct Position {
    line: usize,
    character: usize,
}

fn decode_report(mut report: Value, limit: usize) -> Result<EslintReport, String> {
    if report["kind"].as_str() != Some("full") {
        return Err(OUTPUT.into());
    }
    let items = report.get_mut("items").ok_or(OUTPUT)?.take();
    let diagnostics: Vec<Diagnostic> = serde_json::from_value(items).map_err(|_| OUTPUT)?;
    if diagnostics
        .iter()
        .any(|item| item.source != "eslint" || !matches!(item.severity, 1 | 2))
    {
        return Err(OUTPUT.into());
    }
    let ignored = matches!(diagnostics.as_slice(), [item] if item.code.is_none() && item.message.starts_with("File ignored"));
    let total = if ignored { 0 } else { diagnostics.len() };
    let findings = diagnostics
        .into_iter()
        .take(total.min(limit).min(MAX_FINDINGS))
        .map(|item| Finding {
            rule_id: item.code.and_then(|code| match code {
                Value::String(rule) => Some(rule),
                Value::Number(rule) => Some(rule.to_string()),
                _ => None,
            }),
            severity: if item.severity == 1 { 2 } else { 1 },
            fatal: None,
            message: item.message,
            line: item.range.start.line.checked_add(1),
            column: item.range.start.character.checked_add(1),
            end_line: item.range.end.line.checked_add(1),
            end_column: item.range.end.character.checked_add(1),
        })
        .collect();
    Ok(EslintReport {
        ignored,
        findings,
        total,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_eslint_lsp_severity_and_utf16_positions_for_the_checks_panel() {
        let report = decode_report(json!({
            "kind": "full",
            "items": [{
                "source": "eslint", "severity": 1, "message": "Unused constant",
                "range": { "start": { "line": 6, "character": 8 }, "end": { "line": 6, "character": 17 } },
                "code": "@typescript-eslint/no-unused-vars",
            }],
        }), 1).unwrap();
        assert_eq!(report.total, 1);
        let finding = &report.findings[0];
        assert_eq!(finding.severity, 2);
        assert_eq!(finding.line, Some(7));
        assert_eq!(finding.column, Some(9));
        assert_eq!(finding.end_column, Some(18));
        assert_eq!(
            finding.rule_id.as_deref(),
            Some("@typescript-eslint/no-unused-vars")
        );
    }
}
