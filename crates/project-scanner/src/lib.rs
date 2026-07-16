//! Safe, non-executing local project discovery and incremental file fingerprinting.

use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::OsStr,
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::UNIX_EPOCH,
};

use project_model::{FileChange, FileChangeKind, GitMetadata, ProjectFile, RepositoryKind};
use sha2::{Digest, Sha256};
use thiserror::Error;

const DEFAULT_MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const DEFAULT_EXCLUDED_DIRECTORIES: &[&str] = &[
    ".git",
    ".cache",
    ".next",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "target",
    "vendor",
];
const SECRET_NAMES: &[&str] = &["credentials", "secrets"];
const SECRET_EXTENSIONS: &[&str] = &["key", "pem"];
const BINARY_EXTENSIONS: &[&str] = &[
    "7z", "a", "app", "bin", "bmp", "class", "dmg", "dll", "doc", "docx", "dylib", "exe", "gif",
    "gz", "ico", "jar", "jpeg", "jpg", "lockb", "mov", "mp3", "mp4", "o", "pdf", "png", "so",
    "tar", "wasm", "webp", "woff", "woff2", "xls", "xlsx", "zip",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScanOptions {
    pub max_file_bytes: u64,
    pub include_gitignore: bool,
    pub include_nodal_studio_ignore: bool,
}

impl Default for ScanOptions {
    fn default() -> Self {
        Self {
            max_file_bytes: DEFAULT_MAX_FILE_BYTES,
            include_gitignore: true,
            include_nodal_studio_ignore: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectDiscovery {
    pub canonical_root: PathBuf,
    pub repository_kind: RepositoryKind,
    pub git: Option<GitMetadata>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScanOutput {
    pub discovery: ProjectDiscovery,
    pub files: Vec<ProjectFile>,
    pub changes: Vec<FileChange>,
    pub skipped_symlinks: Vec<String>,
    pub skipped_large_files: Vec<String>,
}

#[derive(Debug, Error)]
pub enum ScannerError {
    #[error("project root does not exist or is not a directory")]
    InvalidRoot,
    #[error("unable to access project path: {0}")]
    Io(#[from] std::io::Error),
    #[error("project path is not valid UTF-8")]
    NonUtf8Path,
    #[error("project scan was cancelled")]
    Cancelled,
}

#[derive(Debug, Clone, Default)]
pub struct ScanCancellation {
    cancelled: Arc<AtomicBool>,
}

impl ScanCancellation {
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
}

/// Discovers a local project without executing project code, hooks, or build scripts.
///
/// # Errors
///
/// Returns an error when the root is missing, is not a directory, cannot be
/// accessed, or contains unsupported path data needed for discovery.
pub fn discover_project(root: &Path) -> Result<ProjectDiscovery, ScannerError> {
    let canonical_root = root.canonicalize().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            ScannerError::InvalidRoot
        } else {
            ScannerError::Io(error)
        }
    })?;
    if !canonical_root.is_dir() {
        return Err(ScannerError::InvalidRoot);
    }
    let git = discover_git_metadata(&canonical_root)?;
    Ok(ProjectDiscovery {
        canonical_root,
        repository_kind: if git.is_some() {
            RepositoryKind::Git
        } else {
            RepositoryKind::Directory
        },
        git,
    })
}

/// Scans files and compares their content hashes with the previous successful scan.
///
/// # Errors
///
/// Returns an error when the authorized root or an included file cannot be
/// read, or when an included relative path cannot be represented safely.
pub fn scan_project(
    root: &Path,
    previous_hashes: &BTreeMap<String, String>,
    options: &ScanOptions,
) -> Result<ScanOutput, ScannerError> {
    scan_project_cancellable(root, previous_hashes, options, &ScanCancellation::default())
}

/// Scans a project while honoring cooperative cancellation between filesystem entries.
///
/// # Errors
///
/// Returns [`ScannerError::Cancelled`] after cancellation is requested, or the
/// same filesystem and path errors as [`scan_project`].
pub fn scan_project_cancellable(
    root: &Path,
    previous_hashes: &BTreeMap<String, String>,
    options: &ScanOptions,
    cancellation: &ScanCancellation,
) -> Result<ScanOutput, ScannerError> {
    let discovery = discover_project(root)?;
    let matcher = IgnoreMatcher::load(&discovery.canonical_root, options)?;
    let mut state = WalkState::default();
    walk_directory(
        &discovery.canonical_root,
        &discovery.canonical_root,
        options,
        &matcher,
        cancellation,
        &mut state,
    )?;
    state
        .files
        .sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    state.skipped_symlinks.sort();
    state.skipped_large_files.sort();

    let current: BTreeMap<_, _> = state
        .files
        .iter()
        .map(|file| (file.relative_path.clone(), file.clone()))
        .collect();
    let mut all_paths: BTreeSet<String> = previous_hashes.keys().cloned().collect();
    all_paths.extend(current.keys().cloned());
    let changes = all_paths
        .into_iter()
        .map(|relative_path| {
            let file = current.get(&relative_path).cloned();
            let kind = match (previous_hashes.get(&relative_path), file.as_ref()) {
                (None, Some(_)) => FileChangeKind::Added,
                (Some(_), None) => FileChangeKind::Deleted,
                (Some(previous), Some(current)) if previous == &current.content_hash => {
                    FileChangeKind::Unchanged
                }
                (Some(_), Some(_)) => FileChangeKind::Modified,
                (None, None) => unreachable!("path originated from current or previous scan"),
            };
            FileChange {
                relative_path,
                kind,
                file,
            }
        })
        .collect();

    Ok(ScanOutput {
        discovery,
        files: state.files,
        changes,
        skipped_symlinks: state.skipped_symlinks,
        skipped_large_files: state.skipped_large_files,
    })
}

#[derive(Default)]
struct WalkState {
    files: Vec<ProjectFile>,
    skipped_symlinks: Vec<String>,
    skipped_large_files: Vec<String>,
}

fn walk_directory(
    root: &Path,
    directory: &Path,
    options: &ScanOptions,
    matcher: &IgnoreMatcher,
    cancellation: &ScanCancellation,
    state: &mut WalkState,
) -> Result<(), ScannerError> {
    let mut entries: Vec<_> = fs::read_dir(directory)?.collect::<Result<_, _>>()?;
    entries.sort_by_key(fs::DirEntry::file_name);
    for entry in entries {
        if cancellation.is_cancelled() {
            return Err(ScannerError::Cancelled);
        }
        let path = entry.path();
        let file_type = entry.file_type()?;
        let relative = relative_path(root, &path)?;
        if file_type.is_symlink() {
            state.skipped_symlinks.push(relative);
            continue;
        }
        if file_type.is_dir() {
            if is_default_excluded_directory(entry.file_name().as_os_str())
                || matcher.is_ignored(&relative, true)
            {
                continue;
            }
            walk_directory(root, &path, options, matcher, cancellation, state)?;
            continue;
        }
        if !file_type.is_file()
            || matcher.is_ignored(&relative, false)
            || is_secret_path(&relative)
            || is_binary_extension(&path)
        {
            continue;
        }
        let metadata = entry.metadata()?;
        if metadata.len() > options.max_file_bytes {
            state.skipped_large_files.push(relative);
            continue;
        }
        let contents = fs::read(&path)?;
        if contents.contains(&0) {
            continue;
        }
        let modified_unix_ms = metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .and_then(|value| u64::try_from(value.as_millis()).ok());
        state.files.push(ProjectFile {
            relative_path: relative,
            byte_size: metadata.len(),
            modified_unix_ms,
            content_hash: hex::encode(Sha256::digest(&contents)),
            language: language_for_path(&path).map(str::to_owned),
        });
    }
    Ok(())
}

fn relative_path(root: &Path, path: &Path) -> Result<String, ScannerError> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| ScannerError::InvalidRoot)?;
    let value = relative.to_str().ok_or(ScannerError::NonUtf8Path)?;
    Ok(value.replace(std::path::MAIN_SEPARATOR, "/"))
}

fn is_default_excluded_directory(name: &OsStr) -> bool {
    name.to_str()
        .is_some_and(|value| DEFAULT_EXCLUDED_DIRECTORIES.contains(&value))
}

fn is_secret_path(relative_path: &str) -> bool {
    let file_name = relative_path.rsplit('/').next().unwrap_or(relative_path);
    let lower = file_name.to_ascii_lowercase();
    if lower == ".env" || lower.starts_with(".env.") {
        return true;
    }
    let stem = lower.split('.').next().unwrap_or(&lower);
    if SECRET_NAMES.contains(&stem) {
        return true;
    }
    lower
        .rsplit_once('.')
        .is_some_and(|(_, extension)| SECRET_EXTENSIONS.contains(&extension))
}

fn is_binary_extension(path: &Path) -> bool {
    path.extension()
        .and_then(OsStr::to_str)
        .map(str::to_ascii_lowercase)
        .is_some_and(|extension| BINARY_EXTENSIONS.contains(&extension.as_str()))
}

fn language_for_path(path: &Path) -> Option<&'static str> {
    match path
        .extension()
        .and_then(OsStr::to_str)?
        .to_ascii_lowercase()
        .as_str()
    {
        "js" | "cjs" | "mjs" | "jsx" => Some("javascript"),
        "ts" | "tsx" | "mts" | "cts" => Some("typescript"),
        "sql" => Some("sql"),
        "rs" => Some("rust"),
        "java" => Some("java"),
        "go" => Some("go"),
        "py" => Some("python"),
        "prisma" => Some("prisma"),
        "json" => Some("json"),
        "toml" => Some("toml"),
        "yaml" | "yml" => Some("yaml"),
        _ => None,
    }
}

