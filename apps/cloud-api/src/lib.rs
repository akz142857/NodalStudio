//! Axum API for metadata-only schema synchronization and read-only sharing.

use std::{
    collections::{BTreeSet, VecDeque},
    sync::Arc,
    time::{Duration, Instant},
};

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, State},
    http::{HeaderMap, Request, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chrono::{DateTime, Utc};
use project_model::SharedProjectGraph;
use schema_diff::SchemaChangeSet;
use schema_model::{DatabaseSnapshot, LogicalRelationship};
use semantic_model::{CanvasLayout, DomainGroup, ObjectAnnotation, SavedView};
use serde::{Deserialize, Serialize};
use settings_model::{OrganizationPolicy, ProjectSettings};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};
use tokio::sync::Mutex;
use tower::limit::ConcurrencyLimitLayer;
use tower_http::timeout::TimeoutLayer;
use uuid::Uuid;

#[derive(Clone)]
pub struct CloudState {
    pool: PgPool,
    bootstrap_secret: Arc<Mutex<Option<String>>>,
    bootstrap_attempts: Arc<Mutex<VecDeque<Instant>>>,
    request_attempts: Arc<Mutex<VecDeque<Instant>>>,
}

impl CloudState {
    pub fn new(pool: PgPool) -> Self {
        Self {
            pool,
            bootstrap_secret: Arc::new(Mutex::new(None)),
            bootstrap_attempts: Arc::new(Mutex::new(VecDeque::new())),
            request_attempts: Arc::new(Mutex::new(VecDeque::new())),
        }
    }

