//! Opt-in real inference through an operator-provided loopback evaluation bridge.
//! Uses the actual prepare, HTTP transport and output validation paths; no app settings persist.
use crate::*;
use ai_context::discovery::{DiscoveryTask, Operation, known_relationships};
use schema_model::ObjectKey;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    id: String,
    snapshot_path: String,
    operation: String,
    question: String,
    target: Option<ObjectKey>,
    #[serde(default)]
    candidates: Vec<ObjectKey>,
    #[serde(default)]
    path_tables: Vec<ObjectKey>,
}

#[tokio::test]
#[ignore = "explicit opt-in: uses the operator-authorized real model bridge and private metadata cases"]
async fn live_model_tasks_use_prepared_scope_and_validate_real_answers() {
    let input = std::env::var("NODAL_ACCEPTANCE_MODEL_CASES").expect("set private cases JSON path");
    let output =
        std::env::var("NODAL_ACCEPTANCE_MODEL_OUTPUT").expect("set private report JSON path");
    let endpoint =
        std::env::var("NODAL_ACCEPTANCE_MODEL_ENDPOINT").expect("set local model bridge URL");
    let url = reqwest::Url::parse(&endpoint).unwrap();
    assert_eq!(url.scheme(), "http");
    assert_eq!(url.host_str(), Some("127.0.0.1"));
    let cases: Vec<Case> = serde_json::from_slice(&fs::read(input).unwrap()).unwrap();
    assert!(!cases.is_empty());
    let mut report = Vec::new();
    let mut failures = 0;
    let send = std::env::var("NODAL_ACCEPTANCE_PREVIEW_ONLY").as_deref() != Ok("1");
    for case in cases {
        let started = std::time::Instant::now();
        let result = run_case(&case, &endpoint, send).await;
        let elapsed = started.elapsed().as_millis();
        let entry = match result {
            Ok((preview, answer)) => {
                serde_json::json!({"id":case.id,"operation":case.operation,"question":case.question,
                "accepted":send,"prepared":true,"milliseconds":elapsed,"preview":preview,"result":answer,"businessReview":"pending"})
            }
            Err(error) => {
                failures += 1;
                serde_json::json!({"id":case.id,"operation":case.operation,"question":case.question,
                    "accepted":false,"milliseconds":elapsed,"error":error})
            }
        };
        println!(
            "LIVE_MODEL_CASE {}: accepted={}, milliseconds={elapsed}",
            case.id, entry["accepted"]
        );
        report.push(entry);
        fs::write(&output, serde_json::to_vec_pretty(&report).unwrap()).unwrap();
    }
    assert_eq!(
        failures, 0,
        "real model failures are recorded, never replaced by fixture responses"
    );
}

#[allow(clippy::too_many_lines)]
async fn run_case(
    case: &Case,
    endpoint: &str,
    send: bool,
) -> Result<(serde_json::Value, serde_json::Value), String> {
    let snapshot: DatabaseSnapshot =
        serde_json::from_slice(&fs::read(&case.snapshot_path).unwrap()).unwrap();
    let store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
    store.save_captured_snapshot(&snapshot).await.unwrap();
    let mut settings = DataSourceSettings::defaults_for(snapshot.source_id);
    settings.ai.enabled = true;
    settings.ai.provider = AiProviderKind::OpenAiCompatible;
    // Optional provider identity exercises real request adaptation before routing
    // the unchanged payload through the operator-controlled loopback bridge.
    settings.ai.endpoint =
        std::env::var("NODAL_ACCEPTANCE_PROVIDER_ENDPOINT").unwrap_or_else(|_| endpoint.into());
    settings.ai.model = std::env::var("NODAL_ACCEPTANCE_MODEL_NAME")
        .unwrap_or_else(|_| "codex-cli-evaluation".into());
    settings.ai.timeout_seconds = 180;
    settings.ai.max_retries = 0;
    settings.ai.context_scope = settings_model::AiContextScope::CurrentTable;
    settings.ai.include_comments = true;
    settings.ai.include_confirmed_semantics = false;
    let domain_id = if matches!(case.operation.as_str(), "rank" | "path") {
        settings.ai.context_scope = settings_model::AiContextScope::Domain;
        let domain = DomainGroup {
            id: Uuid::new_v4(),
            source_id: snapshot.source_id,
            name: "Explicit evaluation scope".into(),
            description: None,
            color: "blue".into(),
            table_keys: if case.operation == "path" {
                case.path_tables.clone()
            } else {
                case.candidates.clone()
            },
            updated_at: Utc::now(),
        };
        store.save_domain_group(&domain).await.unwrap();
        Some(domain.id)
    } else {
        None
    };
    store.save_data_source_settings(&settings).await.unwrap();
    let app = AppState {
        store,
        ai_limiter: Arc::new(Semaphore::new(840)),
        snapshot_captures: Arc::default(),
        cloud_operations: Arc::default(),
        active_queries: Arc::default(),
    };
    if case.operation == "table" {
        return table_understanding::run_live_acceptance(
            &app,
            table_understanding::TableInput {
                snapshot_id: snapshot.id,
                target: case.target.clone().expect("table target"),
                focus_column: None,
                domain_id,
                question: case.question.clone(),
            },
            send,
            endpoint,
        )
        .await;
    }
    let operation = match case.operation.as_str() {
        "expand" => Operation::Expand,
        "rank" => Operation::Rank,
        "path" => Operation::Path,
        _ => return Err("unknown acceptance operation".into()),
    };
    let relations = known_relationships(&snapshot, &[]);
    let path_relationships = case
        .path_tables
        .windows(2)
        .map(|pair| {
            relations
                .iter()
                .find(|r| {
                    (r.source == pair[0] && r.target == pair[1])
                        || (r.source == pair[1] && r.target == pair[0])
                })
                .expect("evaluation path must exist in captured metadata")
                .id
                .clone()
        })
        .collect();
    discovery::run_live_acceptance(
        &app,
        discovery::DiscoveryInput {
            snapshot_id: snapshot.id,
            domain_id,
            task: DiscoveryTask {
                operation,
                question: case.question.clone(),
                root: case.target.clone(),
                candidates: case.candidates.clone(),
                path_tables: case.path_tables.clone(),
                path_relationships,
            },
        },
        send,
        endpoint,
    )
    .await
}
