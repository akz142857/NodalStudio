use std::{
    fs::File,
    io::{self, BufReader, Write},
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use tempfile::NamedTempFile;
use uuid::Uuid;

use super::files::RootIdentity;

const STORAGE_UNAVAILABLE: &str = "codeReviewProjectListUnavailable";
pub(super) const PROJECT_UNAVAILABLE: &str = "codeReviewSavedProjectUnavailable";

const FORMAT_VERSION: u16 = 1;

const fn default_format_version() -> u16 {
    FORMAT_VERSION
}

#[derive(Deserialize, Serialize)]
pub(super) struct ProjectCatalog {
    #[serde(default = "default_format_version")]
    format_version: u16,
    // Most recently selected first, including pinned projects.
    projects: Vec<SavedProject>,
    #[serde(default)]
    groups: Vec<SavedProjectGroup>,
}

impl Default for ProjectCatalog {
    fn default() -> Self {
        Self {
            format_version: FORMAT_VERSION,
            projects: Vec::new(),
            groups: Vec::new(),
        }
    }
}

#[derive(Clone, Deserialize, Serialize)]
pub(super) struct SavedProject {
    pub(super) id: Uuid,
    pub(super) root: PathBuf,
    pub(super) identity: RootIdentity,
    pub(super) review_key: String,
    pinned: bool,
    #[serde(default)]
    group_id: Option<Uuid>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SavedProjectInfo {
    id: Uuid,
    name: String,
    path: String,
    pinned: bool,
    group_id: Option<Uuid>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SavedProjectGroup {
    id: Uuid,
    name: String,
    collapsed: bool,
    #[serde(default)]
    color: Option<ProjectGroupColor>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ProjectGroupColor {
    Red,
    Orange,
    Yellow,
    Green,
    Blue,
    Purple,
    Gray,
}

#[derive(Serialize)]
pub(crate) struct ProjectCatalogInfo {
    projects: Vec<SavedProjectInfo>,
    groups: Vec<SavedProjectGroup>,
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum ProjectGroupAction {
    Create {
        name: String,
    },
    Rename {
        id: Uuid,
        name: String,
    },
    Remove {
        id: Uuid,
    },
    Collapse {
        id: Uuid,
        collapsed: bool,
    },
    Color {
        id: Uuid,
        color: Option<ProjectGroupColor>,
    },
    Move {
        project_id: Uuid,
        group_id: Option<Uuid>,
    },
}

impl ProjectCatalog {
    pub(super) fn load(path: &Path) -> Result<Self, String> {
        match File::open(path) {
            Ok(file) => serde_json::from_reader(BufReader::new(file))
                .map_err(|_| STORAGE_UNAVAILABLE.into()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Self::default()),
            Err(_) => Err(STORAGE_UNAVAILABLE.into()),
        }
    }

    pub(super) fn save(&self, path: &Path) -> Result<(), String> {
        let mut file = NamedTempFile::new_in(path.parent().ok_or(STORAGE_UNAVAILABLE)?)
            .map_err(|_| STORAGE_UNAVAILABLE)?;
        serde_json::to_writer(file.as_file_mut(), self).map_err(|_| STORAGE_UNAVAILABLE)?;
        file.flush().map_err(|_| STORAGE_UNAVAILABLE)?;
        file.as_file().sync_all().map_err(|_| STORAGE_UNAVAILABLE)?;
        file.persist(path).map_err(|_| STORAGE_UNAVAILABLE)?;
        Ok(())
    }

    pub(super) fn list(&self) -> Vec<SavedProjectInfo> {
        self.projects
            .iter()
            .map(|entry| SavedProjectInfo {
                id: entry.id,
                name: entry
                    .root
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned(),
                path: entry.root.to_string_lossy().into_owned(),
                pinned: entry.pinned,
                group_id: entry.group_id,
            })
            .collect()
    }

    pub(super) fn info(&self) -> ProjectCatalogInfo {
        ProjectCatalogInfo {
            projects: self.list(),
            groups: self.groups.clone(),
        }
    }

    pub(super) fn edit_groups(&mut self, action: ProjectGroupAction) -> Result<(), String> {
        match action {
            ProjectGroupAction::Create { name } => {
                let name = self.group_name(&name, None)?;
                self.groups.push(SavedProjectGroup {
                    id: Uuid::new_v4(),
                    name,
                    collapsed: false,
                    color: None,
                });
            }
            ProjectGroupAction::Rename { id, name } => {
                let name = self.group_name(&name, Some(id))?;
                let position = self.group_position(id)?;
                self.groups[position].name = name;
            }
            ProjectGroupAction::Remove { id } => {
                self.groups.remove(self.group_position(id)?);
                for project in &mut self.projects {
                    if project.group_id == Some(id) {
                        project.group_id = None;
                    }
                }
            }
            ProjectGroupAction::Collapse { id, collapsed } => {
                let position = self.group_position(id)?;
                self.groups[position].collapsed = collapsed;
            }
            ProjectGroupAction::Color { id, color } => {
                let position = self.group_position(id)?;
                self.groups[position].color = color;
            }
            ProjectGroupAction::Move {
                project_id,
                group_id,
            } => {
                if let Some(id) = group_id {
                    self.group_position(id)?;
                }
                let position = self.position(project_id)?;
                self.projects[position].group_id = group_id;
            }
        }
        Ok(())
    }

    fn group_position(&self, id: Uuid) -> Result<usize, String> {
        self.groups
            .iter()
            .position(|group| group.id == id)
            .ok_or_else(|| PROJECT_UNAVAILABLE.into())
    }

    fn group_name(&self, name: &str, excluded: Option<Uuid>) -> Result<String, String> {
        let name = name.trim();
        if name.is_empty() || name.chars().count() > 80 || name.chars().any(char::is_control) {
            return Err("codeReviewInvalidGroupName".into());
        }
        if self.groups.iter().any(|group| {
            Some(group.id) != excluded && group.name.to_lowercase() == name.to_lowercase()
        }) {
            return Err("codeReviewDuplicateGroupName".into());
        }
        Ok(name.to_owned())
    }

    pub(super) fn get(&self, id: Uuid) -> Result<&SavedProject, String> {
        self.projects
            .iter()
            .find(|entry| entry.id == id)
            .ok_or_else(|| PROJECT_UNAVAILABLE.into())
    }

    pub(super) fn review_key(&self, identity: &RootIdentity) -> Option<&str> {
        self.projects
            .iter()
            .find(|entry| &entry.identity == identity)
            .map(|entry| entry.review_key.as_str())
    }

    pub(super) fn register(
        &mut self,
        root: &Path,
        identity: &RootIdentity,
        review_key: &str,
        relocating: Option<Uuid>,
    ) -> Result<SavedProject, String> {
        let existing = self
            .projects
            .iter()
            .position(|entry| &entry.identity == identity);
        let position = if let Some(id) = relocating {
            let position = self.position(id)?;
            if existing.is_some_and(|existing| existing != position) {
                return Err("codeReviewProjectAlreadyAdded".into());
            }
            Some(position)
        } else {
            existing
        };
        let entry = position.map_or_else(
            || SavedProject {
                id: Uuid::new_v4(),
                root: root.to_path_buf(),
                identity: identity.clone(),
                review_key: review_key.to_owned(),
                pinned: false,
                group_id: None,
            },
            |position| {
                let mut entry = self.projects.remove(position);
                entry.root = root.to_path_buf();
                if &entry.identity != identity {
                    entry.identity = identity.clone();
                    review_key.clone_into(&mut entry.review_key);
                }
                entry
            },
        );
        self.projects.insert(0, entry.clone());
        Ok(entry)
    }

    pub(super) fn select(&mut self, id: Uuid) -> Result<(), String> {
        let position = self.position(id)?;
        self.projects[..=position].rotate_right(1);
        Ok(())
    }

    pub(super) fn pin(&mut self, id: Uuid, pinned: bool) -> Result<(), String> {
        let position = self.position(id)?;
        self.projects[position].pinned = pinned;
        Ok(())
    }

    pub(super) fn remove(&mut self, id: Uuid) -> Result<SavedProject, String> {
        let position = self.position(id)?;
        Ok(self.projects.remove(position))
    }

    pub(super) fn roots(&self) -> Vec<PathBuf> {
        self.projects
            .iter()
            .map(|entry| entry.root.clone())
            .collect()
    }

    fn position(&self, id: Uuid) -> Result<usize, String> {
        self.projects
            .iter()
            .position(|entry| entry.id == id)
            .ok_or_else(|| PROJECT_UNAVAILABLE.into())
    }
}

#[cfg(all(test, not(feature = "mac-app-store")))]
mod tests {
    use super::*;
    use crate::code_view::files::Repository;
    use std::fs;

    #[test]
    fn persists_pins_deduplicates_folders_and_recovers_a_moved_project() {
        let workspace = tempfile::tempdir().unwrap();
        let path = workspace.path().join("projects.json");
        let first = workspace.path().join("first");
        let second = workspace.path().join("second");
        fs::create_dir(&first).unwrap();
        fs::create_dir(&second).unwrap();
        let (_, first_identity) = Repository::open_directory(&first, None).unwrap();
        let (_, second_identity) = Repository::open_directory(&second, None).unwrap();
        let mut catalog = ProjectCatalog::load(&path).unwrap();
        let one = catalog
            .register(&first, &first_identity, "first-review", None)
            .unwrap();
        let two = catalog
            .register(&second, &second_identity, "second-review", None)
            .unwrap();
        catalog.pin(one.id, true).unwrap();
        catalog.save(&path).unwrap();

        let mut catalog = ProjectCatalog::load(&path).unwrap();
        assert_eq!(
            catalog
                .list()
                .iter()
                .map(|row| (row.id, row.pinned))
                .collect::<Vec<_>>(),
            [(two.id, false), (one.id, true)]
        );
        assert!(
            catalog
                .register(&second, &second_identity, "second-review", Some(one.id))
                .is_err()
        );
        catalog.select(one.id).unwrap();
        assert_eq!(catalog.list()[0].id, one.id);

        let moved = workspace.path().join("moved");
        fs::rename(&first, &moved).unwrap();
        fs::create_dir(&first).unwrap();
        assert!(Repository::open_directory(&first, Some(&one.identity)).is_err());
        let moved_entry = catalog
            .register(&moved, &first_identity, "key-at-new-path", Some(one.id))
            .unwrap();
        assert_eq!(moved_entry.id, one.id);
        assert_eq!(moved_entry.review_key, "first-review");
        assert!(moved_entry.pinned);
        assert_eq!(
            catalog
                .register(&moved, &first_identity, "key-at-new-path", None)
                .unwrap()
                .id,
            one.id
        );
        catalog.remove(one.id).unwrap();
        assert!(moved.is_dir());
        assert_eq!(catalog.list().len(), 1);
    }

    #[test]
    fn persists_group_membership_and_removes_only_the_group() {
        let workspace = tempfile::tempdir().unwrap();
        let file = workspace.path().join("projects.json");
        let root = workspace.path().join("repository");
        fs::create_dir(&root).unwrap();
        let (_, identity) = Repository::open_directory(&root, None).unwrap();
        let mut catalog: ProjectCatalog = serde_json::from_str(r#"{"projects":[]}"#).unwrap();
        let project = catalog.register(&root, &identity, "review", None).unwrap();
        catalog.pin(project.id, true).unwrap();
        catalog
            .edit_groups(ProjectGroupAction::Create {
                name: "  Backend  ".into(),
            })
            .unwrap();
        let id = catalog.info().groups[0].id;
        assert!(
            catalog
                .edit_groups(ProjectGroupAction::Create {
                    name: "backend".into()
                })
                .is_err()
        );
        catalog
            .edit_groups(ProjectGroupAction::Move {
                project_id: project.id,
                group_id: Some(id),
            })
            .unwrap();
        catalog
            .edit_groups(ProjectGroupAction::Collapse {
                id,
                collapsed: true,
            })
            .unwrap();
        catalog
            .edit_groups(ProjectGroupAction::Color {
                id,
                color: Some(ProjectGroupColor::Orange),
            })
            .unwrap();
        catalog.save(&file).unwrap();

        let mut catalog = ProjectCatalog::load(&file).unwrap();
        assert!(catalog.info().groups[0].collapsed);
        assert_eq!(
            catalog.info().groups[0].color,
            Some(ProjectGroupColor::Orange)
        );
        assert_eq!(catalog.list()[0].group_id, Some(id));
        catalog
            .edit_groups(ProjectGroupAction::Rename {
                id,
                name: "Services".into(),
            })
            .unwrap();
        assert_eq!(catalog.info().groups[0].name, "Services");
        catalog
            .edit_groups(ProjectGroupAction::Remove { id })
            .unwrap();
        assert!(catalog.info().groups.is_empty());
        assert_eq!(catalog.list()[0].group_id, None);
        assert!(catalog.list()[0].pinned);
        assert!(root.is_dir());
    }
}
