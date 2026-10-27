//! Read only the user-authorized worktree; never launch Xcode's git shim in MAS.
use std::path::Path;

pub fn has_git_marker(root: &Path) -> bool {
    let marker = root.join(".git");
    let Ok(metadata) = std::fs::symlink_metadata(&marker) else {
        return false;
    };
    if metadata.file_type().is_symlink() {
        return false;
    }
    if metadata.is_dir() {
        return marker.join("HEAD").is_file() && marker.join("objects").is_dir();
    }
    // Worktrees/submodules keep metadata elsewhere. Detect their marker without
    // following it outside the folder authorized through the system picker.
    metadata.len() <= 8192
        && std::fs::read_to_string(marker).is_ok_and(|text| {
            let mut lines = text.lines();
            lines
                .next()
                .and_then(|line| line.strip_prefix("gitdir: "))
                .is_some_and(|path| !path.trim().is_empty() && !path.contains('\0'))
                && lines.next().is_none()
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn detects_repository_and_worktree_without_following_external_metadata() {
        let root = tempfile::tempdir().unwrap();
        assert!(!has_git_marker(root.path()));
        let marker = root.path().join(".git");
        std::fs::write(&marker, "gitdir: /not-authorized/external\n").unwrap();
        assert!(has_git_marker(root.path()));
        for invalid in ["gitdir: \n", "not git", "gitdir: /tmp/git\ninjected"] {
            std::fs::write(&marker, invalid).unwrap();
            assert!(!has_git_marker(root.path()));
        }
        std::fs::remove_file(&marker).unwrap();
        std::fs::create_dir_all(marker.join("objects")).unwrap();
        assert!(!has_git_marker(root.path()));
        std::fs::write(marker.join("HEAD"), "ref: refs/heads/main\n").unwrap();
        assert!(has_git_marker(root.path()));
    }
    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_marker() {
        let root = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink("/outside/.git", root.path().join(".git")).unwrap();
        assert!(!has_git_marker(root.path()));
    }
}