#[derive(Debug, Clone)]
struct IgnoreRule {
    pattern: String,
    negated: bool,
    directory_only: bool,
}

#[derive(Debug, Clone, Default)]
struct IgnoreMatcher {
    rules: Vec<IgnoreRule>,
}

impl IgnoreMatcher {
    fn load(root: &Path, options: &ScanOptions) -> Result<Self, ScannerError> {
        let mut rules = Vec::new();
        if options.include_gitignore {
            load_ignore_file(&root.join(".gitignore"), &mut rules)?;
        }
        if options.include_nodal_studio_ignore {
            load_ignore_file(&root.join(".nodalstudioignore"), &mut rules)?;
        }
        Ok(Self { rules })
    }

    fn is_ignored(&self, relative_path: &str, is_directory: bool) -> bool {
        let mut ignored = false;
        for rule in &self.rules {
            if rule.directory_only && !is_directory {
                continue;
            }
            if ignore_pattern_matches(&rule.pattern, relative_path) {
                ignored = !rule.negated;
            }
        }
        ignored
    }
}

fn load_ignore_file(path: &Path, rules: &mut Vec<IgnoreRule>) -> Result<(), ScannerError> {
    if !path.exists() {
        return Ok(());
    }
    for line in fs::read_to_string(path)?.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let negated = trimmed.starts_with('!');
        let value = if negated { &trimmed[1..] } else { trimmed };
        let directory_only = value.ends_with('/');
        let pattern = value
            .trim_start_matches('/')
            .trim_end_matches('/')
            .replace('\\', "/");
        if !pattern.is_empty() {
            rules.push(IgnoreRule {
                pattern,
                negated,
                directory_only,
            });
        }
    }
    Ok(())
}

