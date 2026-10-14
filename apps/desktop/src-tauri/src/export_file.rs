use std::{fs, io::Write, path::Path};

pub const MAX_EXPORT_BYTES: usize = 32 * 1024 * 1024;

/// Save generated content in Downloads with an exclusive create, never replacing a file.
pub fn save_bytes(
    file_name: &str,
    data: &[u8],
    extension: &str,
    directory: &Path,
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
    if data.is_empty() || data.len() > MAX_EXPORT_BYTES {
        return Err("The export must be smaller than 32 MB.".into());
    }
    if !directory.is_dir() {
        return Err("The Downloads directory is unavailable.".into());
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
                    return Err("Unable to save the export in Downloads.".into());
                }
                return Ok(path.to_string_lossy().into_owned());
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err("Unable to save the export in Downloads.".into()),
        }
    }
    Err("Too many exports with this filename. Rename existing downloads and try again.".into())
}
