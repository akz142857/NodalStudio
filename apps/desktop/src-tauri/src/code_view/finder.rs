use std::{
    io::ErrorKind,
    path::{Path, PathBuf},
};

#[cfg(not(feature = "mac-app-store"))]
use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
#[cfg(not(feature = "mac-app-store"))]
use cap_std::{
    ambient_authority,
    fs::{Dir, OpenOptions, OpenOptionsExt, PermissionsExt},
};
#[cfg(not(feature = "mac-app-store"))]
use objc2::runtime::ProtocolObject;
#[cfg(not(feature = "mac-app-store"))]
use objc2_app_kit::NSPasteboard;
use objc2_app_kit::NSWorkspace;
#[cfg(not(feature = "mac-app-store"))]
use objc2_foundation::ns_string;
use objc2_foundation::{NSArray, NSString, NSURL};
use serde::{Deserialize, Serialize};
#[cfg(not(feature = "mac-app-store"))]
use std::{
    collections::HashSet,
    ffi::{OsStr, OsString},
    io,
};
use tauri::AppHandle;
use tokio::sync::oneshot;
use uuid::Uuid;

use super::files::{Repository, open_nested_directory, review_relative_path};

const UNAVAILABLE: &str = "codeReviewFileActionUnavailable";
#[cfg(not(feature = "mac-app-store"))]
pub(super) const CLIPBOARD_EMPTY: &str = "codeReviewClipboardEmpty";
#[cfg(not(feature = "mac-app-store"))]
const MAX_PASTE_ITEMS: usize = 64;

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum FinderTarget {
    Project { id: Uuid },
    Entry { project_id: Uuid, path: String },
    Worktree { project_id: Uuid, path: String },
    Dependency { project_id: Uuid, source_id: Uuid },
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum FinderAction {
    Reveal,
    #[cfg(not(feature = "mac-app-store"))]
    Copy,
    #[cfg(not(feature = "mac-app-store"))]
    Paste,
}

#[derive(Default, Serialize)]
pub(crate) struct PasteResult {
    pub(super) added: usize,
    pub(super) skipped: usize,
}

pub(super) struct LocatedItem {
    root: PathBuf,
    directory: Repository,
    relative: PathBuf,
    is_directory: bool,
}

impl LocatedItem {
    pub(super) fn locate(
        root: PathBuf,
        directory: Repository,
        relative: &str,
        action: FinderAction,
    ) -> Result<Self, String> {
        let mut relative = review_relative_path(relative, true).map_err(|_| UNAVAILABLE)?;
        let mut fallback = false;
        let is_directory = loop {
            let (Some(parent), Some(name)) = (relative.parent(), relative.file_name()) else {
                break true;
            };
            match open_nested_directory(&directory.dir, parent)
                .and_then(|folder| folder.symlink_metadata(name))
            {
                Ok(metadata) if metadata.is_dir() => break true,
                Ok(metadata) if metadata.is_file() && !fallback => break false,
                Err(error)
                    if matches!(action, FinderAction::Reveal)
                        && matches!(
                            error.kind(),
                            ErrorKind::NotFound | ErrorKind::NotADirectory
                        ) => {}
                Ok(_) if fallback => {}
                _ => return Err(UNAVAILABLE.into()),
            }
            relative.pop();
            fallback = true;
        };
        Ok(Self {
            root,
            directory,
            relative,
            is_directory,
        })
    }

    pub(super) async fn act(
        self,
        app: &AppHandle,
        action: FinderAction,
    ) -> Result<PasteResult, String> {
        match action {
            FinderAction::Reveal => {
                let result = reveal(app, &self.root.join(&self.relative), self.is_directory).await;
                drop(self.directory);
                result
            }
            #[cfg(not(feature = "mac-app-store"))]
            FinderAction::Copy => {
                let path = self
                    .root
                    .join(&self.relative)
                    .to_str()
                    .ok_or(UNAVAILABLE)?
                    .to_owned();
                on_main_thread(app, move || {
                    let url = NSURL::fileURLWithPath_isDirectory(
                        &NSString::from_str(&path),
                        self.is_directory,
                    );
                    let clipboard = NSPasteboard::generalPasteboard();
                    clipboard.clearContents();
                    let object = ProtocolObject::from_ref(&*url);
                    if !clipboard.writeObjects(&NSArray::from_slice(&[object])) {
                        return Err(UNAVAILABLE.into());
                    }
                    Ok(PasteResult::default())
                })
                .await
            }
            #[cfg(not(feature = "mac-app-store"))]
            FinderAction::Paste => {
                let sources = clipboard_paths(app).await?;
                tokio::task::spawn_blocking(move || self.paste(sources))
                    .await
                    .map_err(|_| UNAVAILABLE)?
            }
        }
    }

    #[cfg(not(feature = "mac-app-store"))]
    fn paste(&self, sources: Vec<PathBuf>) -> Result<PasteResult, String> {
        let relative = if self.is_directory {
            &self.relative
        } else {
            self.relative.parent().ok_or(UNAVAILABLE)?
        };
        let destination =
            open_nested_directory(&self.directory.dir, relative).map_err(|_| UNAVAILABLE)?;
        let path = self
            .root
            .join(relative)
            .canonicalize()
            .map_err(|_| UNAVAILABLE)?;
        let mut result = PasteResult::default();
        for source in sources {
            if copy_into(&source, &destination, &path).is_ok() {
                result.added += 1;
            } else {
                result.skipped += 1;
            }
        }
        Ok(result)
    }
}

pub(super) async fn reveal(
    app: &AppHandle,
    path: &Path,
    is_directory: bool,
) -> Result<PasteResult, String> {
    let path = path.to_str().ok_or(UNAVAILABLE)?.to_owned();
    on_main_thread(app, move || {
        let url = NSURL::fileURLWithPath_isDirectory(&NSString::from_str(&path), is_directory);
        NSWorkspace::sharedWorkspace()
            .activateFileViewerSelectingURLs(&NSArray::from_slice(&[&*url]));
        Ok(PasteResult::default())
    })
    .await
}

async fn on_main_thread<T: Send + 'static>(
    app: &AppHandle,
    operation: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (sender, result) = oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = sender.send(operation());
    })
    .map_err(|_| UNAVAILABLE)?;
    result.await.map_err(|_| UNAVAILABLE)?
}

