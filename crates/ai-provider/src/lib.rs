//! Provider-neutral AI connections, capability checks, privacy-safe routing, and adapters.

use std::future::Future;

use chrono::{DateTime, Utc};
use project_model::{
    AiCandidateStatus, AiRelationCandidate, EdgeCertainty, ModelCapabilities, ModelConnection,
    ModelRole, ProjectEdge, ProjectEdgeKind, ProjectNode, ProviderKind, ReviewStatus,
};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionRequest {
    pub system: String,
    pub input: String,
    pub structured_output: bool,
    pub contains_source_excerpts: bool,
    pub contains_uncommitted_code: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionResponse {
    pub content: String,
    pub provider: ProviderKind,
    pub model: String,
    pub network_used: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingRequest {
    pub inputs: Vec<String>,
    pub contains_source_excerpts: bool,
    pub contains_uncommitted_code: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingResponse {
    pub vectors: Vec<Vec<f32>>,
    pub provider: ProviderKind,
    pub model: String,
    pub network_used: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTest {
    pub connection_id: Uuid,
    pub tested_at: DateTime<Utc>,
    pub network_used: bool,
}

#[derive(Debug, Error)]
pub enum AiProviderError {
    #[error("connection is disabled")]
    Disabled,
    #[error("connection does not support {0}")]
    UnsupportedCapability(&'static str),
    #[error("connection privacy policy does not allow this request")]
    PrivacyDenied,
    #[error("remote provider endpoint is missing or invalid")]
    InvalidEndpoint,
    #[error("provider request failed")]
    Request(#[source] reqwest::Error),
    #[error("provider returned no completion")]
    EmptyResponse,
    #[error("no eligible connection is configured for {0:?}")]
    NoEligibleRoute(ModelRole),
    #[error("model output is not valid candidate JSON")]
    InvalidStructuredOutput(#[source] serde_json::Error),
    #[error("model candidate failed local graph validation")]
    InvalidCandidate,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CandidateEnvelope {
    edges: Vec<ProposedRelation>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProposedRelation {
    source_id: String,
    target_id: String,
    kind: ProjectEdgeKind,
    evidence_ids: Vec<String>,
    explanation: String,
}

pub trait AiProvider: Send + Sync {
    fn capabilities(&self) -> ModelCapabilities;
    fn test_connection(
        &self,
        connection: &ModelConnection,
        credential: Option<&str>,
    ) -> impl Future<Output = Result<ConnectionTest, AiProviderError>> + Send;
    fn complete(
        &self,
        connection: &ModelConnection,
        credential: Option<&str>,
        request: CompletionRequest,
    ) -> impl Future<Output = Result<CompletionResponse, AiProviderError>> + Send;
    fn embed(
        &self,
        connection: &ModelConnection,
        credential: Option<&str>,
        request: EmbeddingRequest,
    ) -> impl Future<Output = Result<EmbeddingResponse, AiProviderError>> + Send;
}

pub struct OfflineProvider;

impl AiProvider for OfflineProvider {
    fn capabilities(&self) -> ModelCapabilities {
        offline_capabilities()
    }

    async fn test_connection(
        &self,
        connection: &ModelConnection,
        _credential: Option<&str>,
    ) -> Result<ConnectionTest, AiProviderError> {
        ensure_enabled(connection)?;
        Ok(ConnectionTest {
            connection_id: connection.id,
            tested_at: Utc::now(),
            network_used: false,
        })
    }

    async fn complete(
        &self,
        connection: &ModelConnection,
        _credential: Option<&str>,
        request: CompletionRequest,
    ) -> Result<CompletionResponse, AiProviderError> {
        validate_request(connection, &request)?;
        Ok(CompletionResponse {
            content: request.input,
            provider: ProviderKind::Offline,
            model: connection.model.clone(),
            network_used: false,
        })
    }

    async fn embed(
        &self,
        _connection: &ModelConnection,
        _credential: Option<&str>,
        _request: EmbeddingRequest,
    ) -> Result<EmbeddingResponse, AiProviderError> {
        Err(AiProviderError::UnsupportedCapability("embeddings"))
    }
}

pub struct OpenAiCompatibleProvider {
    client: reqwest::Client,
}

impl Default for OpenAiCompatibleProvider {
    fn default() -> Self {
        Self {
            client: reqwest::Client::new(),
        }
    }
}

impl AiProvider for OpenAiCompatibleProvider {
    fn capabilities(&self) -> ModelCapabilities {
        remote_capabilities()
    }

    async fn test_connection(
        &self,
        connection: &ModelConnection,
        credential: Option<&str>,
    ) -> Result<ConnectionTest, AiProviderError> {
        let request = CompletionRequest {
            system: "Connection test. Reply OK.".into(),
            input: "OK".into(),
            structured_output: false,
            contains_source_excerpts: false,
            contains_uncommitted_code: false,
        };
        self.complete(connection, credential, request).await?;
        Ok(ConnectionTest {
            connection_id: connection.id,
            tested_at: Utc::now(),
            network_used: true,
        })
    }

    async fn complete(
        &self,
        connection: &ModelConnection,
        credential: Option<&str>,
        request: CompletionRequest,
    ) -> Result<CompletionResponse, AiProviderError> {
        validate_request(connection, &request)?;
        let endpoint = validated_endpoint(connection)?;
        let mut builder = self.client.post(endpoint.join("v1/chat/completions").map_err(|_| AiProviderError::InvalidEndpoint)?).json(&serde_json::json!({ "model": connection.model, "messages": [{"role":"system","content":request.system},{"role":"user","content":request.input}] }));
        if let Some(secret) = credential {
            builder = builder.bearer_auth(secret);
        }
        let payload: serde_json::Value = builder
            .send()
            .await
            .map_err(AiProviderError::Request)?
            .error_for_status()
            .map_err(AiProviderError::Request)?
            .json()
            .await
            .map_err(AiProviderError::Request)?;
        let content = payload
            .pointer("/choices/0/message/content")
            .and_then(serde_json::Value::as_str)
            .ok_or(AiProviderError::EmptyResponse)?;
        Ok(CompletionResponse {
            content: content.into(),
            provider: ProviderKind::OpenAiCompatible,
            model: connection.model.clone(),
            network_used: true,
        })
    }

    async fn embed(
        &self,
        connection: &ModelConnection,
        credential: Option<&str>,
        request: EmbeddingRequest,
    ) -> Result<EmbeddingResponse, AiProviderError> {
        ensure_enabled(connection)?;
        if !connection.capabilities.embeddings {
            return Err(AiProviderError::UnsupportedCapability("embeddings"));
        }
        if request.contains_source_excerpts && !connection.privacy.allow_source_excerpts
            || request.contains_uncommitted_code && !connection.privacy.allow_uncommitted_code
        {
            return Err(AiProviderError::PrivacyDenied);
        }
        let endpoint = validated_endpoint(connection)?;
        let mut builder = self
            .client
            .post(
                endpoint
                    .join("v1/embeddings")
                    .map_err(|_| AiProviderError::InvalidEndpoint)?,
            )
            .json(&serde_json::json!({"model":connection.model,"input":request.inputs}));
        if let Some(secret) = credential {
            builder = builder.bearer_auth(secret);
        }
        let payload: serde_json::Value = builder
            .send()
            .await
            .map_err(AiProviderError::Request)?
            .error_for_status()
            .map_err(AiProviderError::Request)?
            .json()
            .await
            .map_err(AiProviderError::Request)?;
        let vectors = payload
            .get("data")
            .and_then(serde_json::Value::as_array)
            .ok_or(AiProviderError::EmptyResponse)?
            .iter()
            .map(|item| {
                item.get("embedding")
                    .cloned()
                    .ok_or(AiProviderError::EmptyResponse)
                    .and_then(|value| {
                        serde_json::from_value(value)
                            .map_err(AiProviderError::InvalidStructuredOutput)
                    })
            })
            .collect::<Result<Vec<Vec<f32>>, _>>()?;
        Ok(EmbeddingResponse {
            vectors,
            provider: ProviderKind::OpenAiCompatible,
            model: connection.model.clone(),
            network_used: true,
        })
    }
}

/// Chooses the first enabled route that satisfies role, offline, capability, and privacy rules.
///
/// # Errors
///
/// Returns [`AiProviderError::NoEligibleRoute`] when no candidate can safely run the request.
pub fn select_connection<'a>(
    role: ModelRole,
    candidates: impl IntoIterator<Item = &'a ModelConnection>,
    offline_mode: bool,
    request: &CompletionRequest,
) -> Result<&'a ModelConnection, AiProviderError> {
    candidates
        .into_iter()
        .find(|connection| {
            connection.enabled
                && supports_role(&connection.capabilities, role)
                && (!offline_mode || connection.capabilities.local)
                && validate_request(connection, request).is_ok()
        })
        .ok_or(AiProviderError::NoEligibleRoute(role))
}

/// Parses and validates structured candidate output against an existing graph.
///
/// # Errors
///
/// Rejects malformed JSON, unknown nodes, missing evidence, and invalid candidate state.
pub fn validate_relation_candidates(
    content: &str,
    scan_id: Uuid,
    connection: &ModelConnection,
    nodes: &[ProjectNode],
    edges: &[ProjectEdge],
) -> Result<Vec<AiRelationCandidate>, AiProviderError> {
    let envelope: CandidateEnvelope =
        serde_json::from_str(content).map_err(AiProviderError::InvalidStructuredOutput)?;
    let evidence = edges
        .iter()
        .flat_map(|edge| edge.evidence.iter())
        .map(|item| (item.id.clone(), item.clone()))
        .collect::<std::collections::BTreeMap<_, _>>();
    let evidence_ids = evidence.keys().cloned().collect();
    envelope
        .edges
        .into_iter()
        .map(|relation| {
            let proposed_edge = ProjectEdge {
                id: ProjectEdge::stable_id(&relation.source_id, &relation.target_id, relation.kind),
                source_id: relation.source_id,
                target_id: relation.target_id,
                kind: relation.kind,
                certainty: EdgeCertainty::AiInferred,
                review_status: ReviewStatus::Pending,
                evidence: relation
                    .evidence_ids
                    .iter()
                    .filter_map(|id| evidence.get(id).cloned())
                    .collect(),
                scan_id,
            };
            let candidate = AiRelationCandidate {
                id: Uuid::new_v4(),
                scan_id,
                connection_id: connection.id,
                model: connection.model.clone(),
                proposed_edge,
                explanation: relation.explanation,
                status: AiCandidateStatus::Pending,
                created_at: Utc::now(),
                reviewed_at: None,
            };
            if edges
                .iter()
                .any(|edge| edge.id == candidate.proposed_edge.id)
            {
                return Err(AiProviderError::InvalidCandidate);
            }
            candidate
                .validate_against(nodes, &evidence_ids)
                .map_err(|_| AiProviderError::InvalidCandidate)?;
            Ok(candidate)
        })
        .collect()
}

fn supports_role(capabilities: &ModelCapabilities, role: ModelRole) -> bool {
    match role {
        ModelRole::Analysis => {
            capabilities.chat && capabilities.code_analysis && capabilities.structured_output
        }
        ModelRole::Explanation => capabilities.chat,
        ModelRole::Embedding => capabilities.embeddings,
    }
}
fn validated_endpoint(connection: &ModelConnection) -> Result<reqwest::Url, AiProviderError> {
    let mut endpoint = reqwest::Url::parse(
        connection
            .endpoint
            .as_deref()
            .ok_or(AiProviderError::InvalidEndpoint)?,
    )
    .map_err(|_| AiProviderError::InvalidEndpoint)?;
    let loopback = endpoint
        .host_str()
        .is_some_and(|host| matches!(host, "localhost" | "127.0.0.1" | "::1"));
    if endpoint.scheme() != "https"
        && !(endpoint.scheme() == "http" && loopback && connection.capabilities.local)
    {
        return Err(AiProviderError::InvalidEndpoint);
    }
    if !endpoint.path().ends_with('/') {
        endpoint.set_path(&format!("{}/", endpoint.path()));
    }
    Ok(endpoint)
}
fn ensure_enabled(connection: &ModelConnection) -> Result<(), AiProviderError> {
    if connection.enabled {
        Ok(())
    } else {
        Err(AiProviderError::Disabled)
    }
}
fn validate_request(
    connection: &ModelConnection,
    request: &CompletionRequest,
) -> Result<(), AiProviderError> {
    ensure_enabled(connection)?;
    if request.structured_output && !connection.capabilities.structured_output {
        return Err(AiProviderError::UnsupportedCapability("structured output"));
    }
    if request.contains_source_excerpts && !connection.privacy.allow_source_excerpts
        || request.contains_uncommitted_code && !connection.privacy.allow_uncommitted_code
    {
        return Err(AiProviderError::PrivacyDenied);
    }
    Ok(())
}
fn offline_capabilities() -> ModelCapabilities {
    ModelCapabilities {
        chat: true,
        structured_output: true,
        tool_calling: false,
        embeddings: false,
        code_analysis: false,
        local: true,
        max_context_tokens: None,
    }
}
fn remote_capabilities() -> ModelCapabilities {
    ModelCapabilities {
        chat: true,
        structured_output: true,
        tool_calling: true,
        embeddings: true,
        code_analysis: true,
        local: false,
        max_context_tokens: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use project_model::{ConnectionPrivacy, EdgeEvidence, ProjectNodeKind};
    use std::collections::BTreeMap;
    fn connection(local: bool, allow_dirty: bool) -> ModelConnection {
        ModelConnection {
            id: Uuid::new_v4(),
            name: "test".into(),
            provider: ProviderKind::Offline,
            endpoint: None,
            model: "offline".into(),
            credential_ref: None,
            capabilities: ModelCapabilities {
                chat: true,
                structured_output: true,
                tool_calling: false,
                embeddings: false,
                code_analysis: true,
                local,
                max_context_tokens: None,
            },
            privacy: ConnectionPrivacy {
                allow_uncommitted_code: allow_dirty,
                allow_source_excerpts: true,
                remote: !local,
            },
            enabled: true,
        }
    }
    fn request(dirty: bool) -> CompletionRequest {
        CompletionRequest {
            system: String::new(),
            input: String::new(),
            structured_output: true,
            contains_source_excerpts: true,
            contains_uncommitted_code: dirty,
        }
    }
    #[test]
    fn offline_mode_never_selects_remote() {
        let remote = connection(false, true);
        let local = connection(true, true);
        assert_eq!(
            select_connection(
                ModelRole::Analysis,
                [&remote, &local],
                true,
                &request(false)
            )
            .unwrap()
            .id,
            local.id
        );
    }
    #[test]
    fn fallback_cannot_expand_dirty_code_permission() {
        let denied = connection(true, false);
        assert!(select_connection(ModelRole::Analysis, [&denied], false, &request(true)).is_err());
    }

    #[test]
    fn structured_candidates_cannot_invent_nodes_or_evidence() {
        let connection = connection(false, false);
        let scan_id = Uuid::new_v4();
        let project_id = Uuid::new_v4();
        let node = |id: &str| ProjectNode {
            id: id.into(),
            project_id,
            kind: ProjectNodeKind::Service,
            name: id.into(),
            qualified_name: id.into(),
            relative_path: None,
            line: None,
            database_object: None,
            attributes: BTreeMap::default(),
        };
        let evidence = EdgeEvidence {
            id: "ev".into(),
            project_id,
            relative_path: "src/a.ts".into(),
            start_line: Some(1),
            end_line: Some(1),
            symbol: None,
            analyzer: "test".into(),
            excerpt_hash: None,
            explanation: None,
        };
        let base = ProjectEdge {
            id: ProjectEdge::stable_id("a", "b", ProjectEdgeKind::Calls),
            source_id: "a".into(),
            target_id: "b".into(),
            kind: ProjectEdgeKind::Calls,
            certainty: EdgeCertainty::Static,
            review_status: ReviewStatus::NotRequired,
            evidence: vec![evidence],
            scan_id,
        };
        let valid = r#"{"edges":[{"sourceId":"a","targetId":"b","kind":"reads","evidenceIds":["ev"],"explanation":"existing evidence"}]}"#;
        assert_eq!(
            validate_relation_candidates(
                valid,
                scan_id,
                &connection,
                &[node("a"), node("b")],
                std::slice::from_ref(&base)
            )
            .unwrap()
            .len(),
            1
        );
        let invented = valid.replace("\"b\"", "\"missing\"");
        assert!(matches!(
            validate_relation_candidates(
                &invented,
                scan_id,
                &connection,
                &[node("a"), node("b")],
                std::slice::from_ref(&base)
            ),
            Err(AiProviderError::InvalidCandidate)
        ));
        let duplicate = valid.replace("\"reads\"", "\"calls\"");
        assert!(matches!(
            validate_relation_candidates(
                &duplicate,
                scan_id,
                &connection,
                &[node("a"), node("b")],
                &[base]
            ),
            Err(AiProviderError::InvalidCandidate)
        ));
    }

    #[tokio::test]
    async fn offline_provider_reports_embeddings_as_unsupported() {
        let provider = OfflineProvider;
        let connection = connection(true, false);
        let result = provider
            .embed(
                &connection,
                None,
                EmbeddingRequest {
                    inputs: vec!["x".into()],
                    contains_source_excerpts: false,
                    contains_uncommitted_code: false,
                },
            )
            .await;
        assert!(matches!(
            result,
            Err(AiProviderError::UnsupportedCapability("embeddings"))
        ));
    }

    #[test]
    fn remote_http_cannot_be_relabelled_as_local() {
        let mut connection = connection(true, false);
        connection.endpoint = Some("http://example.com".into());
        assert!(matches!(
            validated_endpoint(&connection),
            Err(AiProviderError::InvalidEndpoint)
        ));
    }
}
