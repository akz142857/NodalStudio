//! Fixed-month verification for the paid-orders review item.

use chrono::Utc;
use schema_model::{DatabaseSnapshot, DatabaseType};
use semantic_model::{
    knowledge::digest,
    ontology::{MAX_SAMPLE_ORDERS, PaidOrdersDefinition, PaidOrdersSample, valid_sample_order_id},
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{Sqlite, Transaction};
use uuid::Uuid;

use crate::{
    LocalSnapshotStore, knowledge,
    ontology::{self as definitions, DefinitionRevision},
};

use super::{
    Result, ReviewEvent, ReviewItem, ReviewWorkspace, conflict, item, record_event_in, workspace,
};

const CHECK_ACTION: &str = "checkOntology";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VerifyOntologyReviewInput {
    pub source_id: Uuid,
    pub revision: String,
    pub item_key: String,
    pub definition: PaidOrdersDefinition,
    pub basis: String,
}

pub struct PreparedOntologyCheck {
    pub sql: String,
    source_id: Uuid,
    review_revision: String,
    round_id: Uuid,
    item: ReviewItem,
    snapshot_id: Uuid,
    definition: PaidOrdersDefinition,
    sample: PaidOrdersSample,
    basis: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Verification {
    id: Uuid,
    snapshot_id: Uuid,
    checked_at: String,
    definition: PaidOrdersDefinition,
    basis: String,
    month: String,
    expected_order_ids: Vec<String>,
    actual_order_ids: Vec<String>,
    missing_order_ids: Vec<String>,
    unexpected_order_ids: Vec<String>,
    passed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

impl LocalSnapshotStore {
    /// Prepares a read-only sample check against the active round, candidate and approved set.
    /// # Errors
    /// Rejects stale evidence, an unavailable sample or invalid bindings.
    pub async fn prepare_ontology_check(
        &self,
        input: VerifyOntologyReviewInput,
    ) -> Result<PreparedOntologyCheck> {
        let basis = input.basis.trim();
        if basis.is_empty() || basis.chars().count() > 2000 {
            return Err(conflict(
                "Record business confirmation evidence of 1 to 2,000 characters.",
            ));
        }
        let mut tx = self.pool.begin().await?;
        let current = workspace(&mut tx, input.source_id).await?;
        require_current_review(&current, &input.revision)?;
        let round_id = current
            .round_id
            .ok_or_else(|| conflict("Establish a review starting point first."))?;
        let review_item = current
            .items
            .into_iter()
            .find(|i| i.key == input.item_key && i.kind == "ontology")
            .ok_or_else(|| conflict("This ontology review item has changed."))?;
        let snapshot = knowledge::snapshot_in(&mut tx, input.source_id)
            .await?
            .ok_or_else(|| conflict("Capture a schema snapshot first."))?;
        let previous = definitions::load_revision(
            &mut tx,
            input.source_id,
            &definition_revision(&review_item)?,
        )
        .await?;
        definitions::ensure_captured_connection(
            &mut tx,
            &snapshot,
            previous.source_change_id.is_some(),
        )
        .await?;
        let sample = previous
            .sample
            .clone()
            .ok_or_else(|| conflict("Save the approved order sample before verification."))?;
        if input.definition.time_zone != previous.definition.time_zone {
            return Err(conflict(
                "Keep the approved sample's business time zone during rebinding.",
            ));
        }
        let candidate =
            definitions::prepare_confirmation(&snapshot, input.definition, Some(&previous))?;
        let sql = candidate
            .definition
            .sample_sql(&snapshot, &sample)
            .map_err(conflict)?;
        tx.commit().await?;
        Ok(PreparedOntologyCheck {
            sql,
            source_id: input.source_id,
            review_revision: current.revision,
            round_id,
            item: review_item,
            snapshot_id: snapshot.id,
            definition: candidate.definition,
            sample,
            basis: basis.to_owned(),
        })
    }

    /// Records the latest check, including mismatches and incomplete runs.
    /// # Errors
    /// Rejects a changed review revision or storage failure.
    pub async fn record_ontology_check(
        &self,
        mut prepared: PreparedOntologyCheck,
        result: std::result::Result<Vec<String>, String>,
    ) -> Result<ReviewWorkspace> {
        let result = result.and_then(|mut orders| {
            if orders.len() > MAX_SAMPLE_ORDERS {
                return Err("The result exceeds the approved sample limits.".into());
            }
            if orders.iter().any(|id| !valid_sample_order_id(id)) {
                return Err("The result contains an invalid order ID.".into());
            }
            orders.sort_unstable();
            if orders.windows(2).any(|pair| pair[0] == pair[1]) {
                return Err("The result contains duplicate order IDs.".into());
            }
            Ok(orders)
        });
        let mut tx = self.pool.begin().await?;
        let current = workspace(&mut tx, prepared.source_id).await?;
        require_current_review(&current, &prepared.review_revision)?;
        let expected = &prepared.sample.expected_order_ids;
        let (actual, missing, unexpected, error) = match result {
            Ok(actual) => {
                let missing = missing_from(expected, &actual);
                let unexpected = missing_from(&actual, expected);
                (actual, missing, unexpected, None)
            }
            Err(error) => (Vec::new(), Vec::new(), Vec::new(), Some(error)),
        };
        let proof = Verification {
            id: Uuid::new_v4(),
            snapshot_id: prepared.snapshot_id,
            checked_at: Utc::now().to_rfc3339(),
            definition: prepared.definition,
            basis: prepared.basis,
            month: prepared.sample.month,
            expected_order_ids: prepared.sample.expected_order_ids,
            actual_order_ids: actual,
            passed: error.is_none() && missing.is_empty() && unexpected.is_empty(),
            missing_order_ids: missing,
            unexpected_order_ids: unexpected,
            error,
        };
        prepared.item.after["verification"] = serde_json::to_value(&proof)?;
        let event = ReviewEvent {
            round_id: prepared.round_id,
            id: proof.id,
            at: proof.checked_at,
            action: CHECK_ACTION.into(),
            item: Some(prepared.item),
            text: proof.basis,
            items: Vec::new(),
            restorable: false,
        };
        record_event_in(&mut tx, prepared.source_id, &digest(&event), &event).await?;
        let result = workspace(&mut tx, prepared.source_id).await?;
        tx.commit().await?;
        Ok(result)
    }
}

pub(super) async fn project(
    tx: &mut Transaction<'_, Sqlite>,
    snapshot: &DatabaseSnapshot,
) -> Result<Vec<ReviewItem>> {
    let mut items = Vec::new();
    for entry in definitions::load_definitions(tx, snapshot.source_id).await? {
        let current = entry.current_impacts(snapshot);
        let impacts = if current.is_empty() {
            &entry.impacts
        } else {
            &current
        };
        if impacts.is_empty() && entry.source_change_id.is_none() {
            continue;
        }
        let reason = if entry.source_change_id.is_some() {
            "ontologySourceChanged"
        } else {
            "ontologyBindingChanged"
        };
        let mut after = json!({"definitionId": entry.id, "snapshotId": snapshot.id, "impacts": impacts, "sample": entry.sample, "sourceChangeId": entry.source_change_id});
        if snapshot.database.database_type == DatabaseType::Sqlite {
            // SQLite checks from earlier versions could collapse distinct stored keys.
            // Include the new rules in the evidence hash and keep older checks in history.
            after["sampleRulesVersion"] = json!(2);
        }
        items.push(item(
            "ontology", format!("ontology:{}", entry.id), entry.definition.name.clone(),
            None, reason,
            json!({"definition": entry.definition, "revision": entry.revision, "snapshotId": entry.confirmed_snapshot_id}),
            after,
            &["confirmOntology", "defer"],
        ));
    }
    Ok(items)
}

pub(super) fn project_verification(
    item: &mut ReviewItem,
    events: &[ReviewEvent],
    round: Option<Uuid>,
) {
    if item.kind != "ontology" {
        return;
    }
    if let Some(previous) = events.iter().rev().find_map(|event| {
        if event.action != CHECK_ACTION || Some(event.round_id) != round {
            return None;
        }
        event
            .item
            .as_ref()
            .filter(|old| old.key == item.key && old.evidence == item.evidence)
    }) {
        item.after["verification"] = previous.after["verification"].clone();
    }
}

pub(super) async fn close(
    tx: &mut Transaction<'_, Sqlite>,
    snapshot: &DatabaseSnapshot,
    item: &mut ReviewItem,
    proof_id: &str,
) -> Result<String> {
    if item.kind != "ontology" {
        return Err(conflict("Select an ontology review item."));
    }
    let proof: Verification = serde_json::from_value(item.after["verification"].clone())
        .map_err(|_| conflict("Run the approved order sample before closing this item."))?;
    if !proof.passed
        || proof.expected_order_ids != proof.actual_order_ids
        || proof.snapshot_id != snapshot.id
        || Uuid::parse_str(proof_id).ok() != Some(proof.id)
    {
        return Err(conflict(
            "Close this review using a current check with matching order IDs.",
        ));
    }
    let previous =
        definitions::load_revision(tx, snapshot.source_id, &definition_revision(item)?).await?;
    definitions::ensure_captured_connection(tx, snapshot, previous.source_change_id.is_some())
        .await?;
    let confirmed = definitions::prepare_confirmation(snapshot, proof.definition, Some(&previous))?;
    definitions::write_definition(tx, snapshot.source_id, &confirmed).await?;
    item.after["confirmedRevision"] = json!(confirmed.revision);
    item.status = "resolved".into();
    Ok(proof.basis)
}

fn require_current_review(workspace: &ReviewWorkspace, revision: &str) -> Result<()> {
    if workspace.revision != revision {
        return Err(conflict(
            "Review evidence changed. Reload and run the order sample again.",
        ));
    }
    if workspace.identity_changed
        || workspace.completed
        || !workspace.initialized
        || workspace
            .items
            .iter()
            .any(|item| item.reason == "captureFailed")
    {
        return Err(conflict(
            "Refresh the database and open the current review round.",
        ));
    }
    Ok(())
}

pub(super) fn ensure_capture_available(workspace: &ReviewWorkspace) -> Result<()> {
    require_current_review(workspace, &workspace.revision)
}

fn definition_revision(item: &ReviewItem) -> Result<DefinitionRevision> {
    Ok(serde_json::from_value(json!({
        "id": item.after["definitionId"], "revision": item.before["revision"]
    }))?)
}

fn missing_from(expected: &[String], other: &[String]) -> Vec<String> {
    expected
        .iter()
        .filter(|id| other.binary_search(id).is_err())
        .cloned()
        .collect()
}
