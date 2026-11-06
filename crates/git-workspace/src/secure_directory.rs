//! Pin directory handles and never resolve managed paths through ambient I/O.
use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::fs::{Dir, OpenOptions};
use std::{
    io::{self, Read, Write},
    path::{Component, Path},
};
use uuid::Uuid;

pub(super) struct WorkspaceDirectory(Dir);

impl WorkspaceDirectory {
    pub fn open(repository: &Path, create: bool) -> io::Result<Option<Self>> {
        let repo = Dir::open_ambient_dir(repository, cap_std::ambient_authority())?;
        match repo.open_dir_nofollow(super::WORKSPACE_DIRECTORY) {
            Ok(dir) => return Ok(Some(Self(dir))),
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
        match repo.open_dir_nofollow(super::LEGACY_WORKSPACE_DIRECTORY) {
            Ok(dir) => {
                if create {
                    // Windows directory handles can deny rename while open.
                    // Reopen the destination without following links so a
                    // replacement during migration cannot become our root.
                    drop(dir);
                    repo.rename(
                        super::LEGACY_WORKSPACE_DIRECTORY,
                        &repo,
                        super::WORKSPACE_DIRECTORY,
                    )?;
                    return repo
                        .open_dir_nofollow(super::WORKSPACE_DIRECTORY)
                        .map(|dir| Some(Self(dir)));
                }
                return Ok(Some(Self(dir)));
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
        if !create {
            return Ok(None);
        }
        match repo.create_dir(super::WORKSPACE_DIRECTORY) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e),
        }
        repo.open_dir_nofollow(super::WORKSPACE_DIRECTORY)
            .map(|dir| Some(Self(dir)))
    }

    fn parent(&self, relative: &str, create: bool) -> io::Result<(Dir, std::ffi::OsString)> {
        let components: Vec<_> = Path::new(relative).components().collect();
        if components.is_empty()
            || components
                .iter()
                .any(|c| !matches!(c, Component::Normal(_)))
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "Unsafe managed path",
            ));
        }
        let mut parent = self.0.try_clone()?;
        for component in &components[..components.len() - 1] {
            let name = component.as_os_str();
            if create {
                match parent.create_dir(name) {
                    Ok(()) => {}
                    Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
                    Err(e) => return Err(e),
                }
            }
            parent = parent.open_dir_nofollow(name)?;
        }
        Ok((
            parent,
            components
                .last()
                .expect("nonempty components")
                .as_os_str()
                .to_owned(),
        ))
    }

    pub fn read(&self, relative: &str) -> io::Result<Option<String>> {
        let read = || -> io::Result<String> {
            let (parent, name) = self.parent(relative, false)?;
            let mut options = OpenOptions::new();
            options.read(true).follow(FollowSymlinks::No);
            let mut file = parent.open_with(name, &options)?;
            if !file.metadata()?.is_file() {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "Expected a managed file",
                ));
            }
            let mut text = String::new();
            file.read_to_string(&mut text)?;
            Ok(text)
        };
        match read() {
            Ok(text) => Ok(Some(text)),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }

    pub fn write(&self, relative: &str, content: &str) -> io::Result<()> {
        let (parent, name) = self.parent(relative, true)?;
        match parent.symlink_metadata(&name) {
            Ok(m) if !m.is_file() => {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "Expected a regular managed file",
                ));
            }
            Ok(_) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
        // Replace the directory entry instead of truncating an existing inode:
        // a raced symlink or a pre-existing hard link cannot alter another file.
        let temporary = format!(".nodal-write-{}", Uuid::new_v4());
        let result = (|| {
            let mut file =
                parent.open_with(&temporary, OpenOptions::new().write(true).create_new(true))?;
            file.write_all(content.as_bytes())?;
            file.sync_all()?;
            drop(file);
            parent.rename(&temporary, &parent, &name)
        })();
        if result.is_err() {
            let _ = parent.remove_file(&temporary);
        }
        result
    }

    pub fn remove(&self, relative: &str) -> io::Result<bool> {
        let (parent, name) = match self.parent(relative, false) {
            Ok(value) => value,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(false),
            Err(e) => return Err(e),
        };
        match parent.symlink_metadata(&name) {
            Ok(m) if !m.is_file() => {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "Expected a regular managed file",
                ));
            }
            Ok(_) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(false),
            Err(e) => return Err(e),
        }
        parent.remove_file(name)?;
        Ok(true)
    }
}