fn ignore_pattern_matches(pattern: &str, relative_path: &str) -> bool {
    if pattern.contains('/') {
        glob_matches(pattern.as_bytes(), relative_path.as_bytes())
    } else {
        relative_path
            .split('/')
            .any(|component| glob_matches(pattern.as_bytes(), component.as_bytes()))
    }
}

fn glob_matches(pattern: &[u8], value: &[u8]) -> bool {
    let (mut pattern_index, mut value_index) = (0, 0);
    let (mut star_index, mut star_value_index) = (None, 0);
    while value_index < value.len() {
        if pattern_index < pattern.len()
            && (pattern[pattern_index] == b'?' || pattern[pattern_index] == value[value_index])
        {
            pattern_index += 1;
            value_index += 1;
        } else if pattern_index < pattern.len() && pattern[pattern_index] == b'*' {
            star_index = Some(pattern_index);
            star_value_index = value_index;
            pattern_index += 1;
        } else if let Some(star) = star_index {
            pattern_index = star + 1;
            star_value_index += 1;
            value_index = star_value_index;
        } else {
            return false;
        }
    }
    while pattern_index < pattern.len() && pattern[pattern_index] == b'*' {
        pattern_index += 1;
    }
    pattern_index == pattern.len()
}

fn discover_git_metadata(root: &Path) -> Result<Option<GitMetadata>, ScannerError> {
    let dot_git = root.join(".git");
    if !dot_git.exists() {
        return Ok(None);
    }
    let git_directory = if dot_git.is_dir() {
        dot_git
    } else {
        let contents = fs::read_to_string(&dot_git)?;
        let target = contents
            .trim()
            .strip_prefix("gitdir:")
            .map(str::trim)
            .ok_or(ScannerError::InvalidRoot)?;
        let path = PathBuf::from(target);
        if path.is_absolute() {
            path
        } else {
            root.join(path)
        }
    };
    let head = fs::read_to_string(git_directory.join("HEAD"))?;
    let head = head.trim();
    let (branch, commit_sha) = if let Some(reference) = head.strip_prefix("ref: ") {
        let branch = reference.strip_prefix("refs/heads/").map(str::to_owned);
        let commit = read_git_reference(&git_directory, reference)?;
        (branch, commit)
    } else {
        (None, normalize_sha(head))
    };
    let dirty = git_dirty_status(root);
    Ok(Some(GitMetadata {
        root_path: root.to_string_lossy().into_owned(),
        branch,
        commit_sha,
        dirty: dirty.unwrap_or(false),
        dirty_known: dirty.is_some(),
    }))
}

