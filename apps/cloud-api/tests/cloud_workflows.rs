use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use nodalstudio_cloud_api::{CloudState, SyncBundle, compute_sync_bundle_fingerprint, router};
use sqlx::{PgPool, postgres::PgPoolOptions};
use tower::ServiceExt;
use uuid::Uuid;

async fn request(
    app: Router,
    method: &str,
    path: &str,
    token: Option<&str>,
    bootstrap_secret: Option<&str>,
    body: serde_json::Value,
) -> (StatusCode, serde_json::Value) {
    let mut builder = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    if let Some(token) = token {
        builder = builder.header("authorization", format!("Bearer {token}"));
    }
    if let Some(secret) = bootstrap_secret {
        builder = builder.header("x-bootstrap-secret", secret);
    }
    let response = app
        .oneshot(builder.body(Body::from(body.to_string())).expect("request"))
        .await
        .expect("response");
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 20 * 1024 * 1024)
        .await
        .expect("body");
    let value = if bytes.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::from_slice(&bytes).expect("json response")
    };
    (status, value)
}

async fn database() -> Option<PgPool> {
    let url = std::env::var("TEST_CLOUD_DATABASE_URL").ok()?;
    let pool = PgPoolOptions::new()
        .max_connections(8)
        .connect(&url)
        .await
        .ok()?;
    sqlx::query("DROP SCHEMA public CASCADE")
        .execute(&pool)
        .await
        .expect("drop test schema");
    sqlx::query("CREATE SCHEMA public")
        .execute(&pool)
        .await
        .expect("create test schema");
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("cloud migrations");
    Some(pool)
}

#[tokio::test]
#[allow(clippy::too_many_lines)]
async fn cloud_conflicts_and_share_lifecycle_are_enforced() {
    let Some(pool) = database().await else {
        eprintln!("TEST_CLOUD_DATABASE_URL is not configured; skipping Cloud integration test");
        return;
    };
    let secret = "integration-bootstrap-secret-123456";
    let app = router(CloudState::new(pool.clone()).with_bootstrap_secret(Some(secret.into())));
    let (status, session) = request(
        app.clone(),
        "POST",
        "/v1/auth/bootstrap",
        None,
        Some(secret),
        serde_json::json!({
            "email": "owner@example.com",
            "displayName": "Owner",
            "teamName": "Engineering"
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let token = session["accessToken"].as_str().expect("access token");
    let team_id = session["teamId"].as_str().expect("team id");
    let user_id = Uuid::parse_str(session["userId"].as_str().expect("user id")).unwrap();
    let second_team = Uuid::new_v4();
    sqlx::query("INSERT INTO teams (id, name) VALUES ($1, 'Second team')")
        .bind(second_team)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'viewer')")
        .bind(second_team)
        .bind(user_id)
        .execute(&pool)
        .await
        .unwrap();
    let (status, refreshed) = request(
        app.clone(),
        "POST",
        "/v1/auth/refresh",
        None,
        None,
        serde_json::json!({ "refreshToken": session["refreshToken"] }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(refreshed["teamId"], team_id);
    let (status, project) = request(
        app.clone(),
        "POST",
        "/v1/projects",
        Some(token),
        None,
        serde_json::json!({ "teamId": team_id, "name": "Model" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let project_id = Uuid::parse_str(project["id"].as_str().expect("project id")).unwrap();
    let mut bundle = SyncBundle {
        project_id,
        source_id: Uuid::new_v4(),
        source_label: "Integration".into(),
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
    bundle.fingerprint = compute_sync_bundle_fingerprint(&bundle).expect("fingerprint");
    let payload = serde_json::to_value(&bundle).unwrap();
    let path = format!("/v1/projects/{project_id}/bundle");
    let first = request(
        app.clone(),
        "PUT",
        &path,
        Some(token),
        None,
        payload.clone(),
    );
    let second = request(app.clone(), "PUT", &path, Some(token), None, payload);
    let ((first_status, _), (second_status, _)) = tokio::join!(first, second);
    assert_eq!(
        [first_status, second_status]
            .into_iter()
            .filter(|status| *status == StatusCode::OK)
            .count(),
        1
    );
    assert_eq!(
        [first_status, second_status]
            .into_iter()
            .filter(|status| *status == StatusCode::CONFLICT)
            .count(),
        1
    );

    let share_path = format!("/v1/projects/{project_id}/shares");
    let (status, share) = request(
        app.clone(),
        "POST",
        &share_path,
        Some(token),
        None,
        serde_json::json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let share_id = share["id"].as_str().unwrap();
    let share_token = share["token"].as_str().unwrap();
    let (status, _) = request(
        app.clone(),
        "GET",
        &format!("/v1/view/{share_token}"),
        None,
        None,
        serde_json::Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = request(
        app.clone(),
        "DELETE",
        &format!("{share_path}/{share_id}"),
        Some(token),
        None,
        serde_json::Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _) = request(
        app.clone(),
        "GET",
        &format!("/v1/view/{share_token}"),
        None,
        None,
        serde_json::Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let (status, second_share) = request(
        app.clone(),
        "POST",
        &share_path,
        Some(token),
        None,
        serde_json::json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let second_id = second_share["id"].as_str().unwrap();
    let second_token = second_share["token"].as_str().unwrap();
    let (status, replacement) = request(
        app.clone(),
        "POST",
        &format!("{share_path}/{second_id}/rotate"),
        Some(token),
        None,
        serde_json::json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let replacement_token = replacement["token"].as_str().unwrap();
    let (old_status, _) = request(
        app.clone(),
        "GET",
        &format!("/v1/view/{second_token}"),
        None,
        None,
        serde_json::Value::Null,
    )
    .await;
    let (new_status, _) = request(
        app,
        "GET",
        &format!("/v1/view/{replacement_token}"),
        None,
        None,
        serde_json::Value::Null,
    )
    .await;
    assert_eq!(old_status, StatusCode::NOT_FOUND);
    assert_eq!(new_status, StatusCode::OK);
}