#[cfg(not(feature = "mac-app-store"))]
pub(super) async fn clipboard_paths(app: &AppHandle) -> Result<Vec<PathBuf>, String> {
    on_main_thread(app, || {
        let clipboard = NSPasteboard::generalPasteboard();
        let items = clipboard.pasteboardItems().ok_or(CLIPBOARD_EMPTY)?;
        let mut seen = HashSet::new();
        let paths: Vec<_> = items
            .iter()
            .filter_map(|item| {
                let value = item.stringForType(ns_string!("public.file-url"))?;
                clipboard_path(&value)
            })
            .filter(|path| seen.insert(path.clone()))
            .take(MAX_PASTE_ITEMS + 1)
            .collect();
        if paths.is_empty() {
            Err(CLIPBOARD_EMPTY.into())
        } else if paths.len() > MAX_PASTE_ITEMS {
            Err("codeReviewClipboardLimit".into())
        } else {
            Ok(paths)
        }
    })
    .await
}

#[cfg(not(feature = "mac-app-store"))]
fn clipboard_path(value: &NSString) -> Option<PathBuf> {
    let url = NSURL::URLWithString(value)?;
    if !url.isFileURL() {
        return None;
    }
    // Finder can publish file reference URLs instead of paths.
    let path = PathBuf::from(url.filePathURL()?.path()?.to_string());
    path.is_absolute().then_some(path)
}

#[cfg(not(feature = "mac-app-store"))]
const MAX_PASTE_ENTRIES: usize = 10_000;
#[cfg(not(feature = "mac-app-store"))]
const MAX_PASTE_BYTES: u64 = 512 * 1024 * 1024;

#[cfg(not(feature = "mac-app-store"))]
struct CopyQuota {
    remaining_entries: usize,
    remaining_bytes: u64,
}