fn read_git_reference(
    git_directory: &Path,
    reference: &str,
) -> Result<Option<String>, ScannerError> {
    let loose = git_directory.join(reference);
    if loose.exists() {
        return Ok(normalize_sha(fs::read_to_string(loose)?.trim()));
    }
    let packed = git_directory.join("packed-refs");
    if !packed.exists() {
        return Ok(None);
    }
    let contents = fs::read_to_string(packed)?;
    Ok(contents.lines().find_map(|line| {
        let (sha, candidate) = line.split_once(' ')?;
        (candidate == reference)
            .then(|| normalize_sha(sha))
            .flatten()
    }))
}

fn normalize_sha(value: &str) -> Option<String> {
    let normalized = value.trim().to_ascii_lowercase();
    (!normalized.is_empty()
        && normalized
            .chars()
            .all(|character| character.is_ascii_hexdigit()))
    .then_some(normalized)
}

fn git_dirty_status(root: &Path) -> Option<bool> {
    let output = Command::new("git")
        .args([
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "credential.helper=",
            "--no-optional-locks",
            "status",
            "--porcelain=v1",
            "--untracked-files=normal",
        ])
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .ok()?;
    output.status.success().then_some(!output.stdout.is_empty())
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;
    use uuid::Uuid;

    fn temporary_project() -> PathBuf {
        let path = std::env::temp_dir().join(format!("nodalstudio-scan-{}", Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn write(path: &Path, contents: &[u8]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut file = fs::File::create(path).unwrap();
        file.write_all(contents).unwrap();
    }

    #[test]
    fn skips_dependencies_secrets_ignored_files_binaries_and_symlinks() {
        let root = temporary_project();
        write(&root.join("src/app.ts"), b"export const app = true;");
        write(&root.join("src/debug.log"), b"ignored");
        write(&root.join("node_modules/pkg/index.js"), b"ignored");
        write(&root.join(".env.local"), b"TOKEN=secret");
        write(&root.join("private.pem"), b"secret");
        write(&root.join("asset.png"), b"not really an image");
        write(&root.join(".nodalstudioignore"), b"*.log\n");
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.join("src/app.ts"), root.join("linked.ts")).unwrap();

        let output = scan_project(&root, &BTreeMap::new(), &ScanOptions::default()).unwrap();
        let paths: Vec<_> = output
            .files
            .iter()
            .map(|file| file.relative_path.as_str())
            .collect();
        assert!(paths.contains(&"src/app.ts"));
        assert!(paths.contains(&".nodalstudioignore"));
        assert!(!paths.iter().any(|path| path.contains("node_modules")));
        assert!(!paths.iter().any(|path| path.contains(".env")));
        assert!(!paths.iter().any(|path| has_extension(path, "pem")));
        assert!(!paths.iter().any(|path| has_extension(path, "png")));
        assert!(!paths.iter().any(|path| has_extension(path, "log")));
        #[cfg(unix)]
        assert_eq!(output.skipped_symlinks, ["linked.ts"]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reports_added_modified_unchanged_and_deleted_files() {
        let root = temporary_project();
        write(&root.join("a.ts"), b"one");
        write(&root.join("b.sql"), b"select 1");
        let first = scan_project(&root, &BTreeMap::new(), &ScanOptions::default()).unwrap();
        let previous: BTreeMap<_, _> = first
            .files
            .iter()
            .map(|file| (file.relative_path.clone(), file.content_hash.clone()))
            .collect();

        write(&root.join("a.ts"), b"two");
        fs::remove_file(root.join("b.sql")).unwrap();
        write(&root.join("c.ts"), b"three");
        let second = scan_project(&root, &previous, &ScanOptions::default()).unwrap();
        let kinds: BTreeMap<_, _> = second
            .changes
            .iter()
            .map(|change| (change.relative_path.as_str(), change.kind))
            .collect();
        assert_eq!(kinds["a.ts"], FileChangeKind::Modified);
        assert_eq!(kinds["b.sql"], FileChangeKind::Deleted);
        assert_eq!(kinds["c.ts"], FileChangeKind::Added);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reads_branch_and_commit_without_running_repository_hooks() {
        let root = temporary_project();
        write(&root.join(".git/HEAD"), b"ref: refs/heads/main\n");
        write(
            &root.join(".git/refs/heads/main"),
            b"0123456789abcdef0123456789abcdef01234567\n",
        );
        let discovery = discover_project(&root).unwrap();
        let git = discovery.git.unwrap();
        assert_eq!(discovery.repository_kind, RepositoryKind::Git);
        assert_eq!(git.branch.as_deref(), Some("main"));
        assert_eq!(
            git.commit_sha.as_deref(),
            Some("0123456789abcdef0123456789abcdef01234567")
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn glob_rules_support_negation() {
        assert!(ignore_pattern_matches("*.log", "src/app.log"));
        let matcher = IgnoreMatcher {
            rules: vec![
                IgnoreRule {
                    pattern: "*.log".into(),
                    negated: false,
                    directory_only: false,
                },
                IgnoreRule {
                    pattern: "keep.log".into(),
                    negated: true,
                    directory_only: false,
                },
            ],
        };
        assert!(matcher.is_ignored("src/drop.log", false));
        assert!(!matcher.is_ignored("src/keep.log", false));
    }

    #[test]
    fn cancellation_stops_before_file_contents_are_scanned() {
        let root = temporary_project();
        write(&root.join("src/app.ts"), b"export const app = true;");
        let cancellation = ScanCancellation::default();
        cancellation.cancel();
        assert!(matches!(
            scan_project_cancellable(
                &root,
                &BTreeMap::new(),
                &ScanOptions::default(),
                &cancellation
            ),
            Err(ScannerError::Cancelled)
        ));
        fs::remove_dir_all(root).unwrap();
    }

    fn has_extension(path: &str, expected: &str) -> bool {
        Path::new(path)
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case(expected))
    }
}
