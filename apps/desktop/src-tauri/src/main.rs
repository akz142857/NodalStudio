#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

fn main() {
    if nodalstudio_desktop_lib::run_askpass_helper() { return; }
    nodalstudio_desktop_lib::run();
}
