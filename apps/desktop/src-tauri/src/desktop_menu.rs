//! Keep macOS window actions native while routing Close to the current workspace.
use tauri::{
    AppHandle, Emitter, Manager, Wry,
    menu::{Menu, MenuEvent, MenuItem, Submenu, WINDOW_SUBMENU_ID},
};

const CLOSE: &str = "workspace-close";
const CLOSE_WINDOW: &str = "workspace-close-window";

fn remove_close_window_item(submenu: &Submenu<Wry>) -> tauri::Result<()> {
    for item in submenu.items()? {
        let is_close = item
            .as_predefined_menuitem()
            .and_then(|predefined| predefined.text().ok())
            .or_else(|| {
                item.as_menuitem()
                    .and_then(|menu_item| menu_item.text().ok())
            })
            .is_some_and(|text| text.eq_ignore_ascii_case("Close Window"));
        if is_close {
            submenu.remove(&item)?;
            return Ok(());
        }
    }
    Ok(())
}

pub(super) fn menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let menu = Menu::default(app)?;
    for item in menu.items()? {
        let Some(submenu) = item.as_submenu() else {
            continue;
        };
        if submenu.text()? == "File" {
            // Tauri's default Mac File menu contains Close Window.
            remove_close_window_item(submenu)?;
            submenu.append(&MenuItem::with_id(
                app,
                CLOSE,
                "Close",
                true,
                Some("Cmd+W"),
            )?)?;
        } else if submenu.id().as_ref() == WINDOW_SUBMENU_ID {
            // Remove the second default Cmd+W accelerator from the Window menu.
            remove_close_window_item(submenu)?;
            submenu.append(&MenuItem::with_id(
                app,
                CLOSE_WINDOW,
                "Close Window",
                true,
                Some("Cmd+Shift+W"),
            )?)?;
        }
    }
    Ok(menu)
}

pub(super) fn on_menu_event(app: &AppHandle, event: &MenuEvent) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    match event.id().as_ref() {
        CLOSE => {
            let _ = window.emit_to("main", "nodalstudio-native-close", ());
        }
        CLOSE_WINDOW => {
            let _ = window.close();
        }
        _ => {}
    }
}
