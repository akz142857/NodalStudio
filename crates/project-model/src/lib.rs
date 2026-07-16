//! Stable local-project, scan, system-graph, and model-routing domain types.

use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use schema_model::ObjectKey;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalProject {
    pub id: Uuid,
    pub name: String,
    pub root_path: String,
    pub repository_kind: RepositoryKind,
    #[serde(default)]
    pub remote_url: Option<String>,
    #[serde(default)]
    pub managed_cache: bool,
    pub database_source_ids: Vec<Uuid>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RepositoryKind {
    Directory,
    Git,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitMetadata {
    pub root_path: String,
    pub branch: Option<String>,
    pub commit_sha: Option<String>,
    pub dirty: bool,
    pub dirty_known: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectScan {
    pub id: Uuid,
    pub project_id: Uuid,
    pub branch: Option<String>,
    pub commit_sha: Option<String>,
    pub dirty: bool,
    pub status: ScanStatus,
    pub analyzer_versions: BTreeMap<String, String>,
    pub started_at: DateTime<Utc>,
    pub completed_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ScanStatus {
    Queued,
    Discovering,
    Parsing,
    Matching,
    AiAnalysis,
    ReviewRequired,
    Ready,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFile {
    pub relative_path: String,
    pub byte_size: u64,
    pub modified_unix_ms: Option<u64>,
    pub content_hash: String,
    pub language: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FileChangeKind {
    Added,
    Modified,
    Unchanged,
    Deleted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub relative_path: String,
    pub kind: FileChangeKind,
    pub file: Option<ProjectFile>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProjectNodeKind {
    Project,
    Module,
    File,
    Symbol,
    Page,
    Endpoint,
    Service,
    Repository,
    OrmModel,
    Query,
    Migration,
    Table,
    Column,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectNode {
    pub id: String,
    pub project_id: Uuid,
    pub kind: ProjectNodeKind,
    pub name: String,
    pub qualified_name: String,
    pub relative_path: Option<String>,
    pub line: Option<u32>,
    pub database_object: Option<ObjectKey>,
    pub attributes: BTreeMap<String, String>,
}

impl ProjectNode {
    pub fn stable_id(project_id: Uuid, kind: ProjectNodeKind, identity: &str) -> String {
        stable_identifier(&[
            &project_id.to_string(),
            &format!("{kind:?}"),
            identity.trim(),
        ])
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProjectEdgeKind {
    Contains,
    Imports,
    Calls,
    Handles,
    Reads,
    Writes,
    Joins,
    MapsTo,
    Returns,
    Changes,
    Triggers,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EdgeCertainty {
    Declared,
    Static,
    Convention,
    AiInferred,
    HumanConfirmed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReviewStatus {
    NotRequired,
    Pending,
    Confirmed,
    Rejected,
    Stale,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeEvidence {
    pub id: String,
    pub project_id: Uuid,
    pub relative_path: String,
    pub start_line: Option<u32>,
    pub end_line: Option<u32>,
    pub symbol: Option<String>,
    pub analyzer: String,
    pub excerpt_hash: Option<String>,
    pub explanation: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectEdge {
    pub id: String,
    pub source_id: String,
    pub target_id: String,
    pub kind: ProjectEdgeKind,
    pub certainty: EdgeCertainty,
    pub review_status: ReviewStatus,
    pub evidence: Vec<EdgeEvidence>,
    pub scan_id: Uuid,
}

/// Metadata-only project graph published for a team or read-only share.
/// Local roots, remote URLs, source paths, line numbers, and excerpts are removed before creation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedProjectGraph {
    pub project_id: Uuid,
    pub project_name: String,
    pub scan: ProjectScan,
    pub nodes: Vec<ProjectNode>,
    pub edges: Vec<ProjectEdge>,
}

impl ProjectEdge {
    pub fn stable_id(source_id: &str, target_id: &str, kind: ProjectEdgeKind) -> String {
        stable_identifier(&[source_id, target_id, &format!("{kind:?}")])
    }

    /// Validates invariants that keep inferred graph data visibly reviewable.
    ///
    /// # Errors
    ///
    /// Returns an error for self edges, unreviewed AI claims presented as
    /// confirmed, or non-declared relationships without evidence.
    pub fn validate(&self) -> Result<(), ProjectModelError> {
        if self.source_id == self.target_id {
            return Err(ProjectModelError::SelfEdge);
        }
        if self.certainty == EdgeCertainty::AiInferred
            && self.review_status != ReviewStatus::Pending
        {
            return Err(ProjectModelError::AiReviewRequired);
        }
        if self.evidence.is_empty()
            && !matches!(
                self.certainty,
                EdgeCertainty::HumanConfirmed | EdgeCertainty::Declared
            )
        {
            return Err(ProjectModelError::EvidenceRequired);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProviderKind {
    Offline,
    OpenAiCompatible,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(clippy::struct_excessive_bools)]
pub struct ModelCapabilities {
    pub chat: bool,
    pub structured_output: bool,
    pub tool_calling: bool,
    pub embeddings: bool,
    pub code_analysis: bool,
    pub local: bool,
    pub max_context_tokens: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionPrivacy {
    pub allow_uncommitted_code: bool,
    pub allow_source_excerpts: bool,
    pub remote: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelConnection {
    pub id: Uuid,
    pub name: String,
    pub provider: ProviderKind,
    pub endpoint: Option<String>,
    pub model: String,
    pub credential_ref: Option<String>,
    pub capabilities: ModelCapabilities,
    pub privacy: ConnectionPrivacy,
    pub enabled: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ModelRole {
    Analysis,
    Explanation,
    Embedding,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRoute {
    pub role: ModelRole,
    pub primary_connection_id: Uuid,
    pub fallback_connection_ids: Vec<Uuid>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AiCandidateStatus {
    Pending,
    Confirmed,
    Rejected,
    Stale,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiRelationCandidate {
    pub id: Uuid,
    pub scan_id: Uuid,
    pub connection_id: Uuid,
    pub model: String,
    pub proposed_edge: ProjectEdge,
    pub explanation: String,
    pub status: AiCandidateStatus,
    pub created_at: DateTime<Utc>,
    pub reviewed_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiUsageEvent {
    pub id: Uuid,
    pub role: ModelRole,
    pub connection_id: Uuid,
    pub provider: ProviderKind,
    pub model: String,
    pub started_at: DateTime<Utc>,
    pub completed_at: DateTime<Utc>,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub fallback_from: Option<Uuid>,
    pub status: String,
    pub file_count: u32,
    pub snippet_count: u32,
    pub privacy_policy_version: u16,
}

impl AiRelationCandidate {
    /// Confirms that a candidate only refers to nodes and evidence already present in the graph.
    ///
    /// # Errors
    ///
    /// Returns an error when the candidate invents a node, has no evidence, or is already confirmed.
    pub fn validate_against(
        &self,
        nodes: &[ProjectNode],
        evidence_ids: &std::collections::BTreeSet<String>,
    ) -> Result<(), ProjectModelError> {
        if !nodes
            .iter()
            .any(|node| node.id == self.proposed_edge.source_id)
            || !nodes
                .iter()
                .any(|node| node.id == self.proposed_edge.target_id)
        {
            return Err(ProjectModelError::UnknownCandidateNode);
        }
        if self.proposed_edge.evidence.is_empty()
            || self
                .proposed_edge
                .evidence
                .iter()
                .any(|evidence| !evidence_ids.contains(&evidence.id))
        {
            return Err(ProjectModelError::UnknownCandidateEvidence);
        }
        if self.proposed_edge.certainty != EdgeCertainty::AiInferred
            || self.proposed_edge.review_status != ReviewStatus::Pending
        {
            return Err(ProjectModelError::AiReviewRequired);
        }
        Ok(())
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ProjectModelError {
    #[error("project graph edges cannot point to themselves")]
    SelfEdge,
    #[error("AI-inferred edges must remain pending until human review")]
    AiReviewRequired,
    #[error("non-declared graph edges require evidence")]
    EvidenceRequired,
    #[error("AI candidate refers to an unknown graph node")]
    UnknownCandidateNode,
    #[error("AI candidate requires existing static evidence")]
    UnknownCandidateEvidence,
}

fn stable_identifier(parts: &[&str]) -> String {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part.as_bytes());
        hasher.update([0]);
    }
    hex::encode(hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_node_ids_are_deterministic_and_kind_scoped() {
        let project_id = Uuid::new_v4();
        let first = ProjectNode::stable_id(project_id, ProjectNodeKind::Service, "orders.create");
        let second = ProjectNode::stable_id(project_id, ProjectNodeKind::Service, "orders.create");
        let other = ProjectNode::stable_id(project_id, ProjectNodeKind::Query, "orders.create");
        assert_eq!(first, second);
        assert_ne!(first, other);
    }

    #[test]
    fn ai_edges_cannot_skip_review() {
        let edge = ProjectEdge {
            id: "edge".into(),
            source_id: "source".into(),
            target_id: "target".into(),
            kind: ProjectEdgeKind::Calls,
            certainty: EdgeCertainty::AiInferred,
            review_status: ReviewStatus::Confirmed,
            evidence: vec![],
            scan_id: Uuid::new_v4(),
        };
        assert_eq!(edge.validate(), Err(ProjectModelError::AiReviewRequired));
    }
}
