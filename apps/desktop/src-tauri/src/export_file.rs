use std::{fs, io::Write, path::Path};

pub const MAX_EXPORT_BYTES: usize = 32 * 1024 * 1024;

/// Save generated content in the selected directory with an exclusive create, never replacing a file.
pub fn save_bytes(
    file_name: &str,
    data: &[u8],
    extension: &str,
    directory: &Path,
) -> Result<String, String> {
    save_bytes_with_limit(file_name, data, extension, directory, MAX_EXPORT_BYTES)
}

pub fn save_bytes_with_limit(
    file_name: &str,
    data: &[u8],
    extension: &str,
    directory: &Path,
    limit: usize,
) -> Result<String, String> {
    if file_name.is_empty()
        || file_name.len() > 180
        || !file_name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
        || !file_name.ends_with(&format!(".{extension}"))
        || file_name.starts_with('.')
    {
        return Err("Choose a valid export filename.".into());
    }
    if data.is_empty() || data.len() > limit {
        return Err(format!(
            "The export must be smaller than {} MB.",
            limit / (1024 * 1024)
        ));
    }
    if !directory.is_dir() {
        return Err("The selected export directory is unavailable.".into());
    }
    let stem = file_name.trim_end_matches(&format!(".{extension}"));
    for suffix in 0..1000 {
        let name = if suffix == 0 {
            file_name.to_owned()
        } else {
            format!("{stem}-{suffix}.{extension}")
        };
        let path = directory.join(name);
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(mut file) => {
                if file.write_all(data).and_then(|()| file.sync_all()).is_err() {
                    let _ = fs::remove_file(&path);
                    return Err("Unable to save the export in the selected directory.".into());
                }
                return Ok(path.to_string_lossy().into_owned());
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err("Unable to save the export in the selected directory.".into()),
        }
    }
    Err("Too many exports with this filename. Rename existing exports and try again.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selected_folder_exports_never_overwrite_and_reject_out_of_scope_paths() {
        let dir = tempfile::tempdir().unwrap();
        let first = save_bytes_with_limit("result.csv", b"one", "csv", dir.path(), 3).unwrap();
        let next = save_bytes_with_limit("result.csv", b"two", "csv", dir.path(), 3).unwrap();
        assert_ne!(first, next);
        assert_eq!(fs::read(first).unwrap(), b"one");
        assert_eq!(fs::read(next).unwrap(), b"two");
        assert!(save_bytes_with_limit("../escape.csv", b"x", "csv", dir.path(), 3).is_err());
        assert!(save_bytes_with_limit("oversize.csv", b"four", "csv", dir.path(), 3).is_err());
        assert!(!dir.path().join("oversize.csv").exists());
    }
}