#[cfg(not(feature = "mac-app-store"))]
fn copy_into(source: &Path, destination: &Dir, destination_path: &Path) -> io::Result<()> {
    let name = source.file_name().ok_or(ErrorKind::InvalidInput)?;
    let parent = Dir::open_ambient_dir(
        source.parent().ok_or(ErrorKind::InvalidInput)?,
        ambient_authority(),
    )?;
    let metadata = parent.symlink_metadata(name)?;
    if name.eq_ignore_ascii_case(".git")
        || (metadata.is_dir() && destination_path.starts_with(source.canonicalize()?))
    {
        return Err(ErrorKind::InvalidInput.into());
    }
    let temporary = format!(".nodal-copy-{}", Uuid::new_v4());
    destination.create_dir(&temporary)?;
    let staging = destination.open_dir_nofollow(&temporary)?;
    let result = (|| {
        let mut quota = CopyQuota {
            remaining_entries: MAX_PASTE_ENTRIES,
            remaining_bytes: MAX_PASTE_BYTES,
        };
        copy_entry(&parent, &staging, name, 0, &mut quota)?;
        for attempt in 0..1000 {
            let candidate = copy_name(name, metadata.is_dir(), attempt);
            match rustix::fs::renameat_with(
                &staging,
                name,
                destination,
                candidate,
                rustix::fs::RenameFlags::NOREPLACE,
            ) {
                Ok(()) => return Ok(()),
                Err(rustix::io::Errno::EXIST) => {}
                Err(error) => return Err(error.into()),
            }
        }
        Err(ErrorKind::AlreadyExists.into())
    })();
    let _ = staging.remove_open_dir_all();
    result
}

#[cfg(not(feature = "mac-app-store"))]
fn copy_entry(
    source: &Dir,
    destination: &Dir,
    name: &OsStr,
    depth: usize,
    quota: &mut CopyQuota,
) -> io::Result<()> {
    if depth > 128 || name.eq_ignore_ascii_case(".git") {
        return Err(ErrorKind::InvalidInput.into());
    }
    if quota.remaining_entries == 0 {
        return Err(ErrorKind::FileTooLarge.into());
    }
    quota.remaining_entries -= 1;
    let metadata = source.symlink_metadata(name)?;
    if metadata.is_dir() {
        let folder = source.open_dir_nofollow(name)?;
        destination.create_dir(name)?;
        let output = destination.open_dir_nofollow(name)?;
        for entry in folder.entries()? {
            copy_entry(&folder, &output, &entry?.file_name(), depth + 1, quota)?;
        }
    } else if metadata.is_file() {
        let reader = source.open_with(
            name,
            OpenOptions::new()
                .read(true)
                .follow(FollowSymlinks::No)
                .custom_flags(rustix::fs::OFlags::NONBLOCK.bits().cast_signed()),
        )?;
        let opened = reader.metadata()?;
        if !opened.is_file() {
            return Err(ErrorKind::InvalidInput.into());
        }
        if opened.len() > quota.remaining_bytes {
            return Err(ErrorKind::FileTooLarge.into());
        }
        let mut writer =
            destination.open_with(name, OpenOptions::new().write(true).create_new(true))?;
        let mut limited = io::Read::take(reader, quota.remaining_bytes.saturating_add(1));
        let copied = io::copy(&mut limited, &mut writer)?;
        if copied > quota.remaining_bytes {
            return Err(ErrorKind::FileTooLarge.into());
        }
        quota.remaining_bytes -= copied;
        writer.set_permissions(cap_std::fs::Permissions::from_mode(
            opened.permissions().mode() & 0o777,
        ))?;
    } else if metadata.is_symlink() {
        destination.symlink_contents(source.read_link_contents(name)?, name)?;
    } else {
        return Err(ErrorKind::InvalidInput.into());
    }
    Ok(())
}

#[cfg(not(feature = "mac-app-store"))]
fn copy_name(name: &OsStr, directory: bool, attempt: usize) -> OsString {
    if attempt == 0 {
        return name.to_owned();
    }
    let path = Path::new(name);
    let mut result = if directory {
        name
    } else {
        path.file_stem().unwrap_or(name)
    }
    .to_owned();
    if attempt == 1 {
        result.push(" copy");
    } else {
        result.push(format!(" copy {attempt}"));
    }
    if let Some(extension) = path.extension().filter(|_| !directory) {
        result.push(".");
        result.push(extension);
    }
    result
}

