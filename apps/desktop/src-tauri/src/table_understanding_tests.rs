use super::*;
use schema_model::{
    DatabaseInfo, DatabaseSnapshot, DatabaseType, SchemaDefinition, TableDefinition,
};
use settings_model::DataSourceSettings;
use snapshot_store::LocalSnapshotStore;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::{Semaphore, oneshot},
};

async fn fixture(endpoint: &str) -> (AppState, TableInput, DataSourceSettings) {
    let store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
    let mut snapshot = DatabaseSnapshot::new(
        Uuid::new_v4(),
        DatabaseInfo {
            name: "private-database-name".into(),
            database_type: DatabaseType::PostgreSql,
            version: "17".into(),
        },
        vec![SchemaDefinition {
            programs: Vec::new(),
            dependencies: Vec::new(),
            name: "public".into(),
            tables: vec![
                TableDefinition::empty("public", "orders"),
                TableDefinition::empty("public", "private_unrelated"),
            ],
            views: vec![],
            enums: vec![],
        }],
    );
    snapshot.canonicalize().unwrap();
    store.save_snapshot(&snapshot).await.unwrap();
    let mut settings = DataSourceSettings::defaults_for(snapshot.source_id);
    settings.ai.enabled = true;
    settings.ai.provider = AiProviderKind::OpenAiCompatible;
    settings.ai.endpoint = endpoint.into();
    settings.ai.model = "fixture-model".into();
    store.save_data_source_settings(&settings).await.unwrap();
    let input = TableInput {
        ui_locale: None,
        snapshot_id: snapshot.id,
        target: ObjectKey::table("public", "orders"),
        focus_column: None,
        domain_id: None,
        question: "What is one row?".into(),
    };
    (
        AppState {
            store,
            ai_limiter: Arc::new(Semaphore::new(840)),
            snapshot_captures: Arc::default(),
            cloud_operations: Arc::default(),
            active_queries: Arc::default(),
        },
        input,
        settings,
    )
}

fn task(prepared: Prepared) -> Task {
    Task {
        prepared,
        created: Instant::now(),
        cancellation: CancellationToken::new(),
        started: AtomicBool::new(false),
    }
}

/// A single local HTTP exchange. Tests control exactly when the response becomes available.
async fn server() -> (
    String,
    oneshot::Receiver<Value>,
    oneshot::Sender<(u16, String)>,
    tokio::task::JoinHandle<()>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let (received_tx, received) = oneshot::channel();
    let (respond, response_rx) = oneshot::channel::<(u16, String)>();
    let handle = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut bytes = Vec::new();
        let body = loop {
            let mut buffer = [0; 4096];
            let count = socket.read(&mut buffer).await.unwrap();
            assert!(count > 0);
            bytes.extend_from_slice(&buffer[..count]);
            if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&bytes[..end]).to_lowercase();
                let length = headers
                    .lines()
                    .find_map(|l| l.strip_prefix("content-length: "))
                    .unwrap()
                    .parse::<usize>()
                    .unwrap();
                if bytes.len() >= end + 4 + length {
                    break serde_json::from_slice(&bytes[end + 4..end + 4 + length]).unwrap();
                }
            }
        };
        received_tx.send(body).unwrap();
        if let Ok((status, body)) = response_rx.await {
            let wire = format!(
                "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = socket.write_all(wire.as_bytes()).await;
        }
    });
    (endpoint, received, respond, handle)
}

