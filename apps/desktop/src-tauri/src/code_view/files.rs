use std::{
    io::{self, ErrorKind, Read, Write},
    path::{Component, Path, PathBuf},
};

use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::fs::{Dir, Metadata, OpenOptions};
use glob::{MatchOptions, Pattern};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub(super) const MAX_FILE_BYTES: u64 = 512 * 1024;
const MAX_DIRECTORY_DEPTH: usize = 24;
const MAX_ENTRIES: usize = 8_000;

#[derive(Clone, Deserialize, PartialEq, Eq, Hash, Serialize)]
pub(super) struct RootIdentity(u64, u64);

#[cfg_attr(unix, allow(clippy::unnecessary_wraps))]
fn root_identity(metadata: &Metadata) -> io::Result<RootIdentity> {
    #[cfg(unix)]
    {
        use cap_std::fs::MetadataExt;
        Ok(RootIdentity(metadata.dev(), metadata.ino()))
    }
    #[cfg(windows)]
    {
        use cap_fs_ext::MetadataExt;
        Ok(RootIdentity(
            u64::from(metadata.volume_serial_number().ok_or_else(denied)?),
            metadata.file_index().ok_or_else(denied)?,
        ))
    }
}

pub(super) struct Repository {
    pub(super) dir: Dir,
    _access: crate::file_access::Access,
}

#[derive(Clone, Default, PartialEq, Eq, Serialize)]
pub(super) struct GitVersion {
    pub(super) branch: Option<String>,
    pub(super) commit: Option<String>,
}

fn denied() -> io::Error {
    io::Error::new(ErrorKind::PermissionDenied, "Repository access denied")
}

#[cfg(unix)]
fn open_directory_nofollow(path: &Path) -> io::Result<Dir> {
    let fd = rustix::fs::open(
        path,
        rustix::fs::OFlags::RDONLY
            | rustix::fs::OFlags::DIRECTORY
            | rustix::fs::OFlags::NOFOLLOW
            | rustix::fs::OFlags::CLOEXEC,
        rustix::fs::Mode::empty(),
    )
    .map_err(io::Error::from)?;
    Ok(Dir::from_std_file(std::fs::File::from(fd)))
}

#[cfg(windows)]
fn open_directory_nofollow(path: &Path) -> io::Result<Dir> {
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_dir() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(denied());
    }
    Ok(Dir::from_std_file(file))
}

impl Repository {
    pub(super) fn open(
        path: &Path,
        expected: Option<&RootIdentity>,
    ) -> Result<(Self, RootIdentity), String> {
        let (repository, identity) = Self::open_directory(path, expected)?;
        let git_marker = repository
            .dir
            .symlink_metadata(".git")
            .map_err(|_| "Choose the root of a Git working tree.")?;
        if !git_marker.is_file() && !git_marker.is_dir() {
            return Err("Choose the root of a Git working tree.".into());
        }
        Ok((repository, identity))
    }

    pub(super) fn open_directory(
        path: &Path,
        expected: Option<&RootIdentity>,
    ) -> Result<(Self, RootIdentity), String> {
        let access = crate::file_access::access(path)?;
        let dir = open_directory_nofollow(path)
            .map_err(|_| "Open the repository folder again to restore access.")?;
        let identity = dir
            .dir_metadata()
            .and_then(|meta| root_identity(&meta))
            .map_err(|_| "Unable to identify the repository folder.")?;
        if expected.is_some_and(|expected| expected != &identity) {
            return Err("The repository folder changed. Choose it again.".into());
        }
        Ok((
            Self {
                dir,
                _access: access,
            },
            identity,
        ))
    }

    pub(super) fn git_version(&self) -> GitVersion {
        let Ok(git) = self.dir.open_dir_nofollow(".git") else {
            return GitVersion::default();
        };
        let Ok(head) = read_file(&git, Path::new("HEAD"), 4096) else {
            return GitVersion::default();
        };
        if let Some(reference) = head.trim().strip_prefix("ref: refs/heads/") {
            let name = format!("refs/heads/{reference}");
            let commit = relative_path(&name, false)
                .ok()
                .and_then(|path| read_nested(&git, &path, 4096).ok())
                .and_then(|content| commit_value(content.trim()))
                .or_else(|| {
                    read_file(&git, Path::new("packed-refs"), MAX_FILE_BYTES)
                        .ok()?
                        .lines()
                        .filter_map(|line| line.split_once(' '))
                        .find(|(_, current)| *current == name)
                        .and_then(|(commit, _)| commit_value(commit))
                });
            GitVersion {
                branch: Some(reference.into()),
                commit,
            }
        } else {
            GitVersion {
                branch: None,
                commit: commit_value(head.trim()),
            }
        }
    }