#[cfg(all(test, not(feature = "mac-app-store")))]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn reveals_local_entries_and_uses_the_containing_folder_for_missing_files() {
        let sandbox = tempfile::tempdir().unwrap();
        let root = sandbox.path().canonicalize().unwrap();
        fs::create_dir(root.join("src")).unwrap();
        fs::write(root.join("src/report.go"), "package report").unwrap();
        let locate = |path, action| {
            let (directory, _) = Repository::open_directory(&root, None).unwrap();
            LocatedItem::locate(root.clone(), directory, path, action)
        };
        let file = locate("src/report.go", FinderAction::Reveal).unwrap();
        assert_eq!(file.relative, Path::new("src/report.go"));
        assert!(!file.is_directory);
        let folder = locate("src/old/report.go", FinderAction::Reveal).unwrap();
        assert_eq!(folder.relative, Path::new("src"));
        assert!(folder.is_directory);
        assert!(locate("src/old/report.go", FinderAction::Copy).is_err());
        assert!(locate("../somewhere", FinderAction::Reveal).is_err());
    }

    #[test]
    fn resolves_native_file_references_from_the_clipboard() {
        let sandbox = tempfile::tempdir().unwrap();
        let path = sandbox.path().canonicalize().unwrap();
        let file =
            NSURL::fileURLWithPath_isDirectory(&NSString::from_str(path.to_str().unwrap()), true);
        let reference = file.fileReferenceURL().unwrap();
        assert_eq!(
            clipboard_path(&reference.absoluteString().unwrap()),
            Some(path)
        );
        assert!(clipboard_path(ns_string!("https://example.invalid/file")).is_none());
    }

    #[test]
    fn pastes_without_overwriting_and_keeps_directory_symlinks_as_links() {
        let sandbox = tempfile::tempdir().unwrap();
        let root = sandbox.path().canonicalize().unwrap();
        let source = root.join("source");
        let destination = root.join("destination");
        fs::create_dir_all(source.join("nested")).unwrap();
        fs::create_dir(&destination).unwrap();
        let input = source.join("note.txt");
        fs::write(&input, "source note").unwrap();
        fs::write(destination.join("note.txt"), "existing note").unwrap();
        fs::write(source.join("nested").join("item.txt"), "nested item").unwrap();
        std::os::unix::fs::symlink(&input, source.join("note-link")).unwrap();
        let directory = Dir::open_ambient_dir(&destination, ambient_authority()).unwrap();

        copy_into(&input, &directory, &destination).unwrap();
        copy_into(&input, &directory, &destination).unwrap();
        copy_into(&source, &directory, &destination).unwrap();
        assert_eq!(
            fs::read_to_string(destination.join("note.txt")).unwrap(),
            "existing note"
        );
        assert_eq!(
            fs::read_to_string(destination.join("note copy.txt")).unwrap(),
            "source note"
        );
        assert_eq!(
            fs::read_to_string(destination.join("note copy 2.txt")).unwrap(),
            "source note"
        );
        assert_eq!(
            fs::read_to_string(destination.join("source/nested/item.txt")).unwrap(),
            "nested item"
        );
        assert_eq!(
            fs::read_link(destination.join("source/note-link")).unwrap(),
            input
        );
        let nested = source.join("nested");
        let inside = Dir::open_ambient_dir(&nested, ambient_authority()).unwrap();
        assert!(copy_into(&source, &inside, &nested).is_err());
        assert_eq!(fs::read_dir(destination).unwrap().count(), 4);
    }

    #[test]
    fn rejects_nested_git_directories_during_paste() {
        let sandbox = tempfile::tempdir().unwrap();
        let root = sandbox.path().canonicalize().unwrap();
        let source = root.join("repo-copy");
        let destination = root.join("destination");
        fs::create_dir_all(source.join("nested/.git")).unwrap();
        fs::write(source.join("nested/.git/HEAD"), "ref: refs/heads/main\n").unwrap();
        fs::create_dir(&destination).unwrap();
        let directory = Dir::open_ambient_dir(&destination, ambient_authority()).unwrap();
        assert!(copy_into(&source, &directory, &destination).is_err());
    }
}
