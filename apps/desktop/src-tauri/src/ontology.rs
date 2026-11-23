use query_engine::QueryCell;
use semantic_model::ontology::{ConfirmedDefinition, MAX_SAMPLE_ORDERS, OntologyQueryDraft};
use snapshot_store::{
    SnapshotStoreError,
    change_review::{ReviewPage, ReviewQuery, ontology::VerifyOntologyReviewInput, page_workspace},
    ontology::{ConfirmOntologyInput, DraftOntologyInput, OntologyScope, SaveOntologySampleInput},
};
use tauri::State;
use uuid::Uuid;

use crate::{
    AppState, ExecuteReadonlyQueryInput, acquire_cloud_operation, run_readonly_query,
    safe_store_error,
};

#[tauri::command]
pub async fn list_ontology(
    scope: OntologyScope,
    state: State<'_, AppState>,
) -> Result<Vec<ConfirmedDefinition>, String> {
    state
        .store
        .list_ontology(&scope)
        .await
        .map_err(ontology_error)
}

#[tauri::command]
pub async fn confirm_ontology(
    input: ConfirmOntologyInput,
    state: State<'_, AppState>,
) -> Result<ConfirmedDefinition, String> {
    state
        .store
        .confirm_ontology(input)
        .await
        .map_err(ontology_error)
}

#[tauri::command]
pub async fn draft_ontology_last_month(
    input: DraftOntologyInput,
    state: State<'_, AppState>,
) -> Result<OntologyQueryDraft, String> {
    state
        .store
        .draft_ontology_last_month(&input)
        .await
        .map_err(ontology_error)
}

#[tauri::command]
pub async fn save_ontology_sample(
    input: SaveOntologySampleInput,
    state: State<'_, AppState>,
) -> Result<ConfirmedDefinition, String> {
    state
        .store
        .save_ontology_sample(input)
        .await
        .map_err(ontology_error)
}

#[tauri::command]
pub async fn verify_ontology_review(
    input: VerifyOntologyReviewInput,
    query: Option<ReviewQuery>,
    state: State<'_, AppState>,
) -> Result<ReviewPage, String> {
    let mut query = query.unwrap_or_default();
    query.cursor = None;
    query.validate().map_err(ontology_error)?;
    let source_id = input.source_id;
    let _operation = acquire_cloud_operation(&state, source_id).await?;
    let prepared = state
        .store
        .prepare_ontology_check(input)
        .await
        .map_err(ontology_error)?;
    let result = run_readonly_query(
        ExecuteReadonlyQueryInput {
            query_id: Uuid::new_v4(),
            source_id,
            sql: prepared.sql.clone(),
            row_limit: u32::try_from(MAX_SAMPLE_ORDERS)
                .map_err(|_| "Invalid sample size limit.")?,
            timeout_ms: 10_000,
            table_browse: true,
        },
        &state,
        None,
    )
    .await
    .map_err(|error| error.message)
    .and_then(|result| {
        if result.truncated {
            return Err("The result exceeds 200 orders. A complete result is required for sample verification.".into());
        }
        result.rows.into_iter().map(|mut row| match row.pop() {
            Some(QueryCell::Text { value, truncated: false }) if row.is_empty() => Ok(value),
            Some(QueryCell::Null) if row.is_empty() => Err("A successful payment has an invalid order ID or payment time. Check the selected fields and storage format.".into()),
            _ => Err("The sample did not return complete order IDs.".into()),
        }).collect()
    });
    let workspace = state
        .store
        .record_ontology_check(prepared, result)
        .await
        .map_err(ontology_error)?;
    page_workspace(workspace, &query).map_err(ontology_error)
}

pub(super) fn ontology_error(error: SnapshotStoreError) -> String {
    match error {
        SnapshotStoreError::OntologyConflict(message)
        | SnapshotStoreError::ReviewConflict(message) => message,
        other => safe_store_error(other),
    }
}
