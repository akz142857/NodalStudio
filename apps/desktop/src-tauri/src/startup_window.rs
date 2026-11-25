use tauri::utils::config::WindowConfig;
use tauri::{
    App, LogicalSize, Manager, PhysicalPosition, PhysicalRect, PhysicalSize, WebviewWindow,
};

pub(super) fn show_main_window(app: &App) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };
    if let Some(config) = app
        .config()
        .app
        .windows
        .iter()
        .find(|config| config.label == window.label())
        && config.resizable
        && !config.fullscreen
        && !config.maximized
        && let Err(error) = fit_to_monitor(&window, config)
    {
        eprintln!("Unable to fit the main window to the display: {error}");
    }
    window.show()
}

fn fit_to_monitor(window: &WebviewWindow, config: &WindowConfig) -> tauri::Result<()> {
    let Some(monitor) = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten())
    else {
        return Ok(());
    };
    let area = monitor.work_area();
    if area.size.width == 0 || area.size.height == 0 {
        return Ok(());
    }
    let outer = window.outer_size()?;
    let inner = window.inner_size()?;
    let frame = PhysicalSize::new(
        outer.width.saturating_sub(inner.width),
        outer.height.saturating_sub(inner.height),
    );
    let scale = monitor.scale_factor();
    let preferred = LogicalSize::new(config.width, config.height).to_physical(scale);
    let (size, position) = launch_layout(area, frame, preferred);
    let minimum = LogicalSize::new(
        config.min_width.unwrap_or_default(),
        config.min_height.unwrap_or_default(),
    )
    .to_physical::<u32>(scale);
    if minimum.width > size.width || minimum.height > size.height {
        window.set_min_size(Some(PhysicalSize::new(
            minimum.width.min(size.width),
            minimum.height.min(size.height),
        )))?;
    }
    window.set_size(size)?;
    window.set_position(position)
}

fn launch_layout(
    area: &PhysicalRect<i32, u32>,
    frame: PhysicalSize<u32>,
    preferred: PhysicalSize<u32>,
) -> (PhysicalSize<u32>, PhysicalPosition<i32>) {
    // Keep the configured workspace size where possible, with margins on larger displays.
    let fit = |available: u32, frame: u32, preferred: u32| {
        (available - available / 10)
            .max(preferred.saturating_add(frame))
            .min(available)
    };
    let width = fit(area.size.width, frame.width, preferred.width);
    let height = fit(area.size.height, frame.height, preferred.height);
    (
        PhysicalSize::new(
            width.saturating_sub(frame.width).max(1),
            height.saturating_sub(frame.height).max(1),
        ),
        PhysicalPosition::new(
            area.position
                .x
                .saturating_add_unsigned((area.size.width - width) / 2),
            area.position
                .y
                .saturating_add_unsigned((area.size.height - height) / 2),
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fills_a_small_display_without_covering_system_chrome() {
        let area = PhysicalRect {
            position: PhysicalPosition::new(-1280, 24),
            size: PhysicalSize::new(1280, 720),
        };
        let (size, position) = launch_layout(
            &area,
            PhysicalSize::new(0, 28),
            PhysicalSize::new(1440, 920),
        );
        assert_eq!(size, PhysicalSize::new(1280, 692));
        assert_eq!(position, area.position);
    }

    #[test]
    fn centers_an_expanded_window_in_the_scaled_work_area() {
        let area = PhysicalRect {
            position: PhysicalPosition::new(0, 64),
            size: PhysicalSize::new(3840, 2080),
        };
        let preferred = LogicalSize::new(1440., 920.).to_physical(2.);
        let (size, position) = launch_layout(&area, PhysicalSize::new(0, 56), preferred);
        assert_eq!(size, PhysicalSize::new(3456, 1840));
        assert_eq!(position, PhysicalPosition::new(192, 156));
    }
}