    pub(super) fn read(&self, relative: &str, roots: &[String]) -> io::Result<String> {
        let path = sql_path(relative, roots)?;
        let (parent, filename) = self.open_allowed_parent(&path)?;
        read_file(&parent, Path::new(&filename), MAX_FILE_BYTES)
    }

    pub(super) fn write(&self, relative: &str, roots: &[String], contents: &str) -> io::Result<()> {
        if contents.len() as u64 > MAX_FILE_BYTES {
            return Err(io::Error::other("SQL file too large"));
        }
        let path = sql_path(relative, roots)?;
        let (parent, filename) = self.open_allowed_parent(&path)?;
        let temporary = format!(".nodal-code-{}", Uuid::new_v4());
        let mut file =
            parent.open_with(&temporary, OpenOptions::new().write(true).create_new(true))?;
        let result = (|| {
            file.write_all(contents.as_bytes())?;
            file.sync_all()?;
            drop(file);
            // The target is installed atomically only if no directory entry already exists.
            parent.hard_link(&temporary, &parent, filename)
        })();
        let _ = parent.remove_file(&temporary);
        result
    }

    pub(super) fn validate_roots(&self, roots: &[String]) -> io::Result<()> {
        for root in roots {
            let path = relative_path(root, true)?;
            if !path.as_os_str().is_empty() {
                let (parent, name) = self.open_allowed_parent(&path)?;
                parent.open_dir_nofollow(name)?;
            }
        }
        Ok(())
    }

    pub(super) fn walk(&self, roots: &[String], mut visit: impl FnMut(String) -> bool) -> usize {
        let mut entries_seen = 0;
        let mut skipped = 0;
        let Ok(rules) = self.root_rules() else {
            return 1;
        };
        let Ok(root) = self.dir.try_clone() else {
            return 1;
        };
        let scope: Vec<_> = roots.iter().map(PathBuf::from).collect();
        let mut stack = vec![(root, PathBuf::new(), rules, 0)];
        while let Some((directory, prefix, rules, depth)) = stack.pop() {
            let Ok(iter) = directory.entries() else {
                skipped += 1;
                continue;
            };
            for entry in iter {
                entries_seen += 1;
                if entries_seen > MAX_ENTRIES {
                    return skipped + 1;
                }
                let Ok(entry) = entry else {
                    skipped += 1;
                    continue;
                };
                let name = entry.file_name();
                if !allowed_component(Path::new(&name), false) {
                    continue;
                }
                let relative = prefix.join(&name);
                if !scope
                    .iter()
                    .any(|root| relative.starts_with(root) || root.starts_with(&relative))
                {
                    continue;
                }
                let Ok(kind) = entry.file_type() else {
                    skipped += 1;
                    continue;
                };
                if is_ignored(&rules, &relative, kind.is_dir()) {
                    continue;
                }
                if kind.is_dir() {
                    if depth >= MAX_DIRECTORY_DEPTH {
                        skipped += 1;
                        continue;
                    }
                    match directory.open_dir_nofollow(&name).and_then(|child| {
                        nested_rules(&child, &relative, &rules).map(|rules| (child, rules))
                    }) {
                        Ok((child, rules)) => stack.push((child, relative, rules, depth + 1)),
                        Err(_) => skipped += 1,
                    }
                } else if is_sql(&relative) {
                    if !kind.is_file() {
                        skipped += 1;
                        continue;
                    }
                    let Some(relative) = relative.to_str() else {
                        skipped += 1;
                        continue;
                    };
                    if !visit(relative.replace(std::path::MAIN_SEPARATOR, "/")) {
                        return skipped + 1;
                    }
                }
            }
        }
        skipped
    }

