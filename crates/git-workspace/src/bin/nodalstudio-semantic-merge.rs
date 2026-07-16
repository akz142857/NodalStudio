use std::{fs, path::Path, process::ExitCode};

use git_workspace::{SemanticDocument, merge_semantic_documents};

fn main() -> ExitCode {
    if std::env::args().nth(1).as_deref() == Some("--version") {
        println!("nodalstudio-semantic-merge {}", env!("CARGO_PKG_VERSION"));
        return ExitCode::SUCCESS;
    }
    match run() {
        Ok(has_conflicts) => {
            if has_conflicts {
                ExitCode::from(1)
            } else {
                ExitCode::SUCCESS
            }
        }
        Err(message) => {
            eprintln!("Nodal Studio semantic merge failed: {message}");
            ExitCode::from(2)
        }
    }
}

fn run() -> Result<bool, String> {
    let arguments: Vec<_> = std::env::args_os().collect();
    if arguments.len() != 4 {
        return Err("usage: nodalstudio-semantic-merge BASE OURS THEIRS".into());
    }
    let base_path = Path::new(&arguments[1]);
    let ours_path = Path::new(&arguments[2]);
    let theirs_path = Path::new(&arguments[3]);
    let base = read_document(base_path)?;
    let ours = read_document(ours_path)?;
    let theirs = read_document(theirs_path)?;
    let result =
        merge_semantic_documents(&base, &ours, &theirs).map_err(|error| error.to_string())?;
    let mut merged =
        serde_json::to_string_pretty(&result.document).map_err(|error| error.to_string())?;
    merged.push('\n');
    fs::write(ours_path, merged).map_err(|error| error.to_string())?;
    if !result.conflicts.is_empty() {
        let report_path = ours_path.with_extension("conflicts.json");
        let mut report =
            serde_json::to_string_pretty(&result.conflicts).map_err(|error| error.to_string())?;
        report.push('\n');
        fs::write(report_path, report).map_err(|error| error.to_string())?;
    }
    Ok(!result.conflicts.is_empty())
}

fn read_document(path: &Path) -> Result<SemanticDocument, String> {
    let contents = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&contents).map_err(|error| error.to_string())
}
