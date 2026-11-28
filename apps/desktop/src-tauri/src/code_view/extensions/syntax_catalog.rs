//! Curated `TextMate` data embedded in the application.
use std::{fs, path::Path};

use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, State};
use uuid::Uuid;

use super::{
    CHANGED, Capability, Extension, GrammarDependency, MAX_ENTRY, PackageSource, Receipt,
    ReviewState, STORAGE, UNSUPPORTED, enable_for_project, install_staged, installation,
    with_storage_write,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyntaxSource {
    id: &'static str,
    name: &'static str,
    version: &'static str,
    extensions: &'static [&'static str],
    filenames: &'static [&'static str],
    filename_patterns: &'static [&'static str],
    #[serde(skip)]
    language: &'static str,
    #[serde(skip)]
    scope: &'static str,
    #[serde(skip)]
    grammar: &'static [u8],
    #[serde(skip)]
    sha256: &'static str,
}

static CATALOG: &[SyntaxSource] = &[
    SyntaxSource {
        id: "nodalstudio.c-syntax",
        name: "C",
        version: "1.95.3",
        extensions: &[".c", ".h"],
        filenames: &[],
        filename_patterns: &[],
        language: "c",
        scope: "source.c",
        grammar: include_bytes!("grammars/c.json"),
        sha256: "9d0a305bc6595526ffc0680eccbf23a12512ded99a632d9f1deab3ce81b62957",
    },
    SyntaxSource {
        id: "vscode.csharp",
        name: "C#",
        version: "1.95.3",
        extensions: &[".cs", ".csx"],
        filenames: &[],
        filename_patterns: &[],
        language: "csharp",
        scope: "source.cs",
        grammar: include_bytes!("grammars/csharp.json"),
        sha256: "962afb6b2a552b167df50e00cf41605a351efebb509914ad4bf0f7d1a99c1a12",
    },
    SyntaxSource {
        id: "vscode.cpp",
        name: "C++",
        version: "1.95.3",
        extensions: &[
            ".cpp", ".cxx", ".cc", ".c++", ".hpp", ".hxx", ".hh", ".h++", ".ipp", ".inl", ".ixx",
            ".cppm",
        ],
        filenames: &[],
        filename_patterns: &[],
        language: "cpp",
        scope: "source.cpp",
        grammar: include_bytes!("grammars/cpp.json"),
        sha256: "82b39c8f2aec095b45a287ab155fcf868c197b216ba8d6fe0c95674b82863182",
    },
    SyntaxSource {
        id: "vscode.css",
        name: "CSS",
        version: "1.95.3",
        extensions: &[".css"],
        filenames: &[],
        filename_patterns: &[],
        language: "css",
        scope: "source.css",
        grammar: include_bytes!("grammars/css.json"),
        sha256: "ce2dd0dc1a241d64321e60d6fe3a37558796fb03e7d3d10e112441f1dc154c63",
    },
    SyntaxSource {
        id: "vscode.docker",
        name: "Dockerfile",
        version: "1.95.3",
        extensions: &[".dockerfile", ".containerfile"],
        filenames: &["Dockerfile", "dockerfile", "Containerfile", "containerfile"],
        filename_patterns: &["Dockerfile.*", "Containerfile.*"],
        language: "dockerfile",
        scope: "source.dockerfile",
        grammar: include_bytes!("grammars/dockerfile.json"),
        sha256: "99ae6173ae9152034e35e17de092f4e11273acefb82320592bbfa627a29bb03c",
    },
    SyntaxSource {
        id: "vscode.groovy",
        name: "Groovy",
        version: "1.95.3",
        extensions: &[".groovy", ".gvy", ".gradle"],
        filenames: &["Jenkinsfile"],
        filename_patterns: &[],
        language: "groovy",
        scope: "source.groovy",
        grammar: include_bytes!("grammars/groovy.json"),
        sha256: "7e61dc6646a8e931d838d0fc62fc3408749f21aeeb989431b87d49c51b559b5f",
    },
    SyntaxSource {
        id: "vscode.html",
        name: "HTML",
        version: "1.95.3",
        extensions: &[".html", ".htm", ".xhtml"],
        filenames: &[],
        filename_patterns: &[],
        language: "html",
        scope: "text.html.basic",
        grammar: include_bytes!("grammars/html.json"),
        sha256: "80dedf4fb27e88889ac8fb72763954a6d2660502c686f4415208d8c8d00352cd",
    },
    SyntaxSource {
        id: "vscode.ini",
        name: "INI / Properties",
        version: "1.95.3",
        extensions: &[".ini", ".properties"],
        filenames: &[".editorconfig", ".gitconfig"],
        filename_patterns: &[],
        language: "ini",
        scope: "source.ini",
        grammar: include_bytes!("grammars/ini.json"),
        sha256: "a46613bd993739695cb62be04d23c5d779754bce9fda8a6ead61ecd4616f95fd",
    },
    SyntaxSource {
        id: "fwcd.kotlin",
        name: "Kotlin",
        version: "0.2.36",
        extensions: &[".kt", ".kts"],
        filenames: &[],
        filename_patterns: &[],
        language: "kotlin",
        scope: "source.kotlin",
        grammar: include_bytes!("grammars/kotlin.json"),
        sha256: "459f3a3ea00b80c9af08f80def97933bd876ec6b3670748b15268b3b429256f5",
    },
    SyntaxSource {
        id: "vscode.less",
        name: "Less",
        version: "1.95.3",
        extensions: &[".less"],
        filenames: &[],
        filename_patterns: &[],
        language: "less",
        scope: "source.css.less",
        grammar: include_bytes!("grammars/less.json"),
        sha256: "7fe291c887e1bd51cef76efec09b03acdf62e2f28dae1260f358240372c16de9",
    },
    SyntaxSource {
        id: "vscode.lua",
        name: "Lua",
        version: "1.95.3",
        extensions: &[".lua"],
        filenames: &[],
        filename_patterns: &[],
        language: "lua",
        scope: "source.lua",
        grammar: include_bytes!("grammars/lua.json"),
        sha256: "f491946b630994daecafbbacf669377e78a7fc5e6d318a79bbf58882cfc70fb7",
    },
    SyntaxSource {
        id: "vscode.make",
        name: "Makefile",
        version: "1.95.3",
        extensions: &[".mk", ".mak"],
        filenames: &["Makefile", "makefile", "GNUmakefile"],
        filename_patterns: &[],
        language: "makefile",
        scope: "source.makefile",
        grammar: include_bytes!("grammars/makefile.json"),
        sha256: "09c59caddf7731489e43c03f3aaa117785618753dd37f53c023590c531f12379",
    },
    SyntaxSource {
        id: "vscode.powershell",
        name: "PowerShell",
        version: "1.95.3",
        extensions: &[".ps1", ".psm1", ".psd1"],
        filenames: &[],
        filename_patterns: &[],
        language: "powershell",
        scope: "source.powershell",
        grammar: include_bytes!("grammars/powershell.json"),
        sha256: "627e2e51b034420d1ae596e57d69dfdaa037d32240437371ee8206fb3e9acc53",
    },
    SyntaxSource {
        id: "vscode.ruby",
        name: "Ruby",
        version: "1.95.3",
        extensions: &[".rb", ".rake", ".gemspec"],
        filenames: &[
            "Gemfile",
            "Rakefile",
            "Podfile",
            "Brewfile",
            "Fastfile",
            "Vagrantfile",
        ],
        filename_patterns: &[],
        language: "ruby",
        scope: "source.ruby",
        grammar: include_bytes!("grammars/ruby.json"),
        sha256: "241a8d95350746cff04219962567bc8875e23db9b4e08f0ab0b4d37f640713e1",
    },
    SyntaxSource {
        id: "vscode.scss",
        name: "SCSS",
        version: "1.95.3",
        extensions: &[".scss"],
        filenames: &[],
        filename_patterns: &[],
        language: "scss",
        scope: "source.css.scss",
        grammar: include_bytes!("grammars/scss.json"),
        sha256: "8f2824a80a7c6fd558fc538ec52d0a7a42a4d7ecb7ddf20d79f0d1f00fa6602b",
    },
    SyntaxSource {
        id: "vscode.shellscript",
        name: "Shell Script",
        version: "1.95.3",
        extensions: &[".sh", ".bash", ".zsh", ".command"],
        filenames: &[
            ".bashrc",
            ".bash_profile",
            ".zshrc",
            ".zprofile",
            ".profile",
            ".envrc",
        ],
        filename_patterns: &[],
        language: "shellscript",
        scope: "source.shell",
        grammar: include_bytes!("grammars/shellscript.json"),
        sha256: "838a597b9bbc29bcfc89ca0190118550ae57517ec3e4b4baa1f8500edcf601d1",
    },
    SyntaxSource {
        id: "vscode.swift",
        name: "Swift",
        version: "1.95.3",
        extensions: &[".swift", ".swiftinterface"],
        filenames: &[],
        filename_patterns: &[],
        language: "swift",
        scope: "source.swift",
        grammar: include_bytes!("grammars/swift.json"),
        sha256: "29777cda1c7528d23f0351e1f6269f60da00c3a7495bc0bb319c97334c1f5469",
    },
    SyntaxSource {
        id: "4ops.terraform",
        name: "Terraform",
        version: "0.2.1",
        extensions: &[".tf", ".tfvars"],
        filenames: &[],
        filename_patterns: &[],
        language: "tf",
        scope: "source.tf",
        grammar: include_bytes!("grammars/terraform.json"),
        sha256: "0c48838a36ce97a8e1fc146d48a6539f1711edf0295132422e20fbbff5a806d5",
    },
    SyntaxSource {
        id: "tamasfe.even-better-toml",
        name: "TOML",
        version: "0.21.2",
        extensions: &[".toml"],
        filenames: &[],
        filename_patterns: &[],
        language: "toml",
        scope: "source.toml",
        grammar: include_bytes!("grammars/toml.json"),
        sha256: "535d51829eee1b852589f501344d88348aa0b8a630285406f004cc51de656a33",
    },
    SyntaxSource {
        id: "vscode.xml",
        name: "XML",
        version: "1.95.3",
        extensions: &[".xml", ".xsd", ".xsl", ".xslt"],
        filenames: &[],
        filename_patterns: &[],
        language: "xml",
        scope: "text.xml",
        grammar: include_bytes!("grammars/xml.json"),
        sha256: "bb51c7b202f20254772c88f86889e0dbcdc734e045b950fe25c0a23b591203d7",
    },
];

