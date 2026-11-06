//! Real filesystem regressions; all fixtures are isolated temporary directories.
#![cfg(unix)]
use git_workspace::{
    WorkspaceFiles, WorkspaceInput, preview_workspace, read_workspace, render_workspace,
    write_workspace,
};
use schema_model::{DatabaseInfo, DatabaseSnapshot, DatabaseType};
use std::{fs, os::unix::fs::symlink, path::PathBuf};
use uuid::Uuid;

struct Fixture {
    root: PathBuf,
    repo: PathBuf,
    outside: PathBuf,
    files: WorkspaceFiles,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("nodal-boundary-{}", Uuid::new_v4()));
        let repo = root.join("repository");
        let outside = root.join("outside");
        fs::create_dir_all(&repo).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("README.md"), "Unrelated user file").unwrap();
        let mut snapshot = DatabaseSnapshot::new(
            Uuid::new_v4(),
            DatabaseInfo {
                name: "synthetic".into(),
                database_type: DatabaseType::PostgreSql,
                version: "17".into(),
            },
            vec![],
        );
        snapshot.canonicalize().unwrap();
        let files = render_workspace(&WorkspaceInput {
            snapshot: &snapshot,
            annotations: &[],
            domain_groups: &[],
            saved_views: &[],
            provenance: &[],
            lineage: &[],
            relationships: &[],
        })
        .unwrap();
        write_workspace(&repo, &files).unwrap();
        Self {
            root,
            repo,
            outside,
            files,
        }
    }
    fn assert_outside_unchanged(&self) {
        assert_eq!(
            fs::read_to_string(self.outside.join("README.md")).unwrap(),
            "Unrelated user file"
        );
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn linked_leaf_is_rejected_for_export_preview_and_import() {
    let fixture = Fixture::new();
    let leaf = fixture.repo.join(".nodalstudio/README.md");
    fs::remove_file(&leaf).unwrap();
    symlink(fixture.outside.join("README.md"), leaf).unwrap();
    assert!(write_workspace(&fixture.repo, &fixture.files).is_err());
    assert!(preview_workspace(&fixture.repo, &fixture.files).is_err());
    assert!(read_workspace(&fixture.repo).is_err());
    fixture.assert_outside_unchanged();
}

#[test]
fn workspace_roots_and_legacy_roots_cannot_be_links() {
    for name in [".nodalstudio", ".sqlaieditor"] {
        let fixture = Fixture::new();
        fs::remove_dir_all(fixture.repo.join(".nodalstudio")).unwrap();
        symlink(&fixture.outside, fixture.repo.join(name)).unwrap();
        assert!(write_workspace(&fixture.repo, &fixture.files).is_err());
        assert!(preview_workspace(&fixture.repo, &fixture.files).is_err());
        assert!(read_workspace(&fixture.repo).is_err());
        fixture.assert_outside_unchanged();
    }
}

#[test]
fn linked_parent_cannot_be_used_for_writes_or_stale_deletion() {
    for stale in [false, true] {
        let mut fixture = Fixture::new();
        symlink(&fixture.outside, fixture.repo.join(".nodalstudio/linked")).unwrap();
        if stale {
            let manifest_path = fixture.repo.join(".nodalstudio/project.json");
            let mut manifest: serde_json::Value =
                serde_json::from_str(&fs::read_to_string(&manifest_path).unwrap()).unwrap();
            manifest["managedFiles"]
                .as_array_mut()
                .unwrap()
                .push("linked/README.md".into());
            fs::write(manifest_path, serde_json::to_string(&manifest).unwrap()).unwrap();
        } else {
            fixture
                .files
                .files
                .insert("linked/README.md".into(), "replacement".into());
        }
        assert!(preview_workspace(&fixture.repo, &fixture.files).is_err());
        assert!(write_workspace(&fixture.repo, &fixture.files).is_err());
        fixture.assert_outside_unchanged();
    }
}

#[test]
fn manifest_cannot_be_a_link_and_hard_linked_outputs_are_replaced_without_truncation() {
    let fixture = Fixture::new();
    let manifest = fixture.repo.join(".nodalstudio/project.json");
    fs::rename(&manifest, fixture.outside.join("manifest.json")).unwrap();
    symlink(fixture.outside.join("manifest.json"), &manifest).unwrap();
    assert!(read_workspace(&fixture.repo).is_err());
    assert!(write_workspace(&fixture.repo, &fixture.files).is_err());
    fs::remove_file(&manifest).unwrap();
    fs::rename(fixture.outside.join("manifest.json"), &manifest).unwrap();
    let leaf = fixture.repo.join(".nodalstudio/README.md");
    fs::remove_file(&leaf).unwrap();
    fs::hard_link(fixture.outside.join("README.md"), leaf).unwrap();
    write_workspace(&fixture.repo, &fixture.files).unwrap();
    fixture.assert_outside_unchanged();
    assert_eq!(
        preview_workspace(&fixture.repo, &fixture.files)
            .unwrap()
            .modified_files,
        0
    );
}
