//! Database-independent extension models for provenance, drift, and code lineage.

use chrono::{DateTime, Utc};
use schema_diff::{SchemaChangeSet, diff_snapshots};
use schema_model::{DatabaseSnapshot, ObjectKey};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeProvenance {
    pub change_set_id: Uuid,
    pub branch: Option<String>,
    pub commit_sha: Option<String>,
    pub pull_request_url: Option<String>,
    pub migration_files: Vec<String>,
    pub recorded_at: DateTime<Utc>,
}

impl ChangeProvenance {
    pub fn canonicalize(&mut self) {
        self.migration_files.sort();
        self.migration_files.dedup();
        self.commit_sha = self
            .commit_sha
            .take()
            .map(|value| value.trim().to_ascii_lowercase())
            .filter(|value| !value.is_empty());
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentSnapshot {
    pub environment: String,
    pub snapshot: DatabaseSnapshot,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriftReport {
    pub from_environment: String,
    pub to_environment: String,
    pub in_sync: bool,
    pub change_set: SchemaChangeSet,
}

pub fn compare_environments(from: &EnvironmentSnapshot, to: &EnvironmentSnapshot) -> DriftReport {
    let change_set = diff_snapshots(&from.snapshot, &to.snapshot);
    DriftReport {
        from_environment: from.environment.clone(),
        to_environment: to.environment.clone(),
        in_sync: change_set.operations.is_empty(),
        change_set,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeLineageLink {
    pub object_key: ObjectKey,
    pub language: String,
    pub framework: String,
    pub symbol: String,
    pub file_path: String,
    pub line: Option<u32>,
    pub confidence: LineageConfidence,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LineageConfidence {
    Declared,
    Convention,
    Inferred,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventTriggerPlan {
    pub schema: String,
    pub channel: String,
    pub enabled: bool,
}

impl EventTriggerPlan {
    /// Produces an administrator-reviewed `PostgreSQL` enhancement script.
    /// `Nodal Studio` never executes this script automatically.
    pub fn review_sql(&self) -> String {
        let channel = identifier_fragment(&self.channel);
        format!(
            "-- REVIEW AND RUN MANUALLY AS AN ADMINISTRATOR\nCREATE OR REPLACE FUNCTION nodalstudio_notify_ddl() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_notify('{channel}', tg_tag); END $$;\nCREATE EVENT TRIGGER nodalstudio_ddl_change ON ddl_command_end EXECUTE FUNCTION nodalstudio_notify_ddl();"
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnterprisePolicy {
    pub deployment: DeploymentMode,
    pub outbound_network_allowed: bool,
    pub ai_allowed: bool,
    pub audit_retention_days: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DeploymentMode {
    ManagedCloud,
    SelfHosted,
    AirGapped,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum PolicyError {
    #[error("air-gapped deployments cannot allow outbound network access")]
    AirGapNetwork,
    #[error("audit retention must be at least one day")]
    AuditRetention,
}

impl EnterprisePolicy {
    /// Validates deployment invariants.
    ///
    /// # Errors
    ///
    /// Returns an error for network-enabled air gaps or zero audit retention.
    pub fn validate(&self) -> Result<(), PolicyError> {
        if self.deployment == DeploymentMode::AirGapped && self.outbound_network_allowed {
            return Err(PolicyError::AirGapNetwork);
        }
        if self.audit_retention_days == 0 {
            return Err(PolicyError::AuditRetention);
        }
        Ok(())
    }
}

fn identifier_fragment(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || *character == '_')
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use schema_model::{DatabaseInfo, DatabaseType};

    fn snapshot(source_id: Uuid) -> DatabaseSnapshot {
        let mut snapshot = DatabaseSnapshot::new(
            source_id,
            DatabaseInfo {
                name: "app".into(),
                database_type: DatabaseType::PostgreSql,
                version: "17".into(),
            },
            vec![],
        );
        snapshot.canonicalize().unwrap();
        snapshot
    }

    #[test]
    fn detects_environment_equality_by_structure() {
        let source = Uuid::new_v4();
        let from = EnvironmentSnapshot {
            environment: "staging".into(),
            snapshot: snapshot(source),
        };
        let mut other = snapshot(Uuid::new_v4());
        other.captured_at = Utc::now();
        let to = EnvironmentSnapshot {
            environment: "production".into(),
            snapshot: other,
        };
        assert!(compare_environments(&from, &to).in_sync);
    }

    #[test]
    fn normalizes_git_and_migration_provenance() {
        let mut provenance = ChangeProvenance {
            change_set_id: Uuid::new_v4(),
            branch: Some("main".into()),
            commit_sha: Some(" ABCDEF ".into()),
            pull_request_url: None,
            migration_files: vec!["002.sql".into(), "001.sql".into(), "001.sql".into()],
            recorded_at: Utc::now(),
        };
        provenance.canonicalize();
        assert_eq!(provenance.commit_sha.as_deref(), Some("abcdef"));
        assert_eq!(provenance.migration_files, ["001.sql", "002.sql"]);
    }

    #[test]
    fn trigger_script_is_manual_and_sanitizes_channel() {
        let sql = EventTriggerPlan {
            schema: "public".into(),
            channel: "schema';drop".into(),
            enabled: true,
        }
        .review_sql();
        assert!(sql.contains("REVIEW AND RUN MANUALLY"));
        assert!(!sql.contains("';drop"));
    }

    #[test]
    fn rejects_network_access_in_air_gap() {
        let policy = EnterprisePolicy {
            deployment: DeploymentMode::AirGapped,
            outbound_network_allowed: true,
            ai_allowed: false,
            audit_retention_days: 365,
        };
        assert_eq!(policy.validate(), Err(PolicyError::AirGapNetwork));
    }
}
