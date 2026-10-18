//! A real local HTTP service plus `PostgreSQL` transport, with two isolated receivers.
//! This closes the transport integration gap, not the physical two-device acceptance.
use super::*;

async fn publish(
    client: &reqwest::Client,
    endpoint: &str,
    token: &str,
    project: Uuid,
    version: i64,
    sender: &LocalSnapshotStore,
    snapshot: &DatabaseSnapshot,
) -> i64 {
    let mut bundle = CloudSyncBundle {
        project_id: project,
        source_id: snapshot.source_id,
        source_label: "Synthetic acceptance".into(),
        fingerprint: String::new(),
        snapshot: Some(snapshot.clone()),
        change_set: None,
        annotations: sender.list_annotations(snapshot.source_id).await.unwrap(),
        domain_groups: vec![],
        saved_views: vec![],
        logical_relationships: vec![],
        layout: None,
        project_settings: None,
        base_version: version,
    };
    bundle.fingerprint = cloud_bundle_fingerprint(&bundle).unwrap();
    let text = serde_json::to_string(&bundle).unwrap();
    assert!(!text.contains("privateLocalProof"));
    assert!(!text.contains("confirmedAt"));
    let response = client
        .put(format!("{endpoint}/v1/projects/{project}/bundle"))
        .bearer_auth(token)
        .json(&bundle)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    response.json::<CloudBundleReceipt>().await.unwrap().version
}

async fn receive_http(
    client: &reqwest::Client,
    endpoint: &str,
    token: &str,
    project: Uuid,
    receiver: &LocalSnapshotStore,
    source: Uuid,
) {
    let response = client
        .get(format!("{endpoint}/v1/projects/{project}/bundle"))
        .bearer_auth(token)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let envelope = response.json::<CloudBundleEnvelope>().await.unwrap();
    apply_remote_cloud_bundle(receiver, source, &envelope.bundle)
        .await
        .unwrap();
}

#[tokio::test]
#[ignore = "requires the disposable local Cloud HTTP service and its PostgreSQL database"]
#[allow(clippy::too_many_lines)]
async fn live_cloud_http_preserves_local_review_on_round_trip() {
    let endpoint = std::env::var("NODAL_ACCEPTANCE_CLOUD_URL").expect("set local acceptance URL");
    let url = reqwest::Url::parse(&endpoint).unwrap();
    assert_eq!(url.scheme(), "http");
    assert_eq!(
        url.host_str(),
        Some("127.0.0.1"),
        "test creates a disposable project on loopback only"
    );
    let secret = std::env::var("NODAL_ACCEPTANCE_BOOTSTRAP_SECRET")
        .expect("set disposable bootstrap secret");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .unwrap();
    let response = client.post(format!("{endpoint}/v1/auth/bootstrap"))
        .header("x-bootstrap-secret", secret)
        .json(&serde_json::json!({"email":"acceptance@example.invalid","displayName":"Acceptance","teamName":"Disposable"}))
        .send().await.unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::CREATED);
    let session: serde_json::Value = response.json().await.unwrap();
    let token = session["accessToken"].as_str().unwrap();
    let response = client
        .post(format!("{endpoint}/v1/projects"))
        .bearer_auth(token)
        .json(&serde_json::json!({"teamId":session["teamId"],"name":"Knowledge acceptance"}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let project: serde_json::Value = response.json().await.unwrap();
    let project = Uuid::parse_str(project["id"].as_str().unwrap()).unwrap();
    let a = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
    let b = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
    let mut snapshot = model(Uuid::new_v4());
    a.save_captured_snapshot(&snapshot).await.unwrap();
    a.save_annotation(&annotation(snapshot.source_id))
        .await
        .unwrap();
    confirm(&a, &snapshot).await;
    let version = publish(&client, &endpoint, token, project, 0, &a, &snapshot).await;
    assert_eq!(version, 1);
    receive_http(&client, &endpoint, token, project, &b, snapshot.source_id).await;
    assert_eq!(
        status(&b, snapshot.source_id).await,
        KnowledgeStatus::PendingReview
    );
    assert!(
        b.confirmed_annotations(snapshot.source_id)
            .await
            .unwrap()
            .is_empty()
    );
    confirm(&b, &snapshot).await;
    let confirmed = b.knowledge_states(snapshot.source_id).await.unwrap()[0]
        .confirmation
        .clone()
        .unwrap();
    receive_http(&client, &endpoint, token, project, &b, snapshot.source_id).await;
    assert_eq!(
        status(&b, snapshot.source_id).await,
        KnowledgeStatus::Confirmed
    );
    assert_eq!(
        b.knowledge_states(snapshot.source_id).await.unwrap()[0]
            .confirmation
            .as_ref()
            .unwrap()
            .id,
        confirmed.id
    );
    snapshot.id = Uuid::new_v4();
    snapshot.captured_at = Utc::now();
    snapshot.schemas[0].tables[0].constraints.clear();
    snapshot.canonicalize().unwrap();
    a.save_captured_snapshot(&snapshot).await.unwrap();
    assert_eq!(
        status(&a, snapshot.source_id).await,
        KnowledgeStatus::PendingReview
    );
    let version = publish(&client, &endpoint, token, project, version, &a, &snapshot).await;
    assert_eq!(version, 2);
    receive_http(&client, &endpoint, token, project, &b, snapshot.source_id).await;
    assert_eq!(
        status(&b, snapshot.source_id).await,
        KnowledgeStatus::PendingReview
    );
    receive_http(&client, &endpoint, token, project, &b, snapshot.source_id).await;
    assert_eq!(
        status(&b, snapshot.source_id).await,
        KnowledgeStatus::PendingReview
    );
    assert!(
        b.confirmed_annotations(snapshot.source_id)
            .await
            .unwrap()
            .is_empty()
    );
    let mut edited = b
        .list_annotations(snapshot.source_id)
        .await
        .unwrap()
        .remove(0);
    edited.description = Some("Description edited and reviewed only on B".into());
    b.save_annotation(&edited).await.unwrap();
    confirm(&b, &snapshot).await;
    let version = publish(&client, &endpoint, token, project, version, &b, &snapshot).await;
    assert_eq!(version, 3);
    receive_http(&client, &endpoint, token, project, &a, snapshot.source_id).await;
    assert_eq!(
        status(&a, snapshot.source_id).await,
        KnowledgeStatus::PendingReview
    );
    assert!(
        a.confirmed_annotations(snapshot.source_id)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        a.list_annotations(snapshot.source_id).await.unwrap()[0].description,
        edited.description
    );
    println!(
        "LIVE_CLOUD_ACCEPTANCE: actual HTTP and PostgreSQL; first import pending, local confirmation preserved on identical import, changed basis invalidates, pending reimport stays pending, edited return never inherits sender proof"
    );
}