    #[must_use]
    pub fn with_bootstrap_secret(mut self, secret: Option<String>) -> Self {
        self.bootstrap_secret = Arc::new(Mutex::new(secret.filter(|value| value.len() >= 24)));
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncBundle {
    pub project_id: Uuid,
    pub source_id: Uuid,
    pub source_label: String,
    pub fingerprint: String,
    pub snapshot: Option<DatabaseSnapshot>,
    pub change_set: Option<SchemaChangeSet>,
    pub annotations: Vec<ObjectAnnotation>,
    pub domain_groups: Vec<DomainGroup>,
    pub saved_views: Vec<SavedView>,
    #[serde(default)]
    pub logical_relationships: Vec<LogicalRelationship>,
    pub layout: Option<CanvasLayout>,
    pub project_settings: Option<ProjectSettings>,
    #[serde(default)]
    pub project_graphs: Vec<SharedProjectGraph>,
    pub base_version: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BundleReceipt {
    project_id: Uuid,
    fingerprint: String,
    version: i64,
    deduplicated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BundleEnvelope {
    version: i64,
    bundle: SyncBundle,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateProjectInput {
    team_id: Uuid,
    name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BootstrapInput {
    email: String,
    display_name: String,
    team_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RefreshInput {
    refresh_token: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthSession {
    user_id: Uuid,
    team_id: Uuid,
    access_token: String,
    access_expires_at: DateTime<Utc>,
    refresh_token: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectRecord {
    id: Uuid,
    team_id: Uuid,
    name: String,
    created_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateShareInput {
    expires_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ShareRecord {
    id: Uuid,
    token: String,
    permission: &'static str,
    expires_at: DateTime<Utc>,
    created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ShareSummary {
    id: Uuid,
    permission: String,
    expires_at: DateTime<Utc>,
    created_at: DateTime<Utc>,
    revoked_at: Option<DateTime<Utc>>,
    last_access_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuditEntry {
    action: String,
    created_at: DateTime<Utc>,
}

pub fn router(state: CloudState) -> Router {
    let middleware_state = state.clone();
    Router::new()
        .route("/health", get(health))
        .route("/v1/auth/bootstrap", post(bootstrap_account))
        .route("/v1/auth/refresh", post(refresh_access))
        .route("/v1/projects", post(create_project))
        .route(
            "/v1/teams/{team_id}/policy",
            get(get_team_policy).put(put_team_policy),
        )
        .route(
            "/v1/projects/{project_id}/bundle",
            get(get_bundle).put(sync_bundle),
        )
        .route(
            "/v1/projects/{project_id}/shares",
            get(list_shares).post(create_share),
        )
        .route(
            "/v1/projects/{project_id}/shares/{share_id}",
            axum::routing::delete(revoke_share),
        )
        .route(
            "/v1/projects/{project_id}/shares/{share_id}/rotate",
            post(rotate_share),
        )
        .route("/v1/projects/{project_id}/audit", get(list_project_audit))
        .route("/v1/view/{share_token}", get(view_shared_bundle))
        .layer(DefaultBodyLimit::max(16 * 1024 * 1024))
        .layer(TimeoutLayer::with_status_code(
            StatusCode::REQUEST_TIMEOUT,
            std::time::Duration::from_secs(30),
        ))
        .layer(ConcurrencyLimitLayer::new(128))
        .layer(axum::middleware::from_fn_with_state(
            middleware_state,
            enforce_request_rate,
        ))
        .with_state(state)
}

async fn enforce_request_rate(
    State(state): State<CloudState>,
    request: Request<axum::body::Body>,
    next: Next,
) -> Result<Response, StatusCode> {
    let now = Instant::now();
    let mut attempts = state.request_attempts.lock().await;
    while attempts
        .front()
        .is_some_and(|attempt| now.duration_since(*attempt) >= Duration::from_mins(1))
    {
        attempts.pop_front();
    }
    if attempts.len() >= 600 {
        return Err(StatusCode::TOO_MANY_REQUESTS);
    }
    attempts.push_back(now);
    drop(attempts);
    Ok(next.run(request).await)
}

async fn health() -> &'static str {
    "ok"
}

async fn bootstrap_account(
    State(state): State<CloudState>,
    headers: HeaderMap,
    Json(input): Json<BootstrapInput>,
) -> Result<(StatusCode, Json<AuthSession>), ApiError> {
    if !input.email.contains('@')
        || input.display_name.trim().is_empty()
        || input.team_name.trim().is_empty()
    {
        return Err(ApiError::bad_request(
            "Valid account and team details are required.",
        ));
    }
    authorize_bootstrap(&state, &headers).await?;
    let user_id = Uuid::new_v4();
    let team_id = Uuid::new_v4();
    let session = new_auth_session(user_id, team_id);
    let mut transaction = state.pool.begin().await?;
    sqlx::query("INSERT INTO users (id, email, display_name) VALUES ($1, lower($2), $3)")
        .bind(user_id)
        .bind(input.email.trim())
        .bind(input.display_name.trim())
        .execute(&mut *transaction)
        .await?;
    sqlx::query("INSERT INTO teams (id, name) VALUES ($1, $2)")
        .bind(team_id)
        .bind(input.team_name.trim())
        .execute(&mut *transaction)
        .await?;
    sqlx::query("INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'owner')")
        .bind(team_id)
        .bind(user_id)
        .execute(&mut *transaction)
        .await?;
    persist_session(&mut transaction, &session).await?;
    sqlx::query(
        "INSERT INTO account_audit_log (id, user_id, action) VALUES ($1, $2, 'account.login')",
    )
    .bind(Uuid::new_v4())
    .bind(user_id)
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok((StatusCode::CREATED, Json(session)))
}

async fn refresh_access(
    State(state): State<CloudState>,
    Json(input): Json<RefreshInput>,
) -> Result<Json<AuthSession>, ApiError> {
    let row = sqlx::query(
        "SELECT r.user_id, r.team_id FROM refresh_tokens r \
         JOIN team_members tm ON tm.user_id = r.user_id AND tm.team_id = r.team_id \
         WHERE r.token_hash = $1 AND r.expires_at > now() AND r.revoked_at IS NULL",
    )
    .bind(hash_token(&input.refresh_token))
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| ApiError::unauthorized("Refresh token is invalid or expired."))?;
    let session = new_auth_session(row.get("user_id"), row.get("team_id"));
    let mut transaction = state.pool.begin().await?;
    sqlx::query("UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1")
        .bind(hash_token(&input.refresh_token))
        .execute(&mut *transaction)
        .await?;
    persist_session(&mut transaction, &session).await?;
    sqlx::query(
        "INSERT INTO account_audit_log (id, user_id, action) VALUES ($1, $2, 'account.refresh')",
    )
    .bind(Uuid::new_v4())
    .bind(session.user_id)
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok(Json(session))
}

fn new_auth_session(user_id: Uuid, team_id: Uuid) -> AuthSession {
    AuthSession {
        user_id,
        team_id,
        access_token: format!("access_{}", Uuid::new_v4().simple()),
        access_expires_at: Utc::now() + chrono::Duration::minutes(15),
        refresh_token: format!("refresh_{}", Uuid::new_v4().simple()),
    }
}

async fn persist_session(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    session: &AuthSession,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO access_tokens (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)",
    )
    .bind(Uuid::new_v4())
    .bind(session.user_id)
    .bind(hash_token(&session.access_token))
    .bind(session.access_expires_at)
    .execute(&mut **transaction)
    .await?;
    sqlx::query(
        "INSERT INTO refresh_tokens (id, user_id, team_id, token_hash, expires_at) VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(Uuid::new_v4())
    .bind(session.user_id)
    .bind(session.team_id)
    .bind(hash_token(&session.refresh_token))
    .bind(Utc::now() + chrono::Duration::days(30))
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

async fn create_project(
    State(state): State<CloudState>,
    headers: HeaderMap,
    Json(input): Json<CreateProjectInput>,
) -> Result<Json<ProjectRecord>, ApiError> {
    let user_id = authenticate(&state.pool, &headers).await?;
    if input.name.trim().is_empty() {
        return Err(ApiError::bad_request("Project name is required."));
    }
    require_team_role(&state.pool, input.team_id, user_id, &["owner", "editor"]).await?;
    let project = ProjectRecord {
        id: Uuid::new_v4(),
        team_id: input.team_id,
        name: input.name.trim().to_owned(),
        created_at: Utc::now(),
    };
    sqlx::query("INSERT INTO projects (id, team_id, name, created_at) VALUES ($1, $2, $3, $4)")
        .bind(project.id)
        .bind(project.team_id)
        .bind(&project.name)
        .bind(project.created_at)
        .execute(&state.pool)
        .await?;
    audit(&state.pool, user_id, project.id, "project.create").await?;
    Ok(Json(project))
}

async fn get_team_policy(
    State(state): State<CloudState>,
    Path(team_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<OrganizationPolicy>, ApiError> {
    let user_id = authenticate(&state.pool, &headers).await?;
    require_team_role(
        &state.pool,
        team_id,
        user_id,
        &["owner", "editor", "viewer"],
    )
    .await?;
    let row = sqlx::query("SELECT payload FROM team_policies WHERE team_id = $1")
        .bind(team_id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| ApiError::not_found("Team policy not configured."))?;
    Ok(Json(serde_json::from_value(row.get("payload"))?))
}

async fn put_team_policy(
    State(state): State<CloudState>,
    Path(team_id): Path<Uuid>,
    headers: HeaderMap,
    Json(mut policy): Json<OrganizationPolicy>,
) -> Result<Json<OrganizationPolicy>, ApiError> {
    let user_id = authenticate(&state.pool, &headers).await?;
    require_team_role(&state.pool, team_id, user_id, &["owner"]).await?;
    if policy.version == 0 {
        return Err(ApiError::bad_request("Policy version must be positive."));
    }
    let version = i64::try_from(policy.version)
        .map_err(|_| ApiError::bad_request("Policy version is too large."))?;
    policy.source = format!("Team {team_id}");
    sqlx::query(
        "INSERT INTO team_policies (team_id, version, payload, updated_at) VALUES ($1, $2, $3, now()) \
         ON CONFLICT (team_id) DO UPDATE SET version = EXCLUDED.version, payload = EXCLUDED.payload, updated_at = now()",
    )
    .bind(team_id)
    .bind(version)
    .bind(serde_json::to_value(&policy)?)
    .execute(&state.pool)
    .await?;
    Ok(Json(policy))
}

async fn sync_bundle(
    State(state): State<CloudState>,
    Path(project_id): Path<Uuid>,
    headers: HeaderMap,
    Json(bundle): Json<SyncBundle>,
) -> Result<Json<BundleReceipt>, ApiError> {
    let user_id = authenticate(&state.pool, &headers).await?;
    if bundle.project_id != project_id || bundle.source_id.is_nil() {
        return Err(ApiError::bad_request(
            "Project or source identity is invalid.",
        ));
    }
    validate_sync_payload(&serde_json::to_value(&bundle)?)?;
    let fingerprint = compute_sync_bundle_fingerprint(&bundle)?;
    if bundle.fingerprint != fingerprint {
        return Err(ApiError::bad_request(
            "Bundle fingerprint does not match its metadata payload.",
        ));
    }
    require_project_role(&state.pool, project_id, user_id, &["owner", "editor"]).await?;

    let mut transaction = state.pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))")
        .bind(project_id)
        .execute(&mut *transaction)
        .await?;
    let current =
        sqlx::query("SELECT version, fingerprint FROM project_bundles WHERE project_id = $1")
            .bind(project_id)
            .fetch_optional(&mut *transaction)
            .await?;
    let (current_version, current_fingerprint) = current.map_or((0, None), |row| {
        (
            row.get::<i64, _>("version"),
            Some(row.get::<String, _>("fingerprint")),
        )
    });
    if current_version != bundle.base_version {
        transaction.rollback().await?;
        audit(&state.pool, user_id, project_id, "bundle.conflict").await?;
        return Err(ApiError::conflict(
            "Cloud metadata changed; refresh before retrying.",
        ));
    }
    let deduplicated = current_fingerprint.as_deref() == Some(fingerprint.as_str());
    let version = if deduplicated {
        current_version
    } else {
        current_version + 1
    };
    if !deduplicated {
        sqlx::query(
            "INSERT INTO project_bundles (project_id, fingerprint, version, payload, updated_at) \
             VALUES ($1, $2, $3, $4, now()) ON CONFLICT (project_id) DO UPDATE SET \
             fingerprint = EXCLUDED.fingerprint, version = EXCLUDED.version, payload = EXCLUDED.payload, updated_at = now()",
        )
        .bind(project_id)
        .bind(&fingerprint)
        .bind(version)
        .bind(serde_json::to_value(&bundle)?)
        .execute(&mut *transaction)
        .await?;
    }
    transaction.commit().await?;
    audit(&state.pool, user_id, project_id, "bundle.sync").await?;
    Ok(Json(BundleReceipt {
        project_id,
        fingerprint,
        version,
        deduplicated,
    }))
}

/// Computes the canonical content hash used for Cloud bundle deduplication.
/// Transport-only version and fingerprint fields are excluded.
///
/// # Errors
///
/// Returns an error when the metadata bundle cannot be serialized.
pub fn compute_sync_bundle_fingerprint(bundle: &SyncBundle) -> Result<String, ApiError> {
    let mut canonical = bundle.clone();
    canonical.fingerprint.clear();
    canonical.base_version = 0;
    let bytes = serde_json::to_vec(&canonical)?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

async fn list_project_audit(
    State(state): State<CloudState>,
    Path(project_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<Vec<AuditEntry>>, ApiError> {
    let user_id = authenticate(&state.pool, &headers).await?;
    require_project_role(
        &state.pool,
        project_id,
        user_id,
        &["owner", "editor", "viewer"],
    )
    .await?;
    let entries = sqlx::query(
        r"
        SELECT action, created_at FROM (
          SELECT action, created_at FROM audit_log WHERE project_id = $1
          UNION ALL
          SELECT action, created_at FROM account_audit_log WHERE user_id = $2
        ) events
        ORDER BY created_at DESC
        LIMIT 50
        ",
    )
    .bind(project_id)
    .bind(user_id)
    .fetch_all(&state.pool)
    .await?
    .into_iter()
    .map(|row| AuditEntry {
        action: row.get("action"),
        created_at: row.get("created_at"),
    })
    .collect();
    Ok(Json(entries))
}

async fn get_bundle(
    State(state): State<CloudState>,
    Path(project_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<BundleEnvelope>, ApiError> {
    let user_id = authenticate(&state.pool, &headers).await?;
    require_project_role(
        &state.pool,
        project_id,
        user_id,
        &["owner", "editor", "viewer"],
    )
    .await?;
    let row = sqlx::query("SELECT version, payload FROM project_bundles WHERE project_id = $1")
        .bind(project_id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| ApiError::not_found("Project bundle not found."))?;
    let version = row.get::<i64, _>("version");
    let bundle = serde_json::from_value::<SyncBundle>(row.get("payload"))?;
    audit(&state.pool, user_id, project_id, "bundle.download").await?;
    Ok(Json(BundleEnvelope { version, bundle }))
}

async fn create_share(
    State(state): State<CloudState>,
    Path(project_id): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<CreateShareInput>,
) -> Result<Json<ShareRecord>, ApiError> {
    let user_id = authenticate(&state.pool, &headers).await?;
    require_project_role(&state.pool, project_id, user_id, &["owner", "editor"]).await?;
    let expires_at = input
        .expires_at
        .unwrap_or_else(|| Utc::now() + chrono::Duration::days(7));
    if expires_at <= Utc::now() {
        return Err(ApiError::bad_request("Share expiry must be in the future."));
    }
    let id = Uuid::new_v4();
    let created_at = Utc::now();
    let token = Uuid::new_v4().simple().to_string();
    let token_hash = hash_token(&token);
    sqlx::query(
        "INSERT INTO project_shares (id, project_id, token_hash, permission, expires_at, created_by) \
         VALUES ($1, $2, $3, 'viewer', $4, $5)",
    )
    .bind(id)
    .bind(project_id)
    .bind(token_hash)
    .bind(expires_at)
    .bind(user_id)
    .execute(&state.pool)
    .await?;
    audit(&state.pool, user_id, project_id, "share.create").await?;
    Ok(Json(ShareRecord {
        id,
        token,
        permission: "viewer",
        expires_at,
        created_at,
    }))
}

async fn list_shares(
    State(state): State<CloudState>,
    Path(project_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<Vec<ShareSummary>>, ApiError> {
    let user_id = authenticate(&state.pool, &headers).await?;
    require_project_role(&state.pool, project_id, user_id, &["owner", "editor"]).await?;
    let shares = sqlx::query(
        "SELECT id, permission, expires_at, created_at, revoked_at, last_access_at \
         FROM project_shares WHERE project_id = $1 ORDER BY created_at DESC",
    )
    .bind(project_id)
    .fetch_all(&state.pool)
    .await?
    .into_iter()
    .map(|row| ShareSummary {
        id: row.get("id"),
        permission: row.get("permission"),
        expires_at: row.get("expires_at"),
        created_at: row.get("created_at"),
        revoked_at: row.get("revoked_at"),
        last_access_at: row.get("last_access_at"),
    })
    .collect();
    Ok(Json(shares))
}

async fn revoke_share(
    State(state): State<CloudState>,
    Path((project_id, share_id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
) -> Result<StatusCode, ApiError> {
    let user_id = authenticate(&state.pool, &headers).await?;
    require_project_role(&state.pool, project_id, user_id, &["owner", "editor"]).await?;
    let result = sqlx::query(
        "UPDATE project_shares SET revoked_at = now() \
         WHERE id = $1 AND project_id = $2 AND revoked_at IS NULL",
    )
    .bind(share_id)
    .bind(project_id)
    .execute(&state.pool)
    .await?;
    if result.rows_affected() == 0 {
        return Err(ApiError::not_found("Share link not found."));
    }
    audit(&state.pool, user_id, project_id, "share.revoke").await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn rotate_share(
    State(state): State<CloudState>,
    Path((project_id, share_id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
    Json(input): Json<CreateShareInput>,
) -> Result<Json<ShareRecord>, ApiError> {
    let user_id = authenticate(&state.pool, &headers).await?;
    require_project_role(&state.pool, project_id, user_id, &["owner", "editor"]).await?;
    let expires_at = input
        .expires_at
        .unwrap_or_else(|| Utc::now() + chrono::Duration::days(7));
    if expires_at <= Utc::now() {
        return Err(ApiError::bad_request("Share expiry must be in the future."));
    }
    let new_id = Uuid::new_v4();
    let token = Uuid::new_v4().simple().to_string();
    let created_at = Utc::now();
    let mut transaction = state.pool.begin().await?;
    let revoked = sqlx::query(
        "UPDATE project_shares SET revoked_at = now() \
         WHERE id = $1 AND project_id = $2 AND revoked_at IS NULL",
    )
    .bind(share_id)
    .bind(project_id)
    .execute(&mut *transaction)
    .await?;
    if revoked.rows_affected() == 0 {
        transaction.rollback().await?;
        return Err(ApiError::not_found("Share link not found."));
    }
    sqlx::query(
        "INSERT INTO project_shares (id, project_id, token_hash, permission, expires_at, created_by, created_at) \
         VALUES ($1, $2, $3, 'viewer', $4, $5, $6)",
    )
    .bind(new_id)
    .bind(project_id)
    .bind(hash_token(&token))
    .bind(expires_at)
    .bind(user_id)
    .bind(created_at)
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;
    audit(&state.pool, user_id, project_id, "share.rotate").await?;
    Ok(Json(ShareRecord {
        id: new_id,
        token,
        permission: "viewer",
        expires_at,
        created_at,
    }))
}

async fn view_shared_bundle(
    State(state): State<CloudState>,
    Path(share_token): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let row = sqlx::query(
        "UPDATE project_shares s SET last_access_at = now() FROM project_bundles b \
         WHERE b.project_id = s.project_id AND s.token_hash = $1 AND s.permission = 'viewer' \
           AND s.revoked_at IS NULL AND s.expires_at > now() RETURNING b.payload",
    )
    .bind(hash_token(&share_token))
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| ApiError::not_found("Share link not found or expired."))?;
    Ok(Json(row.get("payload")))
}

async fn authorize_bootstrap(state: &CloudState, headers: &HeaderMap) -> Result<(), ApiError> {
    let mut configured = state.bootstrap_secret.lock().await;
    let expected = configured
        .clone()
        .ok_or_else(|| ApiError::forbidden("Account bootstrap is disabled or already used."))?;
    let supplied = headers
        .get("x-bootstrap-secret")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| ApiError::unauthorized("Bootstrap secret is required."))?;
    let now = Instant::now();
    let mut attempts = state.bootstrap_attempts.lock().await;
    while attempts
        .front()
        .is_some_and(|attempt| now.duration_since(*attempt) >= Duration::from_mins(1))
    {
        attempts.pop_front();
    }
    if attempts.len() >= 5 {
        return Err(ApiError::too_many_requests(
            "Bootstrap rate limit exceeded; retry later.",
        ));
    }
    attempts.push_back(now);
    drop(attempts);
    if supplied != expected {
        return Err(ApiError::unauthorized("Bootstrap secret is invalid."));
    }
    configured.take();
    Ok(())
}

/// Verifies that a cloud sync document contains metadata only.
///
/// # Errors
///
/// Returns a bad-request error when a forbidden credential or row-data field is found.
pub fn validate_sync_payload(value: &serde_json::Value) -> Result<(), ApiError> {
    const FORBIDDEN: &[&str] = &[
        "password",
        "connectionString",
        "connectionUri",
        "rows",
        "queryResult",
        "sampleValues",
    ];
    let forbidden: BTreeSet<_> = FORBIDDEN.iter().copied().collect();
    if contains_forbidden_field(value, &forbidden) {
        return Err(ApiError::bad_request(
            "Sync payload contains forbidden sensitive data.",
        ));
    }
    let local_fields = BTreeSet::from(["rootPath", "remoteUrl", "relativePath", "excerptHash"]);
    if contains_non_empty_field(value, &local_fields) {
        return Err(ApiError::bad_request(
            "Sync payload contains local source locations or excerpt hashes.",
        ));
    }
    Ok(())
}

fn contains_forbidden_field(value: &serde_json::Value, forbidden: &BTreeSet<&str>) -> bool {
    match value {
        serde_json::Value::Object(map) => map.iter().any(|(key, value)| {
            forbidden.contains(key.as_str()) || contains_forbidden_field(value, forbidden)
        }),
        serde_json::Value::Array(values) => values
            .iter()
            .any(|value| contains_forbidden_field(value, forbidden)),
        _ => false,
    }
}

fn contains_non_empty_field(value: &serde_json::Value, fields: &BTreeSet<&str>) -> bool {
    match value {
        serde_json::Value::Object(map) => map.iter().any(|(key, value)| {
            (fields.contains(key.as_str())
                && !matches!(value, serde_json::Value::Null)
                && value.as_str() != Some(""))
                || contains_non_empty_field(value, fields)
        }),
        serde_json::Value::Array(values) => values
            .iter()
            .any(|value| contains_non_empty_field(value, fields)),
        _ => false,
    }
}

async fn authenticate(pool: &PgPool, headers: &HeaderMap) -> Result<Uuid, ApiError> {
    let token = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .ok_or_else(|| ApiError::unauthorized("A bearer token is required."))?;
    sqlx::query("SELECT user_id FROM access_tokens WHERE token_hash = $1 AND expires_at > now() AND revoked_at IS NULL")
        .bind(hash_token(token))
        .fetch_optional(pool)
        .await?
        .map(|row| row.get("user_id"))
        .ok_or_else(|| ApiError::unauthorized("Access token is invalid or expired."))
}

async fn require_team_role(
    pool: &PgPool,
    team_id: Uuid,
    user_id: Uuid,
    roles: &[&str],
) -> Result<(), ApiError> {
    let role = sqlx::query("SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2")
        .bind(team_id)
        .bind(user_id)
        .fetch_optional(pool)
        .await?
        .map(|row| row.get::<String, _>("role"));
    if role.as_deref().is_some_and(|role| roles.contains(&role)) {
        Ok(())
    } else {
        Err(ApiError::forbidden("Team permission denied."))
    }
}

async fn require_project_role(
    pool: &PgPool,
    project_id: Uuid,
    user_id: Uuid,
    roles: &[&str],
) -> Result<(), ApiError> {
    let row = sqlx::query("SELECT tm.role FROM projects p JOIN team_members tm ON tm.team_id = p.team_id WHERE p.id = $1 AND tm.user_id = $2")
        .bind(project_id).bind(user_id).fetch_optional(pool).await?;
    if row
        .map(|row| row.get::<String, _>("role"))
        .as_deref()
        .is_some_and(|role| roles.contains(&role))
    {
        Ok(())
    } else {
        Err(ApiError::forbidden("Project permission denied."))
    }
}

async fn audit(
    pool: &PgPool,
    user_id: Uuid,
    project_id: Uuid,
    action: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query("INSERT INTO audit_log (id, user_id, project_id, action, created_at) VALUES ($1, $2, $3, $4, now())")
        .bind(Uuid::new_v4()).bind(user_id).bind(project_id).bind(action).execute(pool).await?;
    Ok(())
}

fn hash_token(token: &str) -> String {
    format!("{:x}", Sha256::digest(token.as_bytes()))
}

#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn bad_request(message: &str) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
        }
    }
    fn unauthorized(message: &str) -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            message: message.into(),
        }
    }
    fn forbidden(message: &str) -> Self {
        Self {
            status: StatusCode::FORBIDDEN,
            message: message.into(),
        }
    }
    fn not_found(message: &str) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            message: message.into(),
        }
    }
    fn conflict(message: &str) -> Self {
        Self {
            status: StatusCode::CONFLICT,
            message: message.into(),
        }
    }
    fn too_many_requests(message: &str) -> Self {
        Self {
            status: StatusCode::TOO_MANY_REQUESTS,
            message: message.into(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        (
            self.status,
            Json(serde_json::json!({ "error": self.message })),
        )
            .into_response()
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(_: sqlx::Error) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: "Cloud storage error.".into(),
        }
    }
}

impl From<serde_json::Error> for ApiError {
    fn from(_: serde_json::Error) -> Self {
        Self::bad_request("Invalid metadata payload.")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request;
    use sqlx::postgres::PgPoolOptions;
    use tower::ServiceExt;

    #[test]
    fn rejects_nested_sensitive_data() {
        let payload = serde_json::json!({ "snapshot": { "schemas": [] }, "password": "secret" });
        assert!(validate_sync_payload(&payload).is_err());
    }

    #[test]
    fn accepts_metadata_only_payload() {
        let payload = serde_json::json!({ "snapshot": { "schemas": [] }, "annotations": [] });
        assert!(validate_sync_payload(&payload).is_ok());
    }

    #[test]
    fn bundle_fingerprint_covers_metadata_but_not_transport_version() {
        let mut bundle = SyncBundle {
            project_id: Uuid::new_v4(),
            source_id: Uuid::new_v4(),
            source_label: "Test".into(),
            fingerprint: String::new(),
            snapshot: None,
            change_set: None,
            annotations: Vec::new(),
            domain_groups: Vec::new(),
            saved_views: Vec::new(),
            logical_relationships: Vec::new(),
            layout: None,
            project_settings: None,
            project_graphs: Vec::new(),
            base_version: 0,
        };
        let first = compute_sync_bundle_fingerprint(&bundle).expect("fingerprint");
        bundle.base_version = 42;
        assert_eq!(
            compute_sync_bundle_fingerprint(&bundle).expect("fingerprint"),
            first
        );
        bundle.source_label = "Changed".into();
        assert_ne!(
            compute_sync_bundle_fingerprint(&bundle).expect("fingerprint"),
            first
        );
    }

    #[test]
    fn rejects_local_source_locations_but_accepts_redacted_fields() {
        let leaked = serde_json::json!({ "projectGraphs": [{ "nodes": [{ "relativePath": "src/orders.rs" }] }] });
        let redacted = serde_json::json!({ "projectGraphs": [{ "nodes": [{ "relativePath": null, "excerptHash": null }] }] });
        assert!(validate_sync_payload(&leaked).is_err());
        assert!(validate_sync_payload(&redacted).is_ok());
    }

    #[tokio::test]
    async fn health_route_does_not_require_database_access() {
        let pool = PgPoolOptions::new()
            .connect_lazy("postgres://unused:unused@127.0.0.1/unused")
            .expect("lazy pool");
        let response = router(CloudState::new(pool))
            .oneshot(
                Request::get("/health")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .expect("router response");
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn account_bootstrap_is_disabled_without_an_operator_secret() {
        let pool = PgPoolOptions::new()
            .connect_lazy("postgres://unused:unused@127.0.0.1/unused")
            .expect("lazy pool");
        let response = router(CloudState::new(pool))
            .oneshot(
                Request::post("/v1/auth/bootstrap")
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(
                        r#"{"email":"a@example.com","displayName":"A","teamName":"T"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .expect("router response");
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn bootstrap_secret_is_consumed_after_one_authorization() {
        let pool = PgPoolOptions::new()
            .connect_lazy("postgres://unused:unused@127.0.0.1/unused")
            .expect("lazy pool");
        let state = CloudState::new(pool)
            .with_bootstrap_secret(Some("a-valid-bootstrap-secret-1234".into()));
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-bootstrap-secret",
            "a-valid-bootstrap-secret-1234".parse().unwrap(),
        );
        assert!(authorize_bootstrap(&state, &headers).await.is_ok());
        assert_eq!(
            authorize_bootstrap(&state, &headers)
                .await
                .unwrap_err()
                .status,
            StatusCode::FORBIDDEN
        );
    }
}
