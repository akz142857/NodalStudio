use std::{path::Path, sync::Mutex};

use git2::{Status, StatusOptions, StatusShow};
use regex::{Regex, RegexBuilder};
use serde::Serialize;
use tauri::State;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::files::{Repository, review_relative_path};
use super::review::{
    FileVersion, MAX_QUICK_OPEN_ENTRIES, Project, ProjectPaths, ReviewState, UNAVAILABLE,
    indexed_paths, open_git, read_worktree, walk_project_paths,
};

const MAX_MATCHES: usize = 300;
const MAX_SEARCH_BYTES: usize = 128 * 1024 * 1024;
const PREVIEW_CONTEXT: usize = 70;

#[derive(Default)]
pub(super) struct SearchSession {
    latest: Mutex<CancellationToken>,
    scan_lock: tokio::sync::Mutex<()>,
}

impl SearchSession {
    pub(super) fn cancel(&self) {
        if let Ok(active) = self.latest.lock() {
            active.cancel();
        }
    }

    fn start(&self) -> Result<CancellationToken, String> {
        let mut active = self.latest.lock().map_err(|_| UNAVAILABLE)?;
        active.cancel();
        *active = CancellationToken::new();
        Ok(active.clone())
    }
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ContentSearchResult {
    files: Vec<MatchingFile>,
    limited: bool,
}

#[derive(Serialize)]
struct MatchingFile {
    path: String,
    matches: Vec<MatchingLine>,
}

#[derive(Serialize)]
struct MatchingLine {
    line: usize,
    character: usize,
    before: String,
    matched: String,
    after: String,
}

fn search_paths(directory: &Repository, root: &Path) -> Result<ProjectPaths, String> {
    if directory
        .dir
        .symlink_metadata(".git")
        .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    {
        return Ok(walk_project_paths(directory));
    }
    let repo = open_git(directory, root)?;
    let index = repo.index().map_err(|_| UNAVAILABLE)?;
    let mut result = indexed_paths(&index);
    let mut options = StatusOptions::new();
    options
        .show(StatusShow::Workdir)
        .exclude_submodules(true)
        .include_untracked(true)
        .recurse_untracked_dirs(true);
    let statuses = repo.statuses(Some(&mut options)).map_err(|_| UNAVAILABLE)?;
    for status in statuses
        .iter()
        .filter(|entry| entry.status().contains(Status::WT_NEW))
    {
        if let Ok(path) = status.path()
            && review_relative_path(path, false).is_ok()
        {
            if result.paths.len() == MAX_QUICK_OPEN_ENTRIES {
                result.limited = true;
                break;
            }
            result.paths.push(path.to_owned());
        }
    }
    result.paths.sort_unstable();
    result.paths.dedup();
    Ok(result)
}

fn matching_lines(text: &str, query: &Regex, budget: usize) -> impl Iterator<Item = MatchingLine> {
    // Match the CodeMirror reader's BOM and newline handling without changing UTF-16 columns.
    let normalized = text.strip_prefix('\u{feff}').unwrap_or(text);
    normalized
        .split_inclusive(['\r', '\n'])
        .scan(false, |after_cr, segment| {
            let skip = *after_cr && segment == "\n";
            *after_cr = segment.ends_with('\r');
            Some((!skip).then(|| segment.trim_end_matches(['\r', '\n'])))
        })
        .flatten()
        .enumerate()
        .filter_map(|(line, text)| {
            let hit = query.find(text)?;
            let before = &text[..hit.start()];
            let after = &text[hit.end()..];
            let start = before
                .char_indices()
                .rev()
                .nth(PREVIEW_CONTEXT - 1)
                .map_or(0, |(index, _)| index);
            let end = after
                .char_indices()
                .nth(PREVIEW_CONTEXT)
                .map_or(after.len(), |(index, _)| index);
            Some(MatchingLine {
                line,
                character: before.encode_utf16().count(),
                before: if start == 0 {
                    before.to_owned()
                } else {
                    format!("…{}", &before[start..])
                },
                matched: hit.as_str().to_owned(),
                after: if end == after.len() {
                    after.to_owned()
                } else {
                    format!("{}…", &after[..end])
                },
            })
        })
        .take(budget)
}

fn search(
    project: &Project,
    query: &Regex,
    cancellation: &CancellationToken,
) -> Result<ContentSearchResult, String> {
    let directory = project.directory()?;
    let paths = search_paths(&directory, &project.root)?;
    let mut result = ContentSearchResult {
        limited: paths.limited,
        ..ContentSearchResult::default()
    };
    let mut remaining = MAX_MATCHES;
    let mut bytes = 0;
    for path in paths.paths {
        if cancellation.is_cancelled() {
            return Err(UNAVAILABLE.into());
        }
        let text = match read_worktree(&directory, Path::new(&path)) {
            FileVersion::Text(text) => text,
            FileVersion::TooLarge | FileVersion::Unreadable => {
                result.limited = true;
                continue;
            }
            FileVersion::Missing | FileVersion::Binary | FileVersion::Encoding => continue,
        };
        bytes += text.len();
        if bytes > MAX_SEARCH_BYTES {
            result.limited = true;
            break;
        }
        let mut matches: Vec<_> = matching_lines(&text, query, remaining + 1).collect();
        let overflow = matches.len() > remaining;
        matches.truncate(remaining);
        remaining -= matches.len();
        if !matches.is_empty() {
            result.files.push(MatchingFile { path, matches });
        }
        if overflow {
            result.limited = true;
            break;
        }
    }
    Ok(result)
}

fn literal(query: &str) -> Result<Regex, String> {
    if query.trim().is_empty() || query.len() > 512 || query.contains(['\n', '\r', '\0']) {
        return Err(UNAVAILABLE.into());
    }
    RegexBuilder::new(&regex::escape(query))
        .case_insensitive(true)
        .build()
        .map_err(|_| UNAVAILABLE.into())
}

#[tauri::command]
pub(crate) async fn search_code_review_content(
    project_id: Uuid,
    query: String,
    state: State<'_, ReviewState>,
) -> Result<ContentSearchResult, String> {
    let query = literal(&query)?;
    let project = state.project(project_id)?;
    let cancellation = project.search.start()?;
    let _guard = project.search.scan_lock.lock().await;
    if cancellation.is_cancelled() {
        return Err(UNAVAILABLE.into());
    }
    let scan_project = project.clone();
    tokio::task::spawn_blocking(move || search(&scan_project, &query, &cancellation))
        .await
        .map_err(|_| UNAVAILABLE)?
}

#[cfg(all(test, not(feature = "mac-app-store")))]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn matches_literal_text_and_uses_reader_lines_and_utf16_columns() {
        let query = literal("load.état(").unwrap();
        let text = "\u{feff}😀 LOAD.ÉTAT(1)\r\nload_état(2)\r😀 load.état(3)\r\n";
        let matches: Vec<_> = matching_lines(text, &query, 10).collect();
        assert_eq!(matches.len(), 2);
        assert_eq!((matches[0].line, matches[0].character), (0, 3));
        assert_eq!((matches[1].line, matches[1].character), (2, 3));
        assert_eq!(matches[0].matched, "LOAD.ÉTAT(");
        assert_eq!(matches[1].after, "3)");
    }

    #[test]
    fn searches_tracked_and_untracked_worktree_files_and_respects_git_ignore() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let repo = git2::Repository::init(root).unwrap();
        fs::write(root.join(".gitignore"), "cache/\n").unwrap();
        fs::create_dir(root.join("cache")).unwrap();
        fs::write(root.join("cache/ignored.ts"), "find me").unwrap();
        fs::write(root.join("tracked.ts"), "previous index text").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("tracked.ts")).unwrap();
        index.write().unwrap();
        fs::write(root.join("tracked.ts"), "Find me\n  find me again").unwrap();
        fs::write(root.join("new.py"), "first line\nfind me").unwrap();
        fs::write(root.join("binary"), b"\0find me").unwrap();
        let project = Project::open(root.to_owned()).unwrap();
        let result = search(
            &project,
            &literal("find me").unwrap(),
            &CancellationToken::new(),
        )
        .unwrap();
        assert!(!result.limited);
        assert_eq!(
            result
                .files
                .iter()
                .map(|file| file.path.as_str())
                .collect::<Vec<_>>(),
            ["new.py", "tracked.ts"]
        );
        assert_eq!(result.files[0].matches[0].line, 1);
        assert_eq!(result.files[1].matches.len(), 2);
    }

    #[test]
    fn caps_matching_lines_in_a_plain_folder_and_cancels_superseded_searches() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(
            temp.path().join("script.js"),
            "foobar\n".repeat(MAX_MATCHES + 1),
        )
        .unwrap();
        let project = Project::open(temp.path().to_owned()).unwrap();
        let previous = project.search.start().unwrap();
        let current = project.search.start().unwrap();
        let query = literal("foobar").unwrap();
        assert!(search(&project, &query, &previous).is_err());
        let result = search(&project, &query, &current).unwrap();
        assert!(result.limited);
        assert_eq!(result.files[0].matches.len(), MAX_MATCHES);
    }
}
