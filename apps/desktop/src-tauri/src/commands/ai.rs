//! AI explanation and provider-check commands.

#[allow(clippy::wildcard_imports)]
use crate::*;

#[tauri::command]
pub(crate) async fn explain_schema(
    input: ExplainSchemaInput,
    state: State<'_, AppState>,
) -> Result<Explanation, String> {
    if input.target_type == "table" {
        return Err(
            "Use the prepared table explanation flow to preview and enforce the AI sending scope."
                .into(),
        );
    }
    if !input.ai_enabled {
        return Err(
            "AI explanations are disabled. Enable offline AI explicitly to continue.".into(),
        );
    }
    let snapshot = state
        .store
        .get_snapshot(input.snapshot_id)
        .await
        .map_err(safe_store_error)?
        .ok_or_else(|| "The selected snapshot no longer exists.".to_owned())?;
    let effective = effective_settings(&state.store, Some(snapshot.source_id)).await?;
    let ai = effective
        .source
        .as_ref()
        .map(|settings| &settings.ai)
        .ok_or_else(|| "AI settings are unavailable for this data source.".to_owned())?;
    if !ai.enabled {
        return Err("AI explanations are disabled in Settings.".into());
    }
    if effective.app.privacy.offline_mode && ai.provider != AiProviderKind::Offline {
        return Err("Remote AI is blocked by completely offline mode.".into());
    }
    validate_remote_consent(ai, input.remote_consent.as_ref())?;

    let context = legacy_explanation_context(&snapshot, &input, ai.include_comments)?;
    if ai.provider == AiProviderKind::Offline {
        return Ok(OfflineSchemaProvider.explain(&context, input.question.as_deref()));
    }
    state
        .store
        .record_external_access("ai", "attempted")
        .await
        .map_err(safe_store_error)?;
    remote_ai_explanation(
        ai,
        &context,
        input.question.as_deref(),
        snapshot.source_id,
        &state.ai_limiter,
    )
    .await
}

#[tauri::command]
pub(crate) async fn test_ai_provider(
    input: SourceInput,
    state: State<'_, AppState>,
) -> Result<AiProviderTestResult, String> {
    let effective = effective_settings(&state.store, Some(input.source_id)).await?;
    let ai = effective
        .source
        .as_ref()
        .map(|settings| &settings.ai)
        .ok_or_else(|| "AI settings are unavailable for this data source.".to_owned())?;
    if !ai.enabled {
        return Err("Enable AI explanations before testing the provider.".into());
    }
    if ai.provider == AiProviderKind::Offline {
        return Ok(AiProviderTestResult {
            provider: "offline-schema".into(),
            model: None,
            tested_at: Utc::now().to_rfc3339(),
            network_used: false,
        });
    }
    if effective.app.privacy.offline_mode {
        return Err("Remote AI is blocked by completely offline mode.".into());
    }
    state
        .store
        .record_external_access("ai", "attempted")
        .await
        .map_err(safe_store_error)?;
    let context = SchemaContext {
        target: "provider-connectivity-test".into(),
        tables: Vec::new(),
        recent_change: None,
        policy: ContextPolicy {
            relationship_depth: 0,
            credentials_included: false,
            row_data_included: false,
            complete_schema_included: false,
        },
    };
    remote_ai_explanation(
        ai,
        &context,
        Some("Connectivity test only. Reply briefly."),
        input.source_id,
        &state.ai_limiter,
    )
    .await?;
    Ok(AiProviderTestResult {
        provider: "openai-compatible".into(),
        model: Some(ai.model.clone()),
        tested_at: Utc::now().to_rfc3339(),
        network_used: true,
    })
}

