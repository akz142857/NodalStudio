//! Native user selection, with operation-scoped persistent access for MAS.
use std::{
    collections::HashSet,
    path::Path,
    sync::{LazyLock, Mutex},
};
use tauri_plugin_dialog::DialogExt;

static SELECTED: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Default::default);

pub struct Access {
    #[cfg(feature = "mac-app-store")]
    _scope: Option<storekit_bridge::FileAccess>,
}
// Keep the same fallible API as the security-scoped MAS implementation.
#[cfg_attr(not(feature = "mac-app-store"), allow(clippy::unnecessary_wraps))]
pub fn access(path: &Path) -> Result<Access, String> {
    #[cfg(feature = "mac-app-store")]
    {
        let path = path.to_str().ok_or("Invalid local path")?;
        if SELECTED
            .lock()
            .map_err(|_| "File permissions unavailable")?
            .contains(path)
        {
            return Ok(Access { _scope: None });
        }
        let scope = storekit_bridge::access_file(path).map_err(str::to_owned)?;
        Ok(Access {
            _scope: Some(scope),
        })
    }
    #[cfg(not(feature = "mac-app-store"))]
    {
        let _ = path;
        Ok(Access {})
    }
}
#[cfg_attr(not(feature = "mac-app-store"), allow(clippy::unnecessary_wraps))]
pub fn remember(path: &Path) -> Result<(), String> {
    #[cfg(feature = "mac-app-store")]
    storekit_bridge::remember_file(path.to_str().ok_or("Invalid local path")?)
        .map_err(str::to_owned)?;
    #[cfg(not(feature = "mac-app-store"))]
    let _ = path;
    Ok(())
}

#[derive(Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SelectionKind {
    OpenSettings,
    SaveSettings,
    OpenBackup,
    SaveBackup,
    Repository,
}

#[tauri::command]
pub async fn pick_workspace_path(
    app: tauri::AppHandle,
    kind: SelectionKind,
) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || {
        let picker = app.dialog().file();
        let result = match kind {
            SelectionKind::Repository => picker
                .set_title("Choose repository folder")
                .blocking_pick_folder(),
            SelectionKind::OpenSettings => picker
                .add_filter("Settings JSON", &["json"])
                .blocking_pick_file(),
            SelectionKind::SaveSettings => picker
                .add_filter("Settings JSON", &["json"])
                .set_file_name("nodal-settings.json")
                .blocking_save_file(),
            SelectionKind::OpenBackup => picker
                .add_filter("Nodal model", &["nodalmodel"])
                .blocking_pick_file(),
            SelectionKind::SaveBackup => picker
                .add_filter("Nodal model", &["nodalmodel"])
                .set_file_name("model.nodalmodel")
                .blocking_save_file(),
        };
        result
            .map(|file| {
                let path = file
                    .into_path()
                    .map_err(|_| "Choose a local file or folder")?;
                if matches!(kind, SelectionKind::Repository) {
                    remember(&path)?;
                } else {
                    SELECTED
                        .lock()
                        .map_err(|_| "File permissions unavailable")?
                        .insert(path.to_string_lossy().into_owned());
                }
                Ok(path.to_string_lossy().into_owned())
            })
            .transpose()
    })
    .await
    .map_err(|_| "Unable to open the system file picker".to_owned())?
}

pub async fn export_directory(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    if !crate::purchase::IS_MAS {
        return app
            .path()
            .download_dir()
            .map_err(|_| "The Downloads directory is unavailable.".into());
    }
    let app = app.clone();
    tokio::task::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("Choose export folder / 选择导出文件夹")
            .blocking_pick_folder()
            .ok_or_else(|| "Export cancelled; no file was written.".to_owned())?
            .into_path()
            .map_err(|_| "Choose a local export folder.".to_owned())
    })
    .await
    .map_err(|_| "Unable to open the export folder picker.".to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn arbitrary_paths_do_not_acquire_mas_permission() {
        let path = std::env::temp_dir().join(format!("nodal-unselected-{}", uuid::Uuid::new_v4()));
        assert_eq!(access(&path).is_err(), crate::purchase::IS_MAS);
    }
    #[test]
    fn picker_modes_are_closed_and_cannot_request_arbitrary_operations() {
        for kind in [
            "openSettings",
            "saveSettings",
            "openBackup",
            "saveBackup",
            "repository",
        ] {
            assert!(serde_json::from_value::<SelectionKind>(serde_json::json!(kind)).is_ok());
        }
        assert!(serde_json::from_value::<SelectionKind>(serde_json::json!("shell")).is_err());
    }
}
