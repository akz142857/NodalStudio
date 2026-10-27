fn main() {
    if cfg!(feature = "mac-app-store") {
        // Static dependency link arguments do not propagate to this final binary.
        println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
        assert!(
            std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos"),
            "MAS requires macOS"
        );
        assert!(
            std::env::var_os("CARGO_FEATURE_UPDATER_SMOKE_TEST").is_none(),
            "MAS cannot contain updater test overrides"
        );
    }
    tauri_build::build();
}
