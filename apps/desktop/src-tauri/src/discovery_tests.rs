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

async fn fixture(endpoint: &str) -> (AppState, DiscoveryInput, DataSourceSettings) {
    let store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
    let mut snapshot = DatabaseSnapshot::new(
        Uuid::new_v4(),
        DatabaseInfo {
            name: "private-database-name".into(),
            database_type: DatabaseType::PostgreSql,
            version: "17".into(),
        },
        vec![SchemaDefinition {
            name: "public".into(),
            tables: vec![
                TableDefinition::empty("public", "orders"),
                TableDefinition::empty("public", "private_unrelated"),
            ],
            views: vec![],
            enums: vec![],
        }],
    );
    let column = schema_model::ColumnDefinition {
        name: "id".into(),
        ordinal_position: 1,
        formatted_type: "bigint".into(),
        type_schema: "pg_catalog".into(),
        type_name: "int8".into(),
        nullable: false,
        default_value: None,
        identity: None,
        generated: false,
        comment: Some("private-field-comment".into()),
    };
    snapshot.schemas[0]
        .tables
        .insert(1, TableDefinition::empty("public", "customers"));
    for table in &mut snapshot.schemas[0].tables {
        table.columns = vec![column.clone()];
    }
    snapshot.schemas[0].tables[0].foreign_keys = vec![schema_model::ForeignKeyDefinition {
        name: "orders_customer".into(),
        columns: vec!["id".into()],
        referenced_schema: "public".into(),
        referenced_table: "customers".into(),
        referenced_columns: vec!["id".into()],
        on_update: schema_model::ReferentialAction::NoAction,
        on_delete: schema_model::ReferentialAction::NoAction,
        match_type: schema_model::MatchType::Simple,
        deferrable: false,
        initially_deferred: false,
    }];
    let mut second_hop = snapshot.schemas[0].tables[0].foreign_keys[0].clone();
    second_hop.name = "customers_private_unrelated_fk".into();
    second_hop.referenced_table = "private_unrelated".into();
    snapshot.schemas[0].tables[1].foreign_keys = vec![second_hop];
    snapshot.canonicalize().unwrap();
    store.save_snapshot(&snapshot).await.unwrap();
    let mut settings = DataSourceSettings::defaults_for(snapshot.source_id);
    settings.ai.enabled = true;
    settings.ai.include_comments = false;
    settings.ai.provider = AiProviderKind::OpenAiCompatible;
    settings.ai.endpoint = endpoint.into();
    settings.ai.model = "fixture-model".into();
    settings.ai.context_scope = AiContextScope::OneHop;
    store.save_data_source_settings(&settings).await.unwrap();
    let input = DiscoveryInput {
        snapshot_id: snapshot.id,
        domain_id: None,
        task: DiscoveryTask {
            operation: Operation::Rank,
            question: "Find customer orders".into(),
            root: Some(schema_model::ObjectKey::table("public", "orders")),
            candidates: ["orders", "customers", "private_unrelated"]
                .map(|name| schema_model::ObjectKey::table("public", name))
                .to_vec(),
            path_tables: vec![],
            path_relationships: vec![],
        },
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

fn answer(operation: Operation) -> String {
    let content = match operation {
        Operation::DraftSql => {
            serde_json::json!({"sqlDraft":{"sql":"SELECT o.id FROM public.orders AS o JOIN public.customers AS c ON o.id = c.id LIMIT 100", "explanation":"Orders linked to customers", "assumptions":[],"clarification":[]}})
        }
        Operation::Expand => serde_json::json!({"terms":["customer","orders"]}),
        Operation::Rank => {
            serde_json::json!({"rankings":[{"candidateId":"c1","reason":"May contain customer orders","evidenceIds":["e1"]}]})
        }
        Operation::Path => {
            serde_json::json!({"interpretations":[{"text":"A structural reference; execution order remains unknown","evidenceIds":["e1"]}],"readingOrder":["c1","c2"]})
        }
    };
    serde_json::json!({"choices":[{"message":{"content":content.to_string()}}]}).to_string()
}

#[tokio::test]
async fn every_operation_sends_exactly_its_preview_with_no_hidden_context() {
    for operation in [
        Operation::Expand,
        Operation::Rank,
        Operation::Path,
        Operation::DraftSql,
    ] {
        let (endpoint, received, respond, server) = server().await;
        let (app, mut input, _) = fixture(&endpoint).await;
        input.task.operation = operation;
        if operation == Operation::DraftSql {
            input.task.candidates.truncate(2);
        }
        if operation == Operation::Path {
            input.task.path_tables = input.task.candidates[..2].to_vec();
            input.task.path_relationships =
                vec!["physical|[\"public\",\"orders\",\"orders_customer\"]".into()];
        }
        let task = task(prepare(&app, input.clone()).await.unwrap());
        let preview = task.prepared.preview.clone();
        let running = tokio::spawn(async move { execute(&app, &task, Some("fixture-key")).await });
        let wire = received.await.unwrap();
        assert_eq!(wire, preview.request_body);
        for hidden in [
            "fixture-key",
            "private_unrelated",
            "private-database-name",
            "private-field-comment",
        ] {
            assert!(!wire.to_string().contains(hidden), "leaked {hidden}");
        }
        if operation == Operation::Expand {
            assert_eq!(wire["messages"][1]["content"], input.task.question);
            assert_eq!(wire["messages"][0]["content"], discovery::EXPANSION_PROMPT);
            assert_eq!(wire["messages"].as_array().unwrap().len(), 2);
            assert!(preview.context.tables.is_empty() && preview.context.evidence.is_empty());
        } else {
            assert_eq!(preview.context.tables.len(), 2);
        }
        respond.send((200, answer(operation))).unwrap();
        assert_eq!(running.await.unwrap().unwrap().operation, operation);
        server.await.unwrap();
    }
}
#[tokio::test]
async fn deepseek_options_are_part_of_every_discovery_preview() {
    for operation in [
        Operation::Expand,
        Operation::Rank,
        Operation::Path,
        Operation::DraftSql,
    ] {
        let (app, mut input, mut settings) = fixture("https://api.deepseek.com").await;
        settings.ai.model = "deepseek-flash".into();
        app.store
            .save_data_source_settings(&settings)
            .await
            .unwrap();
        input.task.operation = operation;
        if operation == Operation::DraftSql {
            input.task.candidates.truncate(2);
        }
        if operation == Operation::Path {
            input.task.path_tables = input.task.candidates[..2].to_vec();
            input.task.path_relationships =
                vec!["physical|[\"public\",\"orders\",\"orders_customer\"]".into()];
        }
        let prepared = prepare(&app, input).await.unwrap();
        assert_eq!(
            prepared.preview.request_body["thinking"],
            serde_json::json!({"type":"disabled"})
        );
        assert_eq!(prepared.preview.request_body["max_tokens"], 2048);
        if operation == Operation::Expand {
            assert!(prepared.preview.context.evidence.is_empty());
            assert!(prepared.preview.context.tables.is_empty());
        }
    }
}

#[tokio::test]
async fn truncated_discovery_answer_is_not_accepted_or_retried() {
    let (endpoint, received, respond, server) = server().await;
    let (app, input, settings) = fixture(&endpoint).await;
    assert!(settings.ai.max_retries > 0);
    let task = task(prepare(&app, input).await.unwrap());
    let running = tokio::spawn(async move { execute(&app, &task, Some("fixture-key")).await });
    received.await.unwrap();
    let mut truncated: Value = serde_json::from_str(&answer(Operation::Rank)).unwrap();
    truncated["choices"][0]["finish_reason"] = serde_json::json!("length");
    respond.send((200, truncated.to_string())).unwrap();
    assert_eq!(
        running.await.unwrap().err().unwrap(),
        crate::ai_chat::TRUNCATED_OUTPUT
    );
    server.await.unwrap();
}

#[tokio::test]
async fn policy_changes_during_success_or_retry_reject_old_answers_and_release_permits() {
    for status in [200, 500] {
        let (endpoint, received, respond, server) = server().await;
        let (app, input, mut settings) = fixture(&endpoint).await;
        let task = task(prepare(&app, input).await.unwrap());
        let runner = app.clone();
        let running =
            tokio::spawn(async move { execute(&runner, &task, Some("fixture-key")).await });
        received.await.unwrap();
        settings.ai.enabled = false;
        app.store
            .save_data_source_settings(&settings)
            .await
            .unwrap();
        respond.send((status, answer(Operation::Rank))).unwrap();
        assert!(running.await.unwrap().err().unwrap().contains("disabled"));
        assert_eq!(app.ai_limiter.available_permits(), 840);
        server.await.unwrap();
    }
}
#[tokio::test]
async fn cancellation_stops_inflight_request_and_late_response_cannot_be_accepted() {
    let (endpoint, received, respond, server) = server().await;
    let (app, input, _) = fixture(&endpoint).await;
    let task = task(prepare(&app, input).await.unwrap());
    let cancellation = task.cancellation.clone();
    let runner = app.clone();
    let running = tokio::spawn(async move { execute(&runner, &task, Some("fixture-key")).await });
    received.await.unwrap();
    cancellation.cancel();
    assert!(running.await.unwrap().err().unwrap().contains("cancelled"));
    assert_eq!(app.ai_limiter.available_permits(), 840);
    let _ = respond.send((200, answer(Operation::Rank)));
    server.await.unwrap();
}
#[tokio::test]
async fn changed_comments_scope_model_snapshot_and_expiry_require_a_new_preview() {
    let (app, input, mut settings) = fixture("http://127.0.0.1:9").await;
    let prepared = task(prepare(&app, input.clone()).await.unwrap());
    settings.ai.include_comments = true;
    app.store
        .save_data_source_settings(&settings)
        .await
        .unwrap();
    assert!(
        validate_current(&app, &prepared)
            .await
            .unwrap_err()
            .contains("changed")
    );
    let prepared = task(prepare(&app, input.clone()).await.unwrap());
    settings.ai.model = "new-model".into();
    app.store
        .save_data_source_settings(&settings)
        .await
        .unwrap();
    assert!(
        validate_current(&app, &prepared)
            .await
            .unwrap_err()
            .contains("changed")
    );
    let mut prepared = task(prepare(&app, input.clone()).await.unwrap());
    prepared.created = Instant::now().checked_sub(PREVIEW_LIFETIME).unwrap();
    assert!(
        validate_current(&app, &prepared)
            .await
            .unwrap_err()
            .contains("expired")
    );
    settings.ai.context_scope = AiContextScope::CurrentTable;
    app.store
        .save_data_source_settings(&settings)
        .await
        .unwrap();
    assert!(
        prepare(&app, input.clone())
            .await
            .err()
            .unwrap()
            .contains("single-table")
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
async fn domain_wire_filters_candidates_without_root_and_edits_invalidate_followup_steps() {
    let (endpoint, received, respond, server) = server().await;
    let (app, mut input, mut settings) = fixture(&endpoint).await;
    settings.ai.context_scope = AiContextScope::Domain;
    app.store
        .save_data_source_settings(&settings)
        .await
        .unwrap();
    input.task.root = None;
    assert!(
        prepare(&app, input.clone())
            .await
            .err()
            .unwrap()
            .contains("Select one")
    );
    let mut domain = semantic_model::DomainGroup {
        id: Uuid::new_v4(),
        source_id: settings.source_id,
        name: "sensitive-domain-title".into(),
        description: Some("private-domain-description".into()),
        color: "blue".into(),
        table_keys: vec![schema_model::ObjectKey::table("public", "orders")],
        updated_at: chrono::Utc::now(),
    };
    app.store.save_domain_group(&domain).await.unwrap();
    input.domain_id = Some(domain.id);
    let prepared = task(prepare(&app, input.clone()).await.unwrap());
    let preview = prepared.prepared.preview.clone();
    let runner = app.clone();
    let running =
        tokio::spawn(async move { execute(&runner, &prepared, Some("fixture-key")).await });
    let wire = received.await.unwrap();
    assert_eq!(wire, preview.request_body);
    assert_eq!(preview.context.tables, domain.table_keys);
    for hidden in [
        "customers",
        "private_unrelated",
        "private-field-comment",
        "sensitive-domain-title",
        "private-domain-description",
    ] {
        assert!(!wire.to_string().contains(hidden));
    }
    respond.send((200, answer(Operation::Rank))).unwrap();
    running.await.unwrap().unwrap();
    server.await.unwrap();
    let prepared = task(prepare(&app, input).await.unwrap());
    domain.name = "renamed".into();
    app.store.save_domain_group(&domain).await.unwrap();
    assert!(
        validate_current(&app, &prepared)
            .await
            .unwrap_err()
            .contains("changed")
    );
}

#[tokio::test]
async fn two_hop_paths_are_local_only_under_one_hop_and_offline_never_sends() {
    let (app, mut input, mut settings) = fixture("http://127.0.0.1:9").await;
    input.task.operation = Operation::Path;
    input.task.path_tables = input.task.candidates.clone();
    input.task.path_relationships = vec![
        "physical|[\"public\",\"orders\",\"orders_customer\"]".into(),
        "physical|[\"public\",\"customers\",\"customers_private_unrelated_fk\"]".into(),
    ];
    assert!(
        prepare(&app, input.clone())
            .await
            .err()
            .unwrap()
            .contains("complete path")
    );
    input.task.operation = Operation::Expand;
    settings.ai.provider = AiProviderKind::Offline;
    app.store
        .save_data_source_settings(&settings)
        .await
        .unwrap();
    let prepared = task(prepare(&app, input.clone()).await.unwrap());
    assert!(prepared.prepared.preview.request_body.is_null());
    assert!(
        !execute(&app, &prepared, None)
            .await
            .unwrap()
            .answer
            .unknowns
            .is_empty()
    );
    let mut app_settings = app.store.get_app_settings().await.unwrap();
    app_settings.privacy.offline_mode = true;
    app.store.save_app_settings(&app_settings).await.unwrap();
    settings.ai.provider = AiProviderKind::OpenAiCompatible;
    app.store
        .save_data_source_settings(&settings)
        .await
        .unwrap();
    assert!(
        prepare(&app, input)
            .await
            .err()
            .unwrap()
            .contains("offline mode")
    );
}

#[tokio::test]
#[allow(clippy::too_many_lines)]
async fn confirmed_notes_obey_wire_scope_switch_and_invalidate_old_tasks_on_text_change() {
    use semantic_model::knowledge::{KnowledgeBasis, KnowledgeOrigin, annotation_version};
    let (endpoint, received, respond, server) = server().await;
    let (app, input, mut settings) = fixture(&endpoint).await;
    let snapshot = app
        .store
        .get_snapshot(input.snapshot_id)
        .await
        .unwrap()
        .unwrap();
    let annotation = semantic_model::ObjectAnnotation {
        source_id: snapshot.source_id,
        object_key: schema_model::ObjectKey::table("public", "orders"),
        description: Some("CONFIRMED_LOCAL_SENTINEL".into()),
        tags: vec![],
        owner: None,
        is_core: false,
        updated_at: chrono::Utc::now(),
    };
    app.store.save_annotation(&annotation).await.unwrap();
    assert!(
        !prepare(&app, input.clone())
            .await
            .unwrap()
            .preview
            .request_body
            .to_string()
            .contains("CONFIRMED_LOCAL_SENTINEL")
    );
    app.store
        .confirm_knowledge(
            Uuid::new_v4(),
            snapshot.source_id,
            &annotation.object_key,
            &annotation_version(Some(&annotation)),
            &KnowledgeBasis::from_tables(
                &snapshot,
                std::slice::from_ref(&annotation.object_key),
                &[],
            ),
            annotation.description.as_deref().unwrap(),
            &KnowledgeOrigin {
                kind: "manualReview".into(),
                request_id: None,
                provider: None,
                model: None,
                generated_at: None,
                evidence: serde_json::json!({}),
            },
        )
        .await
        .unwrap();
    settings.ai.include_confirmed_semantics = false;
    app.store
        .save_data_source_settings(&settings)
        .await
        .unwrap();
    assert!(
        !prepare(&app, input.clone())
            .await
            .unwrap()
            .preview
            .request_body
            .to_string()
            .contains("CONFIRMED_LOCAL_SENTINEL")
    );
    settings.ai.include_confirmed_semantics = true;
    app.store
        .save_data_source_settings(&settings)
        .await
        .unwrap();
    let running_task = task(prepare(&app, input.clone()).await.unwrap());
    assert!(
        running_task
            .prepared
            .preview
            .context
            .evidence
            .iter()
            .any(|e| e.kind == "teamStatement")
    );
    let runner = app.clone();
    let running =
        tokio::spawn(async move { execute(&runner, &running_task, Some("fixture-key")).await });
    let body = received.await.unwrap();
    assert!(body.to_string().contains("CONFIRMED_LOCAL_SENTINEL"));
    assert!(!body.to_string().contains("private_unrelated"));
    respond.send((200, answer(Operation::Rank))).unwrap();
    running.await.unwrap().unwrap();
    server.await.unwrap();
    let stale = task(prepare(&app, input.clone()).await.unwrap());
    let mut edited = annotation.clone();
    edited.description = Some("Changed unreviewed text".into());
    app.store.save_annotation(&edited).await.unwrap();
    assert!(validate_current(&app, &stale).await.is_err());
    assert!(
        !prepare(&app, input.clone())
            .await
            .unwrap()
            .preview
            .request_body
            .to_string()
            .contains("Changed unreviewed text")
    );
    settings.ai.include_confirmed_semantics = false;
    app.store
        .save_data_source_settings(&settings)
        .await
        .unwrap();
    assert!(
        prepare(&app, input)
            .await
            .unwrap()
            .preview
            .context
            .evidence
            .iter()
            .all(|e| e.kind != "teamStatement")
    );
}

#[tokio::test]
async fn sql_draft_requires_enabled_model_and_exact_scope_before_any_send() {
    let (app, mut input, mut settings) = fixture("http://127.0.0.1:9").await;
    input.task.operation = Operation::DraftSql;
    input.task.candidates.truncate(1);
    settings.ai.context_scope = AiContextScope::CurrentTable;
    app.store
        .save_data_source_settings(&settings)
        .await
        .unwrap();
    let prepared = prepare(&app, input.clone()).await.unwrap();
    assert_eq!(prepared.preview.context.tables, input.task.candidates);
    assert!(
        !prepared
            .preview
            .request_body
            .to_string()
            .contains("private_unrelated")
    );
    assert!(
        !prepared
            .preview
            .request_body
            .to_string()
            .contains("private-field-comment")
    );
    input
        .task
        .candidates
        .push(schema_model::ObjectKey::table("public", "customers"));
    assert!(
        prepare(&app, input.clone())
            .await
            .err()
            .unwrap()
            .contains("scope")
    );
    input.task.candidates.truncate(1);
    settings.ai.provider = AiProviderKind::Offline;
    app.store
        .save_data_source_settings(&settings)
        .await
        .unwrap();
    assert!(
        prepare(&app, input)
            .await
            .err()
            .unwrap()
            .contains("enabled AI model")
    );
}

#[tokio::test]
async fn sql_draft_returns_clarification_and_rejects_unsafe_model_sql() {
    for sql in [
        None,
        Some("DELETE FROM public.orders"),
        Some("SELECT o.secret FROM public.orders o"),
    ] {
        let (endpoint, received, respond, server) = server().await;
        let (app, mut input, _) = fixture(&endpoint).await;
        input.task.operation = Operation::DraftSql;
        input.task.candidates.truncate(1);
        let prepared = task(prepare(&app, input).await.unwrap());
        let running =
            tokio::spawn(async move { execute(&app, &prepared, Some("fixture-key")).await });
        received.await.unwrap();
        let content = serde_json::json!({"sqlDraft":{"sql":sql,"explanation":"Review the business definition","assumptions":[],"clarification":if sql.is_none() { vec!["Which users count as active?"] } else { vec![] }}});
        respond
            .send((
                200,
                serde_json::json!({"choices":[{"message":{"content":content.to_string()}}]})
                    .to_string(),
            ))
            .unwrap();
        let result = running.await.unwrap();
        if sql.is_none() {
            assert!(result.unwrap().answer.sql_draft.unwrap().sql.is_none());
        } else {
            assert!(result.is_err());
        }
        server.await.unwrap();
    }
}
