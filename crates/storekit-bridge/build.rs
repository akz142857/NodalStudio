use std::{env, path::PathBuf, process::Command};
fn main() {
    println!("cargo:rerun-if-changed=native/Purchase.swift");
    println!("cargo:rerun-if-changed=native/FileAccess.swift");
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    let arch = match env::var("CARGO_CFG_TARGET_ARCH").unwrap().as_str() {
        "aarch64" => "arm64",
        "x86_64" => "x86_64",
        _ => panic!("Unsupported MAS architecture"),
    };
    let out = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    let output = Command::new("xcrun")
        .args(["--show-sdk-path"])
        .output()
        .expect("Xcode SDK");
    assert!(output.status.success(), "Xcode SDK unavailable");
    let sdk = String::from_utf8(output.stdout).unwrap();
    let status = Command::new("xcrun")
        .args([
            "swiftc",
            "-parse-as-library",
            "-emit-library",
            "-static",
            "-O",
            "-swift-version",
            "6",
            "-target",
            &format!("{arch}-apple-macosx13.0"),
            "-sdk",
            sdk.trim(),
            "-module-name",
            "NodalPurchase",
            "-module-cache-path",
            out.join("swift-cache").to_str().unwrap(),
            "native/Purchase.swift",
            "native/FileAccess.swift",
            "-o",
        ])
        .arg(out.join("libNodalPurchase.a"))
        .status()
        .expect("Swift compiler");
    assert!(status.success(), "StoreKit bridge compilation failed");
    println!("cargo:rustc-link-search=native={}", out.display());
    println!("cargo:rustc-link-lib=static=NodalPurchase");
    println!(
        "cargo:rustc-link-search=native={}/usr/lib/swift",
        sdk.trim()
    );
    println!("cargo:rustc-link-search=native=/usr/lib/swift");
    for framework in ["Foundation", "StoreKit", "CryptoKit"] {
        println!("cargo:rustc-link-lib=framework={framework}");
    }
    println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
}
