//! Mac App Store imports pinned `TextMate` JSON resources from Open VSX.
use std::{fs, path::Path, time::Duration};

use reqwest::{Client, redirect};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, State};
use uuid::Uuid;

use super::{
    Extension, MAX_ENTRY, PackageSource, Receipt, ReviewState, STORAGE, UNSUPPORTED,
    install_staged, installation, online, while_online, with_storage_write,
};
use crate::AppState;

const NETWORK: &str = "openVsxNetwork";
const INTEGRITY: &str = "openVsxIntegrity";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyntaxSource {
    id: &'static str,
    name: &'static str,
    version: &'static str,
    #[serde(skip)]
    language: &'static str,
    #[serde(skip)]
    scope: &'static str,
    #[serde(skip)]
    extensions: &'static [&'static str],
    #[serde(skip)]
    resource: &'static str,
    #[serde(skip)]
    sha256: &'static str,
}

static CATALOG: &[SyntaxSource] = &[
    SyntaxSource {
        id: "4ops.terraform",
        name: "Terraform",
        version: "0.2.1",
        language: "tf",
        scope: "source.tf",
        extensions: &[".tf"],
        resource: "https://open-vsx.org/vscode/unpkg/4ops/terraform/0.2.1/extension/grammars/tf.json",
        sha256: "0c48838a36ce97a8e1fc146d48a6539f1711edf0295132422e20fbbff5a806d5",
    },
    SyntaxSource {
        id: "tamasfe.even-better-toml",
        name: "TOML",
        version: "0.21.2",
        language: "toml",
        scope: "source.toml",
        extensions: &[".toml"],
        resource: "https://open-vsx.org/vscode/unpkg/tamasfe/even-better-toml/0.21.2/extension/toml.tmLanguage.json",
        sha256: "535d51829eee1b852589f501344d88348aa0b8a630285406f004cc51de656a33",
    },
];

fn syntax_source(id: &str) -> Result<&'static SyntaxSource, String> {
    CATALOG
        .iter()
        .find(|item| item.id == id)
        .ok_or_else(|| UNSUPPORTED.into())
}

fn verify_grammar(source: &SyntaxSource, bytes: &[u8]) -> Result<(), String> {
    if bytes.len() as u64 > MAX_ENTRY || format!("{:x}", Sha256::digest(bytes)) != source.sha256 {
        return Err(INTEGRITY.into());
    }
    let grammar: Value = serde_json::from_slice(bytes).map_err(|_| INTEGRITY)?;
    if grammar["scopeName"] != source.scope || !grammar["patterns"].is_array() {
        return Err(INTEGRITY.into());
    }
    Ok(())
}

async fn download(source: &SyntaxSource) -> Result<Vec<u8>, String> {
    let client = Client::builder()
        .redirect(redirect::Policy::none())
        .timeout(Duration::from_secs(25))
        .build()
        .map_err(|_| NETWORK)?;
    let mut response = client
        .get(source.resource)
        .send()
        .await
        .map_err(|_| NETWORK)?;
    if !response.status().is_success() {
        return Err(NETWORK.into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| NETWORK)? {
        if bytes.len().saturating_add(chunk.len()) as u64 > MAX_ENTRY {
            return Err(INTEGRITY.into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn import_grammar(
    root: &Path,
    key: &str,
    source: &SyntaxSource,
    bytes: &[u8],
) -> Result<Extension, String> {
    verify_grammar(source, bytes)?;
    let (publisher, name) = source.id.split_once('.').ok_or(INTEGRITY)?;
    let (_, file_name) = source.resource.rsplit_once('/').ok_or(INTEGRITY)?;
    let stage = tempfile::tempdir_in(root).map_err(|_| STORAGE)?;
    let content = stage.path().join("extension");
    fs::create_dir(&content).map_err(|_| STORAGE)?;
    fs::write(content.join("grammar.json"), bytes).map_err(|_| STORAGE)?;
    // Generate local tokenizer metadata rather than importing an extension manifest.
    let manifest = json!({
        "publisher": publisher, "name": name, "displayName": source.name,
        "version": source.version, "engines": { "vscode": "*" },
        "contributes": {
            "languages": [{ "id": source.language, "aliases": [source.name], "extensions": source.extensions }],
            "grammars": [{ "language": source.language, "scopeName": source.scope, "path": "grammar.json" }]
        }
    });
    fs::write(content.join("package.json"), manifest.to_string()).map_err(|_| STORAGE)?;
    let receipt = Receipt {
        file_name: file_name.into(),
        sha256: source.sha256.into(),
        source: PackageSource::OpenVsxSyntax,
    };
    let receipt = serde_json::to_vec(&receipt).map_err(|_| STORAGE)?;
    fs::write(stage.path().join("installation.json"), receipt).map_err(|_| STORAGE)?;
    let grammar = installation(stage.path(), key)?;
    let installed = install_staged(root, stage.path(), key, grammar)?;
    let _ = stage.keep();
    Ok(installed)
}

#[tauri::command]
pub(crate) fn list_code_syntax_catalog() -> &'static [SyntaxSource] {
    CATALOG
}

#[tauri::command]
pub(crate) async fn import_code_syntax(
    handle: AppHandle,
    app: State<'_, AppState>,
    review: State<'_, ReviewState>,
    project_id: Uuid,
    id: String,
) -> Result<Extension, String> {
    let source = syntax_source(&id)?;
    review.project(project_id)?;
    let data = while_online(&app, download(source)).await?;
    online(&app).await?;
    with_storage_write(handle, &review, project_id, move |root, key| {
        import_grammar(root, key, source, &data)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::code_view::extensions::{Capability, installed_paths};

    const FIXTURE: &[u8] = br#"{"scopeName":"source.toml","patterns":[]}"#;

    #[test]
    fn only_catalog_ids_are_resolved_as_download_targets() {
        assert_eq!(syntax_source("4ops.terraform").unwrap().scope, "source.tf");
        assert!(syntax_source("ms-python.debugpy").is_err());
        assert!(syntax_source("https://open-vsx.org/example.vsix").is_err());
    }

    #[test]
    fn import_stores_only_grammar_data_and_preserves_project_enablement() {
        let root = tempfile::tempdir().unwrap();
        let source = SyntaxSource {
            sha256: "83819730d2d5d717dc6ae30cad6dd56ece4d396aabe23d39765999ddfb3f6e14",
            ..*syntax_source("tamasfe.even-better-toml").unwrap()
        };
        assert!(import_grammar(root.path(), "project-a", &source, b"script()").is_err());
        assert!(installed_paths(root.path()).unwrap().is_empty());
        let installed = import_grammar(root.path(), "project-a", &source, FIXTURE).unwrap();
        assert_eq!(installed.capability, Capability::Syntax);
        assert!(installed.enabled);
        let destination = root.path().join(source.id);
        assert!(!installation(&destination, "project-b").unwrap().enabled);
        let content = destination.join("extension");
        assert_eq!(fs::read(content.join("grammar.json")).unwrap(), FIXTURE);
        assert_eq!(fs::read_dir(content).unwrap().count(), 2);
        assert!(import_grammar(root.path(), "project-a", &source, FIXTURE).is_err());
    }
}
