//! Prepared business discovery requests. Every explicit step has its own immutable preview.

use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use ai_context::{
    discovery::{self, DiscoveryAnswer, DiscoveryContext, DiscoveryTask, Operation},
    understanding::SendScope,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use settings_model::{AiContextScope, AiProviderKind, AiSettings};
use sha2::{Digest, Sha256};
use tauri::State;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{AI_KEYRING_SERVICE, AppState, effective_settings, safe_store_error};

#[cfg(test)]
pub(crate) async fn run_live_acceptance(
    app: &AppState,
    input: DiscoveryInput,
    send: bool,
    transport_endpoint: &str,
) -> Result<(Value, Value), String> {
    let mut prepared = prepare(app, input).await?;
    let preview = serde_json::to_value(&prepared.preview).map_err(|e| e.to_string())?;
    if !send {
        return Ok((preview, Value::Null));
    }
    // Route only the test transport; provider options are already in the preview.
    prepared.preview.endpoint = Some(crate::remote_chat_endpoint(transport_endpoint)?.to_string());
    let task = Task {
        prepared,
        created: Instant::now(),
        cancellation: CancellationToken::new(),
        started: AtomicBool::new(false),
    };
    let result = execute(app, &task, Some("local-acceptance-bridge")).await?;
    Ok((
        preview,
        serde_json::to_value(result).map_err(|e| e.to_string())?,
    ))
}

const PREVIEW_LIFETIME: Duration = Duration::from_mins(5);
const MAX_PREPARED: usize = 16;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiscoveryInput {
    pub snapshot_id: Uuid,
    pub domain_id: Option<Uuid>,
    pub task: DiscoveryTask,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryPreview {
    pub request_id: Uuid,
    pub source_id: Uuid,
    pub snapshot_id: Uuid,
    pub fingerprint: String,
    pub provider: String,
    pub model: Option<String>,
    pub endpoint: Option<String>,
    pub context: DiscoveryContext,
    pub request_body: Value,
    pub expires_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryResult {
    pub request_id: Uuid,
    pub source_id: Uuid,
    pub snapshot_id: Uuid,
    pub operation: Operation,
    pub provider: String,
    pub model: Option<String>,
    pub generated_at: String,
    pub answer: DiscoveryAnswer,
}

struct Prepared {
    input: DiscoveryInput,
    preview: DiscoveryPreview,
    ai: AiSettings,
    signature: String,
}

struct Task {
    prepared: Prepared,
    created: Instant,
    cancellation: CancellationToken,
    started: AtomicBool,
}

#[derive(Default)]
pub struct DiscoveryAiState {
    tasks: Mutex<HashMap<Uuid, Arc<Task>>>,
}

#[tauri::command]
pub async fn prepare_discovery(
    input: DiscoveryInput,
    app: State<'_, AppState>,
    tasks: State<'_, DiscoveryAiState>,
) -> Result<DiscoveryPreview, String> {
    let prepared = prepare(&app, input).await?;
    let preview = prepared.preview.clone();
    let mut map = tasks.tasks.lock().await;
    map.retain(|_, task| {
        if task.created.elapsed() >= PREVIEW_LIFETIME {
            task.cancellation.cancel();
            false
        } else {
            true
        }
    });
    if map.len() >= MAX_PREPARED {
        return Err(
            "Too many AI previews are open. Cancel an earlier request or wait five minutes.".into(),
        );
    }
    map.insert(
        preview.request_id,
        Arc::new(Task {
            prepared,
            created: Instant::now(),
            cancellation: CancellationToken::new(),
            started: AtomicBool::new(false),
        }),
    );
    Ok(preview)
}

#[tauri::command]
pub async fn cancel_discovery(
    request_id: Uuid,
    tasks: State<'_, DiscoveryAiState>,
) -> Result<(), String> {
    if let Some(task) = tasks.tasks.lock().await.remove(&request_id) {
        task.cancellation.cancel();
    }
    Ok(())
}

#[tauri::command]
pub async fn run_discovery(
    request_id: Uuid,
    app: State<'_, AppState>,
    tasks: State<'_, DiscoveryAiState>,
) -> Result<DiscoveryResult, String> {
    let task = tasks
        .tasks
        .lock()
        .await
        .get(&request_id)
        .cloned()
        .ok_or("This preview was cancelled or expired. Prepare a new preview.")?;
    if task.started.swap(true, Ordering::SeqCst) {
        return Err("This request has already started. Prepare a new preview to retry.".into());
    }
    let result = async {
        validate_current(&app, &task).await?;
        let key = if task.prepared.ai.provider == AiProviderKind::Offline {
            None
        } else {
            Some(
                keyring::Entry::new(
                    AI_KEYRING_SERVICE,
                    &task.prepared.preview.source_id.to_string(),
                )
                .map_err(|_| "Unable to access the operating system keychain.")?
                .get_password()
                .map_err(
                    |_| "Configure the AI API key in Settings before running the explanation.",
                )?,
            )
        };
        execute(&app, &task, key.as_deref()).await
    }
    .await;
    tasks.tasks.lock().await.remove(&request_id);
    result
}

#[allow(clippy::too_many_lines)]
async fn prepare(app: &AppState, input: DiscoveryInput) -> Result<Prepared, String> {
    let snapshot = app
        .store
        .get_snapshot(input.snapshot_id)
        .await
        .map_err(safe_store_error)?
        .ok_or("The snapshot no longer exists.")?;
    let latest = app
        .store
        .latest_snapshot(snapshot.source_id)
        .await
        .map_err(safe_store_error)?
        .ok_or("No current snapshot is available.")?;
    if latest.id != snapshot.id {
        return Err("Business discovery requires the latest loaded snapshot. Return to the current model or refresh it.".into());
    }
    let effective = effective_settings(&app.store, Some(snapshot.source_id)).await?;
    let ai = effective
        .source
        .as_ref()
        .ok_or("AI settings are unavailable.")?
        .ai
        .clone();
    if effective.app.privacy.offline_mode && ai.provider != AiProviderKind::Offline {
        return Err("Remote AI is blocked by offline mode.".into());
    }
    if !ai.enabled {
        return Err("AI is disabled by your effective settings or project policy.".into());
    }
    if input.task.operation == Operation::DraftSql && ai.provider == AiProviderKind::Offline {
        return Err("SQL drafting needs an enabled AI model. Configure the existing AI provider in Settings.".into());
    }
    let scope = match ai.context_scope {
        AiContextScope::CurrentTable => SendScope::CurrentTable,
        AiContextScope::OneHop => SendScope::OneHop,
        AiContextScope::Domain => SendScope::Domain,
    };
    let groups = app
        .store
        .list_domain_groups(snapshot.source_id)
        .await
        .map_err(safe_store_error)?;
    let domain = input
        .domain_id
        .and_then(|id| groups.iter().find(|g| g.id == id));
    let logical = app
        .store
        .list_logical_relationships(snapshot.source_id)
        .await
        .map_err(safe_store_error)?;
    let current_logical =
        crate::table_understanding::current_logical_relationships(&snapshot, &logical);
    let mut context = discovery::build_context(
        &snapshot,
        &input.task,
        scope,
        domain,
        &current_logical,
        ai.include_comments,
    )?;
    if ai.include_confirmed_semantics && input.task.operation != Operation::Expand {
        let states = app
            .store
            .knowledge_states(snapshot.source_id)
            .await
            .map_err(safe_store_error)?;
        if ai_context::understanding::append_confirmed_notes(
            &snapshot,
            &context.tables,
            &mut context.evidence,
            &states,
        )? {
            context.coverage.push(
                "Some team statements depend on objects outside this send scope and were omitted."
                    .into(),
            );
        }
        if serde_json::to_vec(&context)
            .map_err(|_| "Unable to serialize context.")?
            .len()
            > ai_context::understanding::MAX_CONTEXT_BYTES
        {
            return Err("Confirmed team statements exceed the context budget.".into());
        }
    }
    let (endpoint, body) = request_body(&ai, &input, &context)?;
    let domain_identity = if scope == SendScope::Domain {
        domain
    } else {
        None
    };
    let profile = app
        .store
        .get_data_source(snapshot.source_id)
        .await
        .map_err(safe_store_error)?;
    let source_identity = semantic_model::knowledge::source_identity(profile.as_ref());
    let signature_bytes = serde_json::to_vec(&(
        source_identity,
        &input,
        &ai,
        &context,
        &body,
        domain_identity,
        &current_logical,
        &snapshot.fingerprint,
        effective.app.privacy.offline_mode,
    ))
    .map_err(|_| "Unable to bind the request to current settings.")?;
    let signature = format!("{:x}", Sha256::digest(signature_bytes));
    Ok(Prepared {
        input,
        ai: ai.clone(),
        signature,
        preview: DiscoveryPreview {
            request_id: Uuid::new_v4(),
            source_id: snapshot.source_id,
            snapshot_id: snapshot.id,
            fingerprint: snapshot.fingerprint,
            provider: if ai.provider == AiProviderKind::Offline {
                "offline-schema"
            } else {
                "openai-compatible"
            }
            .into(),
            model: (ai.provider != AiProviderKind::Offline).then_some(ai.model),
            endpoint,
            context,
            request_body: body,
            expires_at: (chrono::Utc::now() + PREVIEW_LIFETIME).to_rfc3339(),
        },
    })
}

fn request_body(
    ai: &AiSettings,
    input: &DiscoveryInput,
    context: &DiscoveryContext,
) -> Result<(Option<String>, Value), String> {
    let system = match input.task.operation {
        Operation::Expand => discovery::EXPANSION_PROMPT,
        Operation::Rank => discovery::RANK_PROMPT,
        Operation::Path => discovery::PATH_PROMPT,
        Operation::DraftSql => ai_context::sql_draft::PROMPT,
    };
    // Expansion must never serialize context, identifiers, candidates or history.
    let prompt = if input.task.operation == Operation::Expand {
        input.task.question.clone()
    } else {
        format!(
            "Question: {}\n\nPermitted evidence:\n{}",
            input.task.question,
            serde_json::to_string(context).map_err(|_| "Unable to serialize discovery context.")?
        )
    };
    crate::table_understanding::remote_request_body(ai, system, &prompt)
}

async fn validate_current(app: &AppState, task: &Task) -> Result<(), String> {
    if task.cancellation.is_cancelled() {
        return Err("Explanation cancelled.".into());
    }
    if task.created.elapsed() >= PREVIEW_LIFETIME {
        return Err("The request preview expired. Prepare a new preview.".into());
    }
    let current = prepare(app, task.prepared.input.clone()).await?;
    if current.signature != task.prepared.signature {
        return Err("The snapshot, domain or effective AI settings changed. Prepare and review a new request.".into());
    }
    Ok(())
}

async fn execute(
    app: &AppState,
    task: &Task,
    key: Option<&str>,
) -> Result<DiscoveryResult, String> {
    let prepared = &task.prepared;
    let answer = if prepared.ai.provider == AiProviderKind::Offline {
        validate_current(app, task).await?;
        discovery::offline_answer()
    } else {
        let permits = 840 / u32::from(prepared.ai.max_concurrency.max(1));
        let _permit = tokio::select! {
            () = task.cancellation.cancelled() => return Err("Explanation cancelled.".into()),
            permit = Arc::clone(&app.ai_limiter).acquire_many_owned(permits) => permit.map_err(|_| "AI request limiter is unavailable.")?,
        };
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(u64::from(prepared.ai.timeout_seconds)))
            .build()
            .map_err(|_| "Unable to initialize the AI client.")?;
        let mut accepted = None;
        for attempt in 0..=prepared.ai.max_retries {
            validate_current(app, task).await?;
            app.store
                .record_external_access("ai", "attempted")
                .await
                .map_err(safe_store_error)?;
            let response = tokio::select! {
                () = task.cancellation.cancelled() => return Err("Explanation cancelled. A request already sent cannot be recalled.".into()),
                result = crate::table_understanding::send_request(&client, prepared.preview.endpoint.as_deref().ok_or("AI endpoint is unavailable.")?, &prepared.preview.request_body, key.ok_or("AI key is unavailable.")?) => result,
            };
            match response {
                Ok(text) => {
                    accepted = Some(discovery::validate_output(
                        &text,
                        &prepared.preview.context,
                    )?);
                    break;
                }
                Err((message, retryable)) => {
                    if !retryable || attempt == prepared.ai.max_retries {
                        return Err(message);
                    }
                    tokio::select! {
                        () = task.cancellation.cancelled() => return Err("Explanation cancelled.".into()),
                        () = tokio::time::sleep(Duration::from_millis(200)) => {},
                    }
                }
            }
        }
        // A policy/metadata change during the network request invalidates the returned answer too.
        validate_current(app, task).await?;
        accepted.ok_or("The model did not return an explanation.")?
    };
    if let Some(sql) = answer
        .sql_draft
        .as_ref()
        .and_then(|draft| draft.sql.as_deref())
    {
        query_engine::validate_read_only_postgres(sql).map_err(|e| e.to_string())?;
    }
    Ok(DiscoveryResult {
        request_id: prepared.preview.request_id,
        source_id: prepared.preview.source_id,
        snapshot_id: prepared.preview.snapshot_id,
        operation: prepared.input.task.operation,
        provider: prepared.preview.provider.clone(),
        model: prepared.preview.model.clone(),
        generated_at: chrono::Utc::now().to_rfc3339(),
        answer,
    })
}

#[cfg(test)]
#[path = "discovery_tests.rs"]
mod tests;