pub(crate) async fn remote_ai_explanation(
    settings: &settings_model::AiSettings,
    context: &ai_context::SchemaContext,
    question: Option<&str>,
    source_id: Uuid,
    limiter: &Arc<Semaphore>,
) -> Result<Explanation, String> {
    const AI_PERMITS: u32 = 840;
    if settings.endpoint.trim().is_empty() || settings.model.trim().is_empty() {
        return Err("Remote AI requires an endpoint and model in Settings.".into());
    }
    let key = keyring::Entry::new(AI_KEYRING_SERVICE, &source_id.to_string())
        .map_err(|_| "Unable to access the operating system keychain.".to_owned())?
        .get_password()
        .map_err(|_| "Configure the AI API key in Settings before using remote AI.".to_owned())?;
    let endpoint = remote_chat_endpoint(&settings.endpoint)?;
    let context_json = serde_json::to_string(context)
        .map_err(|_| "Unable to prepare the privacy-bounded AI context.".to_owned())?;
    let user_prompt = format!(
        "Explain this database metadata for an engineer. Distinguish facts from inference. Do not invent business meaning. Optional question: {}\n\nSchema context:\n{}",
        question.unwrap_or("None"),
        context_json
    );
    let body = ai_chat::request_body(
        &endpoint,
        &settings.model,
        "You explain database structure using only supplied metadata. Never claim access to credentials or row data.",
        &user_prompt,
        None,
    );
    let permits = AI_PERMITS / u32::from(settings.max_concurrency.max(1));
    let _permit = Arc::clone(limiter)
        .acquire_many_owned(permits)
        .await
        .map_err(|_| "The AI request limiter is unavailable.".to_owned())?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(u64::from(settings.timeout_seconds)))
        .build()
        .map_err(|_| "Unable to initialize the remote AI client.".to_owned())?;
    let mut response = None;
    for attempt in 0..=settings.max_retries {
        match client
            .post(endpoint.clone())
            .bearer_auth(&key)
            .json(&body)
            .send()
            .await
        {
            Ok(value) if value.status().is_server_error() && attempt < settings.max_retries => {}
            Ok(value) => {
                response = Some(value);
                break;
            }
            Err(_) if attempt < settings.max_retries => {}
            Err(_) => {
                return Err(
                    "Remote AI is unreachable; no schema context was retained by Nodal Studio."
                        .to_owned(),
                );
            }
        }
    }
    let response = response.ok_or_else(|| "Remote AI did not return a response.".to_owned())?;
    if !response.status().is_success() {
        return Err(
            "Remote AI rejected the request. Check the endpoint, model, and API key.".into(),
        );
    }
    let envelope = response
        .json::<serde_json::Value>()
        .await
        .map_err(|_| "Remote AI returned an invalid response.".to_owned())?;
    let generated_text = ai_chat::response_text(&envelope)?.trim().to_owned();
    let mut explanation = OfflineSchemaProvider.explain(context, question);
    explanation.provider = "openai-compatible".into();
    explanation.model = Some(settings.model.clone());
    explanation.generated_at = Some(Utc::now().to_rfc3339());
    explanation.title = format!("{} · AI explanation", context.target);
    explanation.explanation.clone_from(&generated_text);
    explanation.candidate_annotation = Some(generated_text);
    Ok(explanation)
}

pub(crate) fn remote_chat_endpoint(endpoint: &str) -> Result<reqwest::Url, String> {
    let trimmed = endpoint.trim().trim_end_matches('/');
    let url = if trimmed.ends_with("/chat/completions") {
        trimmed.to_owned()
    } else if trimmed.ends_with("/v1") {
        format!("{trimmed}/chat/completions")
    } else {
        format!("{trimmed}/v1/chat/completions")
    };
    let parsed = reqwest::Url::parse(&url)
        .map_err(|_| "Remote AI endpoint must be a valid HTTP or HTTPS URL.".to_owned())?;
    let local_development = matches!(parsed.host_str(), Some("localhost" | "127.0.0.1"));
    if parsed.scheme() != "https" && !(parsed.scheme() == "http" && local_development) {
        return Err("Remote AI endpoint must use HTTPS outside local development.".into());
    }
    Ok(parsed)
}