pub(super) fn grammar_dependencies(id: &str, sha256: &str) -> &'static [GrammarDependency] {
    const CSS: GrammarDependency = GrammarDependency {
        scope_name: "source.css",
        grammar: include_str!("grammars/css.json"),
    };
    // Accompany only the shipped version of each grammar with its required scopes.
    if !CATALOG
        .iter()
        .any(|source| source.id == id && source.sha256 == sha256)
    {
        return &[];
    }
    match id {
        "vscode.cpp" => &[GrammarDependency {
            scope_name: "source.cpp.embedded.macro",
            grammar: include_str!("grammars/cpp-macro.json"),
        }],
        "vscode.html" => &[CSS],
        "vscode.scss" => &[
            CSS,
            GrammarDependency {
                scope_name: "source.sassdoc",
                grammar: include_str!("grammars/sassdoc.json"),
            },
        ],
        _ => &[],
    }
}

fn syntax_source(id: &str) -> Result<&'static SyntaxSource, String> {
    CATALOG
        .iter()
        .find(|item| item.id == id)
        .ok_or_else(|| UNSUPPORTED.into())
}

fn enable_syntax(root: &Path, key: &str, source: &SyntaxSource) -> Result<Extension, String> {
    let destination = root.join(source.id);
    if destination.exists() {
        let mut item = installation(&destination, key)?;
        if item.capability != Capability::Syntax {
            return Err(UNSUPPORTED.into());
        }
        enable_for_project(&destination, key)?;
        item.enabled = true;
        return Ok(item);
    }

    let grammar: Value = serde_json::from_slice(source.grammar).map_err(|_| CHANGED)?;
    if source.grammar.len() as u64 > MAX_ENTRY
        || format!("{:x}", Sha256::digest(source.grammar)) != source.sha256
        || grammar["scopeName"] != source.scope
        || !grammar["patterns"].is_array()
    {
        return Err(CHANGED.into());
    }

    let (publisher, name) = source.id.split_once('.').ok_or(CHANGED)?;
    let stage = tempfile::tempdir_in(root).map_err(|_| STORAGE)?;
    let content = stage.path().join("extension");
    fs::create_dir(&content).map_err(|_| STORAGE)?;
    fs::write(content.join("grammar.json"), source.grammar).map_err(|_| STORAGE)?;
    let manifest = json!({
        "publisher": publisher, "name": name, "displayName": source.name,
        "version": source.version, "engines": { "vscode": "*" },
        "contributes": {
            "languages": [{ "id": source.language, "aliases": [source.name], "extensions": source.extensions,
                "filenames": source.filenames, "filenamePatterns": source.filename_patterns }],
            "grammars": [{ "language": source.language, "scopeName": source.scope, "path": "grammar.json" }]
        }
    });
    fs::write(content.join("package.json"), manifest.to_string()).map_err(|_| STORAGE)?;
    let receipt = Receipt {
        file_name: format!("{}.tmLanguage.json", source.language),
        sha256: source.sha256.into(),
        source: PackageSource::BundledSyntax,
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
pub(crate) async fn enable_bundled_code_syntax(
    app: AppHandle,
    review: State<'_, ReviewState>,
    project_id: Uuid,
    id: String,
) -> Result<Extension, String> {
    let source = syntax_source(&id)?;
    with_storage_write(app, &review, project_id, move |root, key| {
        enable_syntax(root, key, source)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::code_view::extensions::usable_grammar;

    #[test]
    fn only_bundled_syntax_ids_are_accepted() {
        assert!(syntax_source("4ops.terraform").is_ok());
        assert!(syntax_source("ms-python.debugpy").is_err());
        assert!(syntax_source("https://open-vsx.org/example.vsix").is_err());
    }

    #[test]
    fn bundled_grammars_enable_offline_and_keep_project_settings_independent() {
        let root = tempfile::tempdir().unwrap();
        for source in CATALOG {
            let installed = enable_syntax(root.path(), "project-a", source).unwrap();
            assert_eq!(installed.capability, Capability::Syntax);
            assert!(installed.enabled);
            let destination = root.path().join(source.id);
            assert!(!installation(&destination, "project-b").unwrap().enabled);
            let content = destination.join("extension");
            assert_eq!(
                fs::read(content.join("grammar.json")).unwrap(),
                source.grammar
            );
            let manifest = super::super::manifest(&content).unwrap();
            assert!(usable_grammar(&manifest, &content, source.language).is_some());
            let [language] = installed.languages.as_slice() else {
                panic!("expected one language in {}", source.id);
            };
            assert_eq!(language.filenames, source.filenames);
            assert_eq!(language.filename_patterns, source.filename_patterns);
            for dependency in grammar_dependencies(source.id, source.sha256) {
                let grammar: Value = serde_json::from_str(dependency.grammar).unwrap();
                assert_eq!(grammar["scopeName"], dependency.scope_name);
            }
            assert!(
                enable_syntax(root.path(), "project-b", source)
                    .unwrap()
                    .enabled
            );
            assert!(installation(&destination, "project-a").unwrap().enabled);
        }
    }
}
