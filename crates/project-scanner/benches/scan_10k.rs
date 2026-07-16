use std::{
    collections::BTreeMap,
    fs,
    time::{Duration, Instant},
};

use project_scanner::{ScanOptions, scan_project};

fn main() {
    let root = std::env::temp_dir().join(format!("nodalstudio-scan-bench-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(root.join("src")).expect("create benchmark root");
    for index in 0..10_000 {
        fs::write(
            root.join("src").join(format!("module-{index}.ts")),
            format!("export const value{index} = {index};\n"),
        )
        .expect("write fixture");
    }
    let started = Instant::now();
    let output =
        scan_project(&root, &BTreeMap::new(), &ScanOptions::default()).expect("scan fixture");
    let elapsed = started.elapsed();
    assert_eq!(output.files.len(), 10_000);
    assert!(
        elapsed < Duration::from_mins(1),
        "10k scan took {elapsed:?}, above the P0 target"
    );
    fs::remove_dir_all(root).expect("clean benchmark root");
    eprintln!("10,000 files scanned in {elapsed:?}");
}
