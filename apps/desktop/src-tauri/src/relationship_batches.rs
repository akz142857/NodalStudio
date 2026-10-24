use crate::{AppState, SourceInput, safe_store_error};
use serde::Deserialize;
use snapshot_store::{
    SnapshotStoreError,
    relationship_batches::{ApplyReviewBatch, ReviewBatch, ReviewPreview, ReviewRequest},
};
use tauri::State;
use uuid::Uuid;

fn review_error(error: SnapshotStoreError) -> String {
    match error {
        SnapshotStoreError::ReviewConflict(message) => message,
        other => safe_store_error(other),
    }
}
#[tauri::command]
pub async fn preview_relationship_batch(
    input: ReviewRequest,
    state: State<'_, AppState>,
) -> Result<ReviewPreview, String> {
    state
        .store
        .preview_relationship_batch(&input)
        .await
        .map_err(review_error)
}
#[tauri::command]
pub async fn apply_relationship_batch(
    input: ApplyReviewBatch,
    state: State<'_, AppState>,
) -> Result<ReviewBatch, String> {
    state
        .store
        .apply_relationship_batch(&input)
        .await
        .map_err(review_error)
}
#[tauri::command]
pub async fn list_relationship_batches(
    input: SourceInput,
    state: State<'_, AppState>,
) -> Result<Vec<ReviewBatch>, String> {
    state
        .store
        .list_relationship_batches(input.source_id)
        .await
        .map_err(review_error)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoInput {
    source_id: Uuid,
    batch_id: Uuid,
}
#[tauri::command]
pub async fn undo_relationship_batch(
    input: UndoInput,
    state: State<'_, AppState>,
) -> Result<ReviewBatch, String> {
    state
        .store
        .undo_relationship_batch(input.source_id, input.batch_id)
        .await
        .map_err(review_error)
}