    fn root_rules(&self) -> io::Result<Vec<IgnoreRule>> {
        let mut rules = Vec::new();
        if let Ok(git) = self.dir.open_dir_nofollow(".git")
            && let Ok(info) = git.open_dir_nofollow("info")
        {
            load_rules(&info, "exclude", Path::new(""), &mut rules)?;
        }
        load_rules(&self.dir, ".gitignore", Path::new(""), &mut rules)?;
        Ok(rules)
    }

    fn open_allowed_parent(&self, path: &Path) -> io::Result<(Dir, std::ffi::OsString)> {
        let mut rules = self.root_rules()?;
        let mut parent = self.dir.try_clone()?;
        let mut prefix = PathBuf::new();
        let mut components = path.iter().peekable();
        while let Some(name) = components.next() {
            prefix.push(name);
            let directory = components.peek().is_some();
            if is_ignored(&rules, &prefix, directory)
                || (!directory && is_ignored(&rules, &prefix, true))
            {
                return Err(denied());
            }
            if !directory {
                return Ok((parent, name.to_owned()));
            }
            parent = parent.open_dir_nofollow(name)?;
            load_rules(&parent, ".gitignore", &prefix, &mut rules)?;
        }
        Err(denied())
    }
}

fn commit_value(value: &str) -> Option<String> {
    (matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then(|| value.to_owned())
}

pub(super) fn open_nested_directory(root: &Dir, path: &Path) -> io::Result<Dir> {
    let mut directory = root.try_clone()?;
    for component in path {
        directory = directory.open_dir_nofollow(component)?;
    }
    Ok(directory)
}

pub(super) fn read_nested(root: &Dir, path: &Path, limit: u64) -> io::Result<String> {
    let parent = path.parent().ok_or_else(denied)?;
    let dir = open_nested_directory(root, parent)?;
    read_file(&dir, Path::new(path.file_name().ok_or_else(denied)?), limit)
}

pub(super) fn read_file(directory: &Dir, filename: &Path, max_size: u64) -> io::Result<String> {
    let before = directory.symlink_metadata(filename)?;
    if !before.is_file() {
        return Err(denied());
    }
    if before.len() > max_size {
        return Err(ErrorKind::FileTooLarge.into());
    }
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt;
        options.custom_flags(rustix::fs::OFlags::NONBLOCK.bits().cast_signed());
    }
    let file = directory.open_with(filename, &options)?;
    if !file.metadata()?.is_file() {
        return Err(denied());
    }
    let mut content = String::new();
    file.take(max_size + 1).read_to_string(&mut content)?;
    if content.len() as u64 > max_size {
        return Err(ErrorKind::FileTooLarge.into());
    }
    Ok(content)
}

fn is_sql(path: &Path) -> bool {
    path.extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("sql"))
}

pub(super) fn relative_path(value: &str, allow_empty: bool) -> io::Result<PathBuf> {
    checked_relative_path(value, allow_empty, false)
}

pub(super) fn review_relative_path(value: &str, allow_empty: bool) -> io::Result<PathBuf> {
    checked_relative_path(value, allow_empty, true)
}

fn checked_relative_path(value: &str, allow_empty: bool, hidden: bool) -> io::Result<PathBuf> {
    if value.is_empty() && allow_empty {
        return Ok(PathBuf::new());
    }
    let path = Path::new(value);
    if value.is_empty()
        || value.len() > 2048
        || path.components().count() > MAX_DIRECTORY_DEPTH
        || value.split('/').any(|component| {
            component.eq_ignore_ascii_case(".git")
                || !allowed_component(Path::new(component), hidden)
        })
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(denied());
    }
    Ok(path.to_owned())
}

