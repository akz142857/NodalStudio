//! Current-round review commands operate only on the local store.
use crate::{AppState, safe_store_error};
use snapshot_store::change_review::{ReviewPage, ReviewQuery, ReviewRequest, page_workspace};
use tauri::State;
use uuid::Uuid;

#[tauri::command]
pub async fn get_change_review(
    source_id: Uuid,
    query: Option<ReviewQuery>,
    state: State<'_, AppState>,
) -> Result<ReviewPage, String> {
    crate::validated_logical_relationships(&state.store, source_id).await?;
    let query = query.unwrap_or_default();
    query.validate().map_err(safe_store_error)?;
    let full = state
        .store
        .change_review(source_id)
        .await
        .map_err(safe_store_error)?;
    page_workspace(full, &query).map_err(safe_store_error)
}
#[tauri::command]
pub async fn apply_change_review(
    input: ReviewRequest,
    query: Option<ReviewQuery>,
    state: State<'_, AppState>,
) -> Result<ReviewPage, String> {
    let mut query = query.unwrap_or_default();
    query.cursor = None;
    query.validate().map_err(safe_store_error)?;
    let _operation = crate::acquire_cloud_operation(&state, input.source_id).await?;
    crate::validated_logical_relationships(&state.store, input.source_id).await?;
    let full = state
        .store
        .apply_change_review(&input)
        .await
        .map_err(safe_store_error)?;
    page_workspace(full, &query).map_err(safe_store_error)
}