fn answer() -> String {
    serde_json::json!({"choices":[{"message":{"content":r#"{"schemaVersion":2,"summary":{"text":"Possibly an order record; grain needs confirmation.","evidenceIds":["e1"]},"interpretations":[{"text":"Possibly an order record; grain needs confirmation.","evidenceIds":["e1"]}],"unknowns":["What identifies one order?"]}"#}}]}).to_string()
}

fn completed_result(task: &Task) -> TableResult {
    let preview = &task.prepared.preview;
    TableResult {
        request_id: preview.request_id,
        source_id: preview.source_id,
        snapshot_id: preview.snapshot_id,
        target: preview.context.target.clone(),
        provider: preview.provider.clone(),
        model: preview.model.clone(),
        generated_at: "2026-10-18T10:00:00Z".into(),
        answer: ModelUnderstanding {
            schema_version: 2,
            summary: Some(understanding::Interpretation {
                text: "Possibly an order record; grain needs confirmation.".into(),
                evidence_ids: vec!["e1".into()],
            }),
            interpretations: vec![understanding::Interpretation {
                text: "Possibly an order record; grain needs confirmation.".into(),
                evidence_ids: vec!["e1".into()],
            }],
            unknowns: vec!["What identifies one order?".into()],
        },
    }
}

#[tokio::test]
async fn knowledge_draft_uses_one_current_claim_and_cancel_prevents_late_answer_caching() {
    let (app, input, mut settings) = fixture("http://localhost:9").await;
    let tasks = TableAiState::default();
    let request = Arc::new(task(prepare(&app, input.clone()).await.unwrap()));
    let id = request.prepared.preview.request_id;
    tasks.tasks.lock().await.insert(id, request.clone());
    let result = completed_result(&request);
    tasks.finish(id, request, Ok(result)).await.unwrap();
    let (preview, draft, origin) = tasks.draft_source(&app, id, Some(0)).await.unwrap();
    assert_eq!(preview.request_id, id);
    assert_eq!(draft, "Possibly an order record; grain needs confirmation.");
    assert_eq!(origin.generated_at.as_deref(), Some("2026-10-18T10:00:00Z"));
    assert_eq!(origin.evidence["unknowns"][0], "What identifies one order?");
    assert_eq!(
        origin.evidence["evidence"],
        serde_json::to_value(&preview.context.evidence).unwrap()
    );
    assert!(tasks.draft_source(&app, id, Some(1)).await.is_err());
    let (_, complete_draft, complete_origin) = tasks.draft_source(&app, id, None).await.unwrap();
    assert!(complete_draft.starts_with("Possibly an order record; grain needs confirmation."));
    assert!(complete_draft.ends_with("What identifies one order?"));
    assert_eq!(complete_origin.evidence["answer"]["schemaVersion"], 2);
    assert_eq!(
        complete_origin.evidence["answer"]["summary"]["evidenceIds"][0],
        "e1"
    );
    settings.ai.include_comments = !settings.ai.include_comments;
    app.store
        .save_data_source_settings(&settings)
        .await
        .unwrap();
    assert!(tasks.draft_source(&app, id, Some(0)).await.is_err());
    tasks.cancel(id).await;
    assert!(tasks.completed.lock().await.is_empty());

    // Cancellation can win before finish, or after finish: neither order leaves a draft source.
    let request = Arc::new(task(prepare(&app, input.clone()).await.unwrap()));
    let id = request.prepared.preview.request_id;
    let result = completed_result(&request);
    tasks.tasks.lock().await.insert(id, request.clone());
    tasks.cancel(id).await;
    assert!(tasks.finish(id, request, Ok(result)).await.is_err());
    assert!(tasks.draft_source(&app, id, Some(0)).await.is_err());

    let mut expired = task(prepare(&app, input).await.unwrap());
    expired.created = crate::tests::expired_instant(PREVIEW_LIFETIME).await;
    let result = completed_result(&expired);
    let id = result.request_id;
    tasks
        .completed
        .lock()
        .await
        .insert(id, (Arc::new(expired), result.answer, result.generated_at));
    assert!(
        tasks
            .draft_source(&app, id, Some(0))
            .await
            .err()
            .unwrap()
            .contains("expired")
    );
}

#[tokio::test]
async fn cancelling_completed_answer_invalidates_already_borrowed_draft_source() {
    let (app, input, _) = fixture("http://localhost:9").await;
    let tasks = TableAiState::default();
    let request = Arc::new(task(prepare(&app, input).await.unwrap()));
    let id = request.prepared.preview.request_id;
    tasks.tasks.lock().await.insert(id, request.clone());
    let result = completed_result(&request);
    tasks.finish(id, request, Ok(result)).await.unwrap();
    // draft_source clones this task before asynchronously validating its evidence.
    let borrowed = tasks.completed.lock().await.get(&id).unwrap().0.clone();
    tasks.cancel(id).await;
    assert!(
        validate_current(&app, &borrowed)
            .await
            .unwrap_err()
            .contains("cancelled")
    );
    assert!(tasks.draft_source(&app, id, None).await.is_err());
}

#[tokio::test]
async fn complete_answer_draft_preserves_all_unicode_text_at_contract_limits() {
    let (app, input, _) = fixture("http://localhost:9").await;
    let tasks = TableAiState::default();
    let request = Arc::new(task(prepare(&app, input).await.unwrap()));
    let id = request.prepared.preview.request_id;
    let mut result = completed_result(&request);
    let summary = "答".repeat(600);
    let supporting = ["甲".repeat(250), "乙".repeat(250), "丙".repeat(250)];
    let unknowns = ["疑".repeat(150), "问".repeat(150), "待".repeat(150)];
    let model_output = serde_json::json!({
        "schemaVersion": 2,
        "summary": {"text": summary, "evidenceIds": ["e1"]},
        "interpretations": supporting.iter().map(|text| {
            serde_json::json!({"text": text, "evidenceIds": ["e1"]})
        }).collect::<Vec<_>>(),
        "unknowns": unknowns,
    });
    result.answer = understanding::validate_model_output(
        &model_output.to_string(),
        &request.prepared.preview.context,
    )
    .unwrap();
    tasks.tasks.lock().await.insert(id, request.clone());
    tasks.finish(id, request, Ok(result)).await.unwrap();
    let (_, draft, origin) = tasks.draft_source(&app, id, None).await.unwrap();
    let expected = std::iter::once(&summary)
        .chain(&supporting)
        .chain(&unknowns)
        .cloned()
        .collect::<Vec<_>>()
        .join("\n\n");
    assert_eq!(draft, expected);
    assert_eq!(origin.evidence["answer"], model_output);
    assert_eq!(draft.chars().count(), 1_812);
}

#[tokio::test]
async fn wire_body_equals_reviewed_preview_and_excludes_unrelated_metadata() {
    let (endpoint, received, respond, server) = server().await;
    let (app, input, _) = fixture(&endpoint).await;
    let task = task(prepare(&app, input).await.unwrap());
    let preview = task.prepared.preview.clone();
    let running = tokio::spawn(async move { execute(&app, &task, Some("fixture-key")).await });
    let wire = received.await.unwrap();
    assert_eq!(wire, preview.request_body);
    for private in ["fixture-key", "private_unrelated", "private-database-name"] {
        assert!(!wire.to_string().contains(private));
    }
    respond.send((200, answer())).unwrap();
    let result = running.await.unwrap().unwrap();
    assert_eq!(result.request_id, preview.request_id);
    assert_eq!(result.answer.interpretations[0].evidence_ids, ["e1"]);
    server.await.unwrap();
}

#[tokio::test]
async fn deepseek_provider_body_is_previewed_and_forwarded_without_bridge_changes() {
    let (endpoint, received, respond, server) = server().await;
    let (app, input, mut settings) = fixture("https://api.deepseek.com/v1").await;
    settings.ai.model = "deepseek-flash".into();
    app.store
        .save_data_source_settings(&settings)
        .await
        .unwrap();
    let running =
        tokio::spawn(async move { run_live_acceptance(&app, input, true, &endpoint).await });
    let wire = received.await.unwrap();
    assert_eq!(wire["thinking"], serde_json::json!({"type":"disabled"}));
    assert_eq!(wire["max_tokens"], 2048);
    assert_eq!(wire["model"], "deepseek-flash");
    respond.send((200, answer())).unwrap();
    let (preview, result) = running.await.unwrap().unwrap();
    assert_eq!(wire, preview["requestBody"]);
    assert_eq!(
        preview["endpoint"],
        "https://api.deepseek.com/v1/chat/completions"
    );
    assert_eq!(result["model"], "deepseek-flash");
    server.await.unwrap();
}

#[tokio::test]
async fn truncated_table_answer_is_rejected_even_if_json_is_valid_and_retries_are_enabled() {
    let (endpoint, received, respond, server) = server().await;
    let (app, input, settings) = fixture(&endpoint).await;
    assert!(settings.ai.max_retries > 0);
    let task = task(prepare(&app, input).await.unwrap());
    let running = tokio::spawn(async move { execute(&app, &task, Some("fixture-key")).await });
    received.await.unwrap();
    let mut truncated: Value = serde_json::from_str(&answer()).unwrap();
    truncated["choices"][0]["finish_reason"] = serde_json::json!("length");
    respond.send((200, truncated.to_string())).unwrap();
    assert_eq!(
        running.await.unwrap().err().unwrap(),
        crate::ai_chat::TRUNCATED_OUTPUT
    );
    server.await.unwrap();
}

#[tokio::test]
async fn effective_changes_expiry_and_new_snapshots_invalidate_previews() {
    let (app, input, mut settings) = fixture("http://localhost:9").await;
    let mut prepared_task = task(prepare(&app, input.clone()).await.unwrap());
    settings.ai.include_comments = !settings.ai.include_comments;
    app.store
        .save_data_source_settings(&settings)
        .await
        .unwrap();
    assert!(
        validate_current(&app, &prepared_task)
            .await
            .unwrap_err()
            .contains("changed")
    );
    prepared_task = task(prepare(&app, input.clone()).await.unwrap());
    prepared_task.created = crate::tests::expired_instant(PREVIEW_LIFETIME).await;
    assert!(
        validate_current(&app, &prepared_task)
            .await
            .unwrap_err()
            .contains("expired")
    );
    let mut newer = app
        .store
        .get_snapshot(input.snapshot_id)
        .await
        .unwrap()
        .unwrap();
    newer.id = Uuid::new_v4();
    newer.captured_at += chrono::Duration::seconds(1);
    newer.schemas[0]
        .tables
        .push(TableDefinition::empty("public", "new_table"));
    newer.canonicalize().unwrap();
    app.store.save_snapshot(&newer).await.unwrap();
    assert!(prepare(&app, input).await.err().unwrap().contains("latest"));
}

#[tokio::test]
async fn settings_change_during_response_prevents_acceptance_and_retries() {
    for status in [200, 500] {
        let (endpoint, received, respond, server) = server().await;
        let (app, input, mut settings) = fixture(&endpoint).await;
        let task = task(prepare(&app, input).await.unwrap());
        let runner_app = app.clone();
        let running =
            tokio::spawn(async move { execute(&runner_app, &task, Some("fixture-key")).await });
        received.await.unwrap();
        settings.ai.enabled = false;
        app.store
            .save_data_source_settings(&settings)
            .await
            .unwrap();
        respond.send((status, answer())).unwrap();
        assert!(running.await.unwrap().err().unwrap().contains("disabled"));
        assert_eq!(app.ai_limiter.available_permits(), 840);
        server.await.unwrap();
    }
}

#[tokio::test]
async fn cancellation_interrupts_inflight_http_and_releases_concurrency() {
    let (endpoint, received, respond, server) = server().await;
    let (app, input, _) = fixture(&endpoint).await;
    let task = task(prepare(&app, input).await.unwrap());
    let cancellation = task.cancellation.clone();
    let runner_app = app.clone();
    let running =
        tokio::spawn(async move { execute(&runner_app, &task, Some("fixture-key")).await });
    received.await.unwrap();
    cancellation.cancel();
    let result = tokio::time::timeout(Duration::from_secs(1), running)
        .await
        .unwrap()
        .unwrap();
    assert!(result.err().unwrap().contains("cancelled"));
    assert_eq!(app.ai_limiter.available_permits(), 840);
    drop(respond);
    server.await.unwrap();
}

#[tokio::test]
async fn offline_provider_and_offline_mode_never_send_remote_requests() {
    let (app, input, mut settings) = fixture("http://localhost:9").await;
    let mut app_settings = app.store.get_app_settings().await.unwrap();
    app_settings.privacy.offline_mode = true;
    app.store.save_app_settings(&app_settings).await.unwrap();
    assert!(
        prepare(&app, input.clone())
            .await
            .err()
            .unwrap()
            .contains("offline")
    );
    settings.ai.provider = AiProviderKind::Offline;
    app.store
        .save_data_source_settings(&settings)
        .await
        .unwrap();
    let task = task(prepare(&app, input).await.unwrap());
    assert!(task.prepared.preview.endpoint.is_none());
    assert!(task.prepared.preview.request_body.is_null());
    let result = execute(&app, &task, None).await.unwrap();
    assert!(result.answer.interpretations.is_empty());
    assert!(result.answer.summary.is_none());
    assert_eq!(result.answer.schema_version, 2);
}

#[tokio::test]
async fn edited_domain_invalidates_even_if_effective_table_set_is_unchanged() {
    let (app, mut input, mut settings) = fixture("http://localhost:9").await;
    settings.ai.context_scope = AiContextScope::Domain;
    app.store
        .save_data_source_settings(&settings)
        .await
        .unwrap();
    assert!(prepare(&app, input.clone()).await.is_err());
    let mut domain = semantic_model::DomainGroup {
        id: Uuid::new_v4(),
        source_id: settings.source_id,
        name: "Orders".into(),
        description: None,
        color: "blue".into(),
        table_keys: vec![input.target.clone()],
        updated_at: chrono::Utc::now(),
    };
    app.store.save_domain_group(&domain).await.unwrap();
    input.domain_id = Some(domain.id);
    let task = task(prepare(&app, input).await.unwrap());
    domain.name = "Renamed".into();
    app.store.save_domain_group(&domain).await.unwrap();
    assert!(
        validate_current(&app, &task)
            .await
            .unwrap_err()
            .contains("changed")
    );
}

#[tokio::test]
async fn provider_timeout_and_oversized_response_fail_without_unbounded_retries() {
    let (endpoint, received, respond, server) = server().await;
    let (app, input, mut settings) = fixture(&endpoint).await;
    settings.ai.timeout_seconds = 1;
    settings.ai.max_retries = 0;
    app.store
        .save_data_source_settings(&settings)
        .await
        .unwrap();
    let task = task(prepare(&app, input).await.unwrap());
    let running = tokio::spawn(async move { execute(&app, &task, Some("fixture-key")).await });
    received.await.unwrap();
    assert!(
        tokio::time::timeout(Duration::from_secs(3), running)
            .await
            .unwrap()
            .unwrap()
            .err()
            .unwrap()
            .contains("timed out")
    );
    drop(respond);
    server.await.unwrap();

    let (endpoint, received, respond, server) = self::server().await;
    let (app, input, _) = fixture(&endpoint).await;
    let task = self::task(prepare(&app, input).await.unwrap());
    let running = tokio::spawn(async move { execute(&app, &task, Some("fixture-key")).await });
    received.await.unwrap();
    respond
        .send((200, "x".repeat(MAX_RESPONSE_BYTES + 1)))
        .unwrap();
    assert!(running.await.unwrap().err().unwrap().contains("128 KiB"));
    server.await.unwrap();
}

#[tokio::test]
async fn imported_settings_cannot_bypass_request_limits_or_embed_url_secrets() {
    let (app, input, settings) = fixture("http://localhost:9").await;
    for variant in 0..4 {
        let mut invalid = settings.clone();
        match variant {
            0 => invalid.ai.max_retries = 255,
            1 => invalid.ai.max_concurrency = 255,
            2 => invalid.ai.timeout_seconds = 301,
            _ => invalid.ai.endpoint = "https://user:secret@example.invalid/v1".into(),
        }
        app.store.save_data_source_settings(&invalid).await.unwrap();
        assert!(prepare(&app, input.clone()).await.is_err());
    }
}

async fn logical_fixture(
    endpoint: &str,
) -> (
    AppState,
    TableInput,
    DataSourceSettings,
    schema_model::LogicalRelationship,
) {
    use schema_model::{
        ColumnDefinition, LogicalRelationship, LogicalRelationshipOrigin, RelationshipCardinality,
        RelationshipEndpoint,
    };
    let (app, mut input, mut settings) = fixture(endpoint).await;
    settings.ai.context_scope = AiContextScope::OneHop;
    app.store
        .save_data_source_settings(&settings)
        .await
        .unwrap();
    let mut snapshot = app
        .store
        .get_snapshot(input.snapshot_id)
        .await
        .unwrap()
        .unwrap();
    snapshot.id = Uuid::new_v4();
    snapshot.captured_at += chrono::Duration::seconds(1);
    for table in &mut snapshot.schemas[0].tables {
        table.columns.push(ColumnDefinition {
            name: "id".into(),
            ordinal_position: 1,
            formatted_type: "bigint".into(),
            type_schema: "pg_catalog".into(),
            type_name: "int8".into(),
            nullable: false,
            default_value: None,
            identity: None,
            generated: false,
            comment: None,
        });
    }
    snapshot.canonicalize().unwrap();
    app.store.save_snapshot(&snapshot).await.unwrap();
    input.snapshot_id = snapshot.id;
    let relationship = LogicalRelationship {
        id: Uuid::new_v4(),
        source_id: snapshot.source_id,
        name: "private-link-name".into(),
        source: RelationshipEndpoint::new("public", "orders", vec!["id".into()]),
        target: RelationshipEndpoint::new("public", "private_unrelated", vec!["id".into()]),
        cardinality: RelationshipCardinality::ManyToOne,
        status: LogicalRelationshipStatus::Active,
        origin: LogicalRelationshipOrigin::ConfirmedInference,
        note: None,
        evidence: vec![],
        created_at: snapshot.captured_at,
        updated_at: snapshot.captured_at,
    };
    app.store
        .save_logical_relationship(&relationship)
        .await
        .unwrap();
    (app, input, settings, relationship)
}

#[tokio::test]
async fn stale_active_logical_edges_cannot_expand_preview_or_wire_scope() {
    for scope in [AiContextScope::OneHop, AiContextScope::Domain] {
        let (endpoint, received, respond, server) = server().await;
        let (app, mut input, mut settings, relationship) = logical_fixture(&endpoint).await;
        // The edge was valid in the previous snapshot and persisted as Active.
        let previous = task(prepare(&app, input.clone()).await.unwrap());
        assert_eq!(previous.prepared.preview.context.tables.len(), 2);
        let mut snapshot = app
            .store
            .get_snapshot(input.snapshot_id)
            .await
            .unwrap()
            .unwrap();
        snapshot.id = Uuid::new_v4();
        snapshot.captured_at += chrono::Duration::seconds(1);
        let mut neighbor = snapshot.schemas[0].tables[0].clone();
        neighbor.key = ObjectKey::table("public", "valid_neighbor");
        snapshot.schemas[0].tables.push(neighbor);
        let stale_target = snapshot.schemas[0]
            .tables
            .iter_mut()
            .find(|t| t.key.name == "private_unrelated")
            .unwrap();
        stale_target.columns[0].type_name = "text".into();
        stale_target.columns[0].formatted_type = "text".into();
        snapshot.canonicalize().unwrap();
        app.store.save_snapshot(&snapshot).await.unwrap();
        assert!(
            validate_current(&app, &previous)
                .await
                .unwrap_err()
                .contains("latest")
        );
        input.snapshot_id = snapshot.id;
        let mut valid = relationship.clone();
        valid.id = Uuid::new_v4();
        valid.target.table = "valid_neighbor".into();
        app.store.save_logical_relationship(&valid).await.unwrap();
        settings.ai.context_scope = scope;
        app.store
            .save_data_source_settings(&settings)
            .await
            .unwrap();
        if scope == AiContextScope::Domain {
            let domain = semantic_model::DomainGroup {
                id: Uuid::new_v4(),
                source_id: snapshot.source_id,
                name: "All three".into(),
                description: None,
                color: "blue".into(),
                table_keys: snapshot.schemas[0]
                    .tables
                    .iter()
                    .map(|t| t.key.clone())
                    .collect(),
                updated_at: snapshot.captured_at,
            };
            app.store.save_domain_group(&domain).await.unwrap();
            input.domain_id = Some(domain.id);
        }
        // No get_semantics/list UI call: AI must validate this exact snapshot itself.
        let task = task(prepare(&app, input).await.unwrap());
        let preview = task.prepared.preview.clone();
        assert_eq!(
            preview.context.tables,
            [
                ObjectKey::table("public", "orders"),
                ObjectKey::table("public", "valid_neighbor")
            ]
        );
        assert_eq!(
            preview
                .context
                .evidence
                .iter()
                .filter(|e| e.kind == "logicalRelationship")
                .count(),
            1
        );
        let persisted = app
            .store
            .list_logical_relationships(snapshot.source_id)
            .await
            .unwrap();
        assert_eq!(
            persisted
                .iter()
                .find(|r| r.id == relationship.id)
                .unwrap()
                .status,
            LogicalRelationshipStatus::Active
        );
        let running = tokio::spawn(async move { execute(&app, &task, Some("fixture-key")).await });
        let wire = received.await.unwrap();
        assert_eq!(wire, preview.request_body);
        assert!(!wire.to_string().contains("private_unrelated"));
        assert!(!wire.to_string().contains("private-link-name"));
        assert!(wire.to_string().contains("valid_neighbor"));
        respond.send((200, answer())).unwrap();
        running.await.unwrap().unwrap();
        server.await.unwrap();
    }
}

#[tokio::test]
async fn relationship_change_rejects_late_answers_and_prevents_retries() {
    for status in [200, 500] {
        let (endpoint, received, respond, server) = server().await;
        let (app, input, _, mut relationship) = logical_fixture(&endpoint).await;
        let task = task(prepare(&app, input).await.unwrap());
        let runner_app = app.clone();
        let running =
            tokio::spawn(async move { execute(&runner_app, &task, Some("fixture-key")).await });
        received.await.unwrap();
        relationship.status = LogicalRelationshipStatus::Disabled;
        app.store
            .save_logical_relationship(&relationship)
            .await
            .unwrap();
        respond.send((status, answer())).unwrap();
        assert!(running.await.unwrap().err().unwrap().contains("changed"));
        assert_eq!(app.ai_limiter.available_permits(), 840);
        server.await.unwrap();
    }
}

#[tokio::test]
async fn absolute_deadline_is_serialized_but_does_not_change_request_identity() {
    let (app, input, _) = fixture("http://localhost:9").await;
    let before = chrono::Utc::now();
    let prepared = prepare(&app, input).await.unwrap();
    let expires_at = chrono::DateTime::parse_from_rfc3339(&prepared.preview.expires_at).unwrap();
    assert!(expires_at >= before + chrono::Duration::minutes(5));
    assert!(expires_at <= chrono::Utc::now() + chrono::Duration::minutes(5));
    let json = serde_json::to_value(&prepared.preview).unwrap();
    assert_eq!(json["expiresAt"], prepared.preview.expires_at);
    assert!(json.get("expiresInSeconds").is_none());
    validate_current(&app, &task(prepared)).await.unwrap();
}

#[tokio::test]
async fn prepared_response_is_stale_when_endpoint_changes_even_with_identical_snapshot() {
    let (app, input, _) = fixture("https://example.invalid/v1").await;
    let prepared = prepare(&app, input.clone()).await.unwrap();
    let source = prepared.preview.source_id;
    let profile = schema_model::DataSourceProfile {
        id: source,
        display_name: "Same model, different endpoint".into(),
        host: "replacement.example".into(),
        port: 5432,
        database: "private-database-name".into(),
        username: "reader".into(),
        database_type: DatabaseType::PostgreSql,
        ssl_mode: schema_model::SslMode::Prefer,
        security: schema_model::ConnectionSecurity::default(),
        created_at: chrono::Utc::now(),
        updated_at: chrono::Utc::now(),
    };
    app.store.save_data_source(&profile).await.unwrap();
    assert!(validate_current(&app, &task(prepared)).await.is_err());
    let fresh = prepare(&app, input).await.unwrap();
    let mut rename = profile;
    rename.display_name = "Only a label change".into();
    rename.updated_at = chrono::Utc::now();
    app.store.save_data_source(&rename).await.unwrap();
    validate_current(&app, &task(fresh)).await.unwrap();
}