fn allowed_component(component: &Path, hidden: bool) -> bool {
    let Some(name) = component.to_str() else {
        return false;
    };
    if name.is_empty()
        || (!hidden && name.starts_with('.'))
        || name.ends_with(['.', ' '])
        || name.contains(['/', '\\', '<', '>', ':', '"', '|', '?', '*'])
        || name.chars().any(char::is_control)
    {
        return false;
    }
    let first = name
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    !matches!(first.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        && !first
            .strip_prefix("COM")
            .or_else(|| first.strip_prefix("LPT"))
            .is_some_and(|suffix| suffix.len() == 1 && suffix.as_bytes()[0].is_ascii_digit())
}

fn sql_path(value: &str, roots: &[String]) -> io::Result<PathBuf> {
    let path = relative_path(value, false)?;
    if !is_sql(&path) || !roots.iter().any(|root| path.starts_with(root)) {
        return Err(denied());
    }
    Ok(path)
}

#[derive(Clone)]
struct IgnoreRule {
    base: PathBuf,
    pattern: Pattern,
    filename_only: bool,
    directory_only: bool,
    include: bool,
}

fn nested_rules(
    directory: &Dir,
    base: &Path,
    inherited: &[IgnoreRule],
) -> io::Result<Vec<IgnoreRule>> {
    let mut rules = inherited.to_vec();
    load_rules(directory, ".gitignore", base, &mut rules)?;
    Ok(rules)
}

fn load_rules(
    directory: &Dir,
    filename: &str,
    base: &Path,
    rules: &mut Vec<IgnoreRule>,
) -> io::Result<()> {
    let contents = match read_file(directory, Path::new(filename), MAX_FILE_BYTES) {
        Ok(contents) => contents,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    for line in contents.lines() {
        let line = line.trim_end_matches(' ');
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (include, pattern) = line
            .strip_prefix('!')
            .map_or((false, line), |value| (true, value));
        let directory_only = pattern.ends_with('/');
        let pattern = pattern.trim_end_matches('/');
        let filename_only = !pattern.contains('/');
        let pattern = pattern.trim_start_matches('/');
        // Unsupported escape or wildcard syntax is a coverage gap, so it cannot grant access.
        if pattern.contains('\\') {
            return Err(denied());
        }
        let pattern = Pattern::new(pattern).map_err(|_| denied())?;
        rules.push(IgnoreRule {
            base: base.to_owned(),
            pattern,
            filename_only,
            directory_only,
            include,
        });
    }
    Ok(())
}

fn is_ignored(rules: &[IgnoreRule], path: &Path, directory: bool) -> bool {
    let mut ignored = false;
    let options = MatchOptions {
        case_sensitive: !cfg!(windows),
        require_literal_separator: true,
        require_literal_leading_dot: false,
    };
    for rule in rules {
        if rule.directory_only && !directory {
            continue;
        }
        if let Ok(relative) = path.strip_prefix(&rule.base) {
            let candidate = if rule.filename_only {
                relative.file_name().map(Path::new)
            } else {
                Some(relative)
            };
            if candidate.is_some_and(|candidate| rule.pattern.matches_path_with(candidate, options))
            {
                ignored = !rule.include;
            }
        }
    }
    ignored
}

pub(super) fn open_in_default_editor(path: &Path) -> Result<(), String> {
    const ERROR: &str = "Unable to open the SQL file in its default application.";
    #[cfg(target_os = "macos")]
    {
        let status = std::process::Command::new("/usr/bin/open")
            .arg("--")
            .arg(path)
            .status()
            .map_err(|_| ERROR.to_owned())?;
        if status.success() {
            Ok(())
        } else {
            Err(ERROR.into())
        }
    }
    #[cfg(windows)]
    {
        let root = std::env::var_os("SystemRoot").ok_or(ERROR)?;
        let _process = std::process::Command::new(Path::new(&root).join("explorer.exe"))
            .arg(path)
            .spawn()
            .map_err(|_| ERROR.to_owned())?;
        Ok(())
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = path;
        Err(ERROR.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_directory_opens_folder_without_parent_traversal_and_rejects_symlinks() {
        let sandbox = tempfile::tempdir().unwrap();
        let target = sandbox.path().join("project");
        std::fs::create_dir(&target).unwrap();
        let (_, identity) = Repository::open_directory(&target, None).unwrap();
        assert!(Repository::open_directory(&target, Some(&identity)).is_ok());
        #[cfg(unix)]
        {
            let link = sandbox.path().join("project-link");
            std::os::unix::fs::symlink(&target, &link).unwrap();
            assert!(Repository::open_directory(&link, None).is_err());
        }
    }
}
