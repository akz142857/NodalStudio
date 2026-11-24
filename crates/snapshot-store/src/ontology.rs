use chrono::Utc;
use schema_model::{DataSourceProfile, DatabaseSnapshot};
use semantic_model::knowledge::{digest, source_identity};
use semantic_model::ontology::{
    ConfirmedDefinition, OntologyQueryDraft, PaidOrdersDefinition, PaidOrdersSample,
};
use serde::Deserialize;
use sqlx::{Sqlite, Transaction};
use uuid::Uuid;

use crate::{LocalSnapshotStore, SnapshotStoreError, knowledge};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OntologyScope {
    pub source_id: Uuid,
    pub snapshot_id: Uuid,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefinitionRevision {
    pub id: Uuid,
    pub revision: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmOntologyInput {
    pub scope: OntologyScope,
    pub target: Option<DefinitionRevision>,
    pub definition: PaidOrdersDefinition,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftOntologyInput {
    pub scope: OntologyScope,
    pub target: DefinitionRevision,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveOntologySampleInput {
    pub scope: OntologyScope,
    pub target: DefinitionRevision,
    pub sample: PaidOrdersSample,
}

impl LocalSnapshotStore {
    /// Reads the source's confirmed definitions and current binding impacts.
    ///
    /// # Errors
    /// Returns an error if the snapshot is stale or storage is unavailable.
    pub async fn list_ontology(
        &self,
        scope: &OntologyScope,
    ) -> Result<Vec<ConfirmedDefinition>, SnapshotStoreError> {
        let mut tx = self.pool.begin().await?;
        let snapshot = current_snapshot(&mut tx, scope).await?;
        let mut entries = load_definitions(&mut tx, scope.source_id).await?;
        for entry in &mut entries {
            let current = entry.current_impacts(&snapshot);
            if !current.is_empty() {
                entry.impacts = current;
            }
        }
        tx.commit().await?;
        Ok(entries)
    }

    /// Confirms a definition against the current schema and its expected revision.
    ///
    /// # Errors
    /// Returns an error if the snapshot, revision, or field mappings are invalid.
    pub async fn confirm_ontology(
        &self,
        input: ConfirmOntologyInput,
    ) -> Result<ConfirmedDefinition, SnapshotStoreError> {
        let mut tx = self.pool.begin().await?;
        let snapshot = current_snapshot(&mut tx, &input.scope).await?;
        ensure_captured_connection(&mut tx, &snapshot, false).await?;
        let previous = if let Some(target) = input.target {
            let previous = load_revision(&mut tx, input.scope.source_id, &target).await?;
            if requires_review(&previous, &snapshot) {
                return Err(conflict(
                    "Verify the approved order sample in Change Review to confirm a new binding.",
                ));
            }
            Some(previous)
        } else {
            None
        };
        let mut confirmed = prepare_confirmation(&snapshot, input.definition, previous.as_ref())?;
        if let Some(previous) = previous
            && !confirmed
                .definition
                .same_order_selection(&previous.definition)
        {
            confirmed.sample = None;
        }
        write_definition(&mut tx, input.scope.source_id, &confirmed).await?;
        tx.commit().await?;
        Ok(confirmed)
    }

    /// Stores the approved sample for an exact definition revision.
    /// # Errors
    /// Rejects an invalid sample or replacement of the approved sample during a review.
    pub async fn save_ontology_sample(
        &self,
        mut input: SaveOntologySampleInput,
    ) -> Result<ConfirmedDefinition, SnapshotStoreError> {
        input.sample.validate().map_err(conflict)?;
        let mut tx = self.pool.begin().await?;
        let snapshot = current_snapshot(&mut tx, &input.scope).await?;
        let mut entry = load_revision(&mut tx, input.scope.source_id, &input.target).await?;
        let current = entry.current_impacts(&snapshot);
        if !current.is_empty() {
            entry.impacts = current;
        }
        if entry.sample.is_some() && (entry.source_change_id.is_some() || !entry.impacts.is_empty())
        {
            return Err(conflict(
                "The approved order sample is fixed during this review.",
            ));
        }
        entry.sample = Some(input.sample);
        write_definition(&mut tx, input.scope.source_id, &entry).await?;
        tx.commit().await?;
        Ok(entry)
    }

    /// Generates a draft against the latest snapshot and exact confirmed revision.
    ///
    /// # Errors
    /// Returns an error when the definition or the schema requires review.
    pub async fn draft_ontology_last_month(
        &self,
        input: &DraftOntologyInput,
    ) -> Result<OntologyQueryDraft, SnapshotStoreError> {
        let mut tx = self.pool.begin().await?;
        let snapshot = current_snapshot(&mut tx, &input.scope).await?;
        let entry = load_revision(&mut tx, input.scope.source_id, &input.target).await?;
        ensure_captured_connection(&mut tx, &snapshot, false).await?;
        let draft = entry
            .last_month_draft(&snapshot, Utc::now())
            .map_err(conflict)?;
        tx.commit().await?;
        Ok(draft)
    }
}

pub(super) async fn initialize(pool: &sqlx::SqlitePool) -> Result<(), SnapshotStoreError> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS ontology_definitions (
             source_id TEXT NOT NULL,
             id TEXT NOT NULL,
             payload_json TEXT NOT NULL,
             PRIMARY KEY (source_id, id)
         )",
    )
    .execute(pool)
    .await?;
    Ok(())
}

pub(super) fn connection_identity(profile: Option<&DataSourceProfile>) -> String {
    let direct = source_identity(profile);
    if let Some(ssh) = profile.and_then(|profile| profile.security.ssh.as_ref()) {
        return digest(&(direct, &ssh.host, ssh.port, &ssh.username));
    }
    direct
}

pub(super) async fn connection_identity_in(
    tx: &mut Transaction<'_, Sqlite>,
    source: Uuid,
) -> Result<String, SnapshotStoreError> {
    Ok(connection_identity(
        knowledge::profile_in(tx, source).await?.as_ref(),
    ))
}

pub(super) async fn record_source_change(
    tx: &mut Transaction<'_, Sqlite>,
    source: Uuid,
) -> Result<(), SnapshotStoreError> {
    let changed = sqlx::query(
        "UPDATE ontology_definitions SET payload_json = json_set(payload_json, '$.sourceChangeId', ?) WHERE source_id = ?",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(source.to_string())
    .execute(&mut **tx)
    .await?;
    if changed.rows_affected() > 0 {
        sqlx::query(
            "UPDATE change_review_receipts SET payload_json = json_set(payload_json, '$.status', 'stale') WHERE source_id = ?",
        )
        .bind(source.to_string())
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

pub(super) async fn ensure_captured_connection(
    tx: &mut Transaction<'_, Sqlite>,
    snapshot: &DatabaseSnapshot,
    require_receipt: bool,
) -> Result<(), SnapshotStoreError> {
    let receipt: Option<String> =
        sqlx::query_scalar("SELECT payload_json FROM change_review_receipts WHERE source_id = ?")
            .bind(snapshot.source_id.to_string())
            .fetch_optional(&mut **tx)
            .await?;
    if receipt.is_none() && !require_receipt {
        return Ok(());
    }
    let receipt: serde_json::Value = serde_json::from_str(receipt.as_deref().unwrap_or("null"))?;
    let profile = knowledge::profile_in(tx, snapshot.source_id).await?;
    let identity = source_identity(profile.as_ref());
    if receipt["status"] != "success"
        || receipt["snapshotId"].as_str() != Some(snapshot.id.to_string().as_str())
        || receipt["identity"].as_str() != Some(identity.as_str())
        || receipt["ontologyIdentity"]
            .as_str()
            .is_some_and(|saved| saved != connection_identity(profile.as_ref()))
    {
        return Err(conflict(
            "Refresh the schema for the current connection before continuing.",
        ));
    }
    Ok(())
}

pub(super) async fn record_impacts(
    tx: &mut Transaction<'_, Sqlite>,
    snapshot: &DatabaseSnapshot,
) -> Result<(), SnapshotStoreError> {
    let latest = sqlx::query_scalar::<_, String>(
        "SELECT id FROM schema_snapshots WHERE source_id = ? ORDER BY captured_at DESC LIMIT 1",
    )
    .bind(snapshot.source_id.to_string())
    .fetch_optional(&mut **tx)
    .await?;
    if latest.as_deref() != Some(&snapshot.id.to_string()) {
        return Ok(());
    }
    for mut entry in load_definitions(tx, snapshot.source_id).await? {
        let current = entry.current_impacts(snapshot);
        if !current.is_empty() && current != entry.impacts {
            entry.impacts = current;
            write_definition(tx, snapshot.source_id, &entry).await?;
        }
    }
    Ok(())
}

async fn current_snapshot(
    tx: &mut Transaction<'_, Sqlite>,
    scope: &OntologyScope,
) -> Result<DatabaseSnapshot, SnapshotStoreError> {
    let snapshot = knowledge::snapshot_in(tx, scope.source_id)
        .await?
        .ok_or_else(|| conflict("Capture a schema snapshot first."))?;
    if snapshot.id != scope.snapshot_id || snapshot.source_id != scope.source_id {
        return Err(conflict(
            "The schema snapshot changed. Open the latest model and try again.",
        ));
    }
    Ok(snapshot)
}

pub(super) async fn load_definitions(
    tx: &mut Transaction<'_, Sqlite>,
    source_id: Uuid,
) -> Result<Vec<ConfirmedDefinition>, SnapshotStoreError> {
    let rows = sqlx::query_scalar::<_, String>(
        "SELECT payload_json FROM ontology_definitions WHERE source_id = ? ORDER BY id",
    )
    .bind(source_id.to_string())
    .fetch_all(&mut **tx)
    .await?;
    let mut definitions = rows
        .iter()
        .map(|row| serde_json::from_str::<ConfirmedDefinition>(row))
        .collect::<Result<Vec<_>, _>>()?;
    definitions.sort_by(|left, right| left.definition.name.cmp(&right.definition.name));
    Ok(definitions)
}

pub(super) async fn load_revision(
    tx: &mut Transaction<'_, Sqlite>,
    source_id: Uuid,
    expected: &DefinitionRevision,
) -> Result<ConfirmedDefinition, SnapshotStoreError> {
    let row = sqlx::query_scalar::<_, String>(
        "SELECT payload_json FROM ontology_definitions WHERE source_id = ? AND id = ?",
    )
    .bind(source_id.to_string())
    .bind(expected.id.to_string())
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| conflict("This definition is unavailable in the current source."))?;
    let entry: ConfirmedDefinition = serde_json::from_str(&row)?;
    if entry.revision != expected.revision {
        return Err(conflict(
            "The definition changed. Open its latest revision and try again.",
        ));
    }
    Ok(entry)
}

pub(super) async fn write_definition(
    tx: &mut Transaction<'_, Sqlite>,
    source_id: Uuid,
    confirmed: &ConfirmedDefinition,
) -> Result<(), SnapshotStoreError> {
    sqlx::query(
        "INSERT INTO ontology_definitions (source_id, id, payload_json) VALUES (?, ?, ?)
         ON CONFLICT (source_id, id) DO UPDATE SET payload_json = excluded.payload_json",
    )
    .bind(source_id.to_string())
    .bind(confirmed.id.to_string())
    .bind(serde_json::to_string(confirmed)?)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

fn conflict(message: &str) -> SnapshotStoreError {
    SnapshotStoreError::OntologyConflict(message.to_owned())
}

pub(super) fn prepare_confirmation(
    snapshot: &DatabaseSnapshot,
    mut definition: PaidOrdersDefinition,
    previous: Option<&ConfirmedDefinition>,
) -> Result<ConfirmedDefinition, SnapshotStoreError> {
    definition.name = String::from(definition.name.trim());
    definition.order.name = String::from(definition.order.name.trim());
    definition.payment.name = String::from(definition.payment.name.trim());
    let evidence = definition.confirm(snapshot).map_err(conflict)?;
    let (id, revision, sample) = if let Some(previous) = previous {
        let revision = previous
            .revision
            .checked_add(1)
            .ok_or_else(|| conflict("This definition has reached its revision limit."))?;
        (previous.id, revision, previous.sample.clone())
    } else {
        (Uuid::new_v4(), 1, None)
    };
    Ok(ConfirmedDefinition {
        id,
        revision,
        confirmed_snapshot_id: snapshot.id,
        database_type: snapshot.database.database_type,
        definition,
        evidence,
        impacts: Vec::new(),
        source_change_id: None,
        sample,
    })
}

fn requires_review(entry: &ConfirmedDefinition, snapshot: &DatabaseSnapshot) -> bool {
    entry.source_change_id.is_some()
        || !entry.impacts.is_empty()
        || !entry.current_impacts(snapshot).is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;
    use schema_model::DatabaseType;
    use schema_model::{
        ColumnDefinition, DatabaseInfo, ObjectKey, PrimaryKeyDefinition, SchemaDefinition,
        TableDefinition,
    };
    use semantic_model::ontology::{
        BindingRole, BusinessTimeZone, ImpactReason, OrderObject, PaymentObject,
    };

    fn column(name: &str, type_name: &str) -> ColumnDefinition {
        ColumnDefinition {
            name: name.into(),
            ordinal_position: 1,
            formatted_type: type_name.into(),
            type_schema: "pg_catalog".into(),
            type_name: type_name.into(),
            nullable: false,
            default_value: None,
            identity: None,
            generated: false,
            comment: None,
        }
    }

    fn snapshot(source_id: Uuid) -> DatabaseSnapshot {
        let mut orders = TableDefinition::empty("sales", "orders");
        orders.columns = vec![column("id", "int8"), column("notes", "text")];
        orders.primary_key = Some(PrimaryKeyDefinition {
            name: "orders_pkey".into(),
            columns: vec!["id".into()],
        });
        let mut payments = TableDefinition::empty("sales", "payments");
        payments.columns = vec![
            column("order_id", "int8"),
            column("status", "text"),
            column("paid_at", "timestamptz"),
        ];
        let mut sales = SchemaDefinition::empty("sales");
        sales.tables = vec![orders, payments];
        let mut snapshot = DatabaseSnapshot::new(
            source_id,
            DatabaseInfo {
                name: "ontology_fixture".into(),
                database_type: DatabaseType::PostgreSql,
                version: "17".into(),
            },
            vec![sales],
        );
        snapshot.canonicalize().unwrap();
        snapshot
    }

    fn definition() -> PaidOrdersDefinition {
        PaidOrdersDefinition {
            name: "Paid orders".into(),
            order: OrderObject {
                name: "Order".into(),
                table: ObjectKey::table("sales", "orders"),
                id_column: "id".into(),
            },
            payment: PaymentObject {
                name: "Payment".into(),
                table: ObjectKey::table("sales", "payments"),
                order_id_column: "order_id".into(),
                status_column: "status".into(),
                success_value: "succeeded".into(),
                paid_at_column: "paid_at".into(),
                time_storage: None,
            },
            time_zone: BusinessTimeZone::Singapore,
        }
    }

    fn scope(snapshot: &DatabaseSnapshot) -> OntologyScope {
        OntologyScope {
            source_id: snapshot.source_id,
            snapshot_id: snapshot.id,
        }
    }

    fn target(entry: &ConfirmedDefinition) -> DefinitionRevision {
        DefinitionRevision {
            id: entry.id,
            revision: entry.revision,
        }
    }

    fn next_snapshot(
        previous: &DatabaseSnapshot,
        change: impl FnOnce(&mut Vec<TableDefinition>),
    ) -> DatabaseSnapshot {
        let mut snapshot = previous.clone();
        snapshot.id = Uuid::new_v4();
        snapshot.captured_at += chrono::Duration::seconds(1);
        change(&mut snapshot.schemas[0].tables);
        snapshot.canonicalize().unwrap();
        snapshot
    }

    fn rename_payment_time(previous: &DatabaseSnapshot, from: &str, to: &str) -> DatabaseSnapshot {
        next_snapshot(previous, |tables| {
            tables[1]
                .columns
                .iter_mut()
                .find(|field| field.name == from)
                .unwrap()
                .name = to.into();
        })
    }

    #[tokio::test]
    async fn validates_revision_scope_and_blocks_direct_confirmation_during_review() {
        let temp = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
        let initial = snapshot(Uuid::new_v4());
        temp.save_snapshot(&initial).await.unwrap();
        let entry = temp
            .confirm_ontology(ConfirmOntologyInput {
                scope: scope(&initial),
                target: None,
                definition: definition(),
            })
            .await
            .unwrap();

        let sample = PaidOrdersSample {
            month: "2026-10".into(),
            expected_order_ids: vec!["1".into()],
        };
        temp.save_ontology_sample(SaveOntologySampleInput {
            scope: scope(&initial),
            target: target(&entry),
            sample: sample.clone(),
        })
        .await
        .unwrap();
        let unrelated = next_snapshot(&initial, |tables| {
            tables[0].columns.retain(|field| field.name != "notes");
        });
        temp.save_snapshot(&unrelated).await.unwrap();
        assert!(temp.list_ontology(&scope(&initial)).await.is_err());
        assert!(
            temp.draft_ontology_last_month(&DraftOntologyInput {
                scope: scope(&unrelated),
                target: target(&entry),
            })
            .await
            .is_ok()
        );

        let renamed = rename_payment_time(&unrelated, "paid_at", "completed_at");
        temp.save_snapshot(&renamed).await.unwrap();
        let impacted = &temp.list_ontology(&scope(&renamed)).await.unwrap()[0];
        assert_eq!(impacted.impacts.len(), 1);
        assert_eq!(impacted.impacts[0].field.role, BindingRole::PaymentTime);
        assert_eq!(impacted.impacts[0].reason, ImpactReason::MissingColumn);
        assert!(
            temp.draft_ontology_last_month(&DraftOntologyInput {
                scope: scope(&renamed),
                target: target(&entry),
            })
            .await
            .is_err()
        );

        assert!(
            temp.save_ontology_sample(SaveOntologySampleInput {
                scope: scope(&renamed),
                target: target(&entry),
                sample,
            })
            .await
            .is_err()
        );
        let restored = rename_payment_time(&renamed, "completed_at", "paid_at");
        temp.save_snapshot(&restored).await.unwrap();
        assert!(
            !temp.list_ontology(&scope(&restored)).await.unwrap()[0]
                .impacts
                .is_empty()
        );

        let renamed_again = rename_payment_time(&restored, "paid_at", "completed_at");
        temp.save_snapshot(&renamed_again).await.unwrap();
        let mut rebound = definition();
        rebound.payment.paid_at_column = "completed_at".into();
        assert!(
            temp.confirm_ontology(ConfirmOntologyInput {
                scope: scope(&renamed_again),
                target: Some(target(&entry)),
                definition: rebound,
            })
            .await
            .is_err()
        );

        let impact = temp.source_data_impact(initial.source_id).await.unwrap();
        assert_eq!(impact.semantic_records, 1);
        temp.delete_source_data(initial.source_id, false, false, true)
            .await
            .unwrap();
        assert!(
            temp.list_ontology(&scope(&renamed_again))
                .await
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn derives_the_previous_month_at_singapore_midnight_and_escapes_values() {
        let snapshot = snapshot(Uuid::new_v4());
        let mut definition = definition();
        definition.payment.success_value = r"approved'\final".into();
        let entry = ConfirmedDefinition {
            id: Uuid::new_v4(),
            revision: 1,
            confirmed_snapshot_id: snapshot.id,
            database_type: DatabaseType::PostgreSql,
            evidence: definition.confirm(&snapshot).unwrap(),
            definition,
            impacts: Vec::new(),
            source_change_id: None,
            sample: None,
        };
        let now = "2026-10-31T16:00:00Z".parse().unwrap();
        let draft = entry.last_month_draft(&snapshot, now).unwrap();
        assert_eq!(draft.starts_at, "2026-10-01T00:00:00+08:00");
        assert_eq!(draft.ends_before, "2026-11-01T00:00:00+08:00");
        assert!(draft.sql.contains(r"= E'approved''\\final'"));
        assert!(draft.sql.contains("fp.first_paid_at < TIMESTAMPTZ"));
    }

    fn fixture_profile(snapshot: &DatabaseSnapshot) -> DataSourceProfile {
        DataSourceProfile {
            server_source_id: None,
            connection_sync: None,
            id: snapshot.source_id,
            display_name: "Sales".into(),
            database_type: DatabaseType::PostgreSql,
            host: "original.example".into(),
            port: 5432,
            database: snapshot.database.name.clone(),
            username: "reader".into(),
            sqlite: None,
            ssl_mode: schema_model::SslMode::Prefer,
            security: schema_model::ConnectionSecurity::default(),
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    #[tokio::test]
    async fn changed_connection_requires_review_even_with_identical_schema() {
        let store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
        let snapshot = snapshot(Uuid::new_v4());
        let mut profile = fixture_profile(&snapshot);
        store
            .save_verified_source(&profile, &snapshot)
            .await
            .unwrap();
        let original_profile = profile.clone();
        let entry = store
            .confirm_ontology(ConfirmOntologyInput {
                scope: scope(&snapshot),
                target: None,
                definition: definition(),
            })
            .await
            .unwrap();
        let input = || DraftOntologyInput {
            scope: scope(&snapshot),
            target: target(&entry),
        };
        assert!(store.draft_ontology_last_month(&input()).await.is_ok());

        profile.display_name = "Commerce".into();
        store.save_data_source(&profile).await.unwrap();
        assert!(store.draft_ontology_last_month(&input()).await.is_ok());
        profile.host = "different.example".into();
        store.save_data_source(&profile).await.unwrap();
        assert!(store.draft_ontology_last_month(&input()).await.is_err());
        assert!(
            store
                .save_captured_snapshot_for(&original_profile, &snapshot)
                .await
                .is_err()
        );
        assert!(
            store
                .confirm_ontology(ConfirmOntologyInput {
                    scope: scope(&snapshot),
                    target: None,
                    definition: definition(),
                })
                .await
                .is_err()
        );

        let capture = store
            .save_captured_snapshot_for(&profile, &snapshot)
            .await
            .unwrap();
        assert!(!capture.stored);
        let pending = store
            .list_ontology(&scope(&snapshot))
            .await
            .unwrap()
            .remove(0);
        assert!(pending.impacts.is_empty());
        assert!(pending.source_change_id.is_some());
        let review = store.change_review(snapshot.source_id).await.unwrap();
        assert!(
            review
                .items
                .iter()
                .any(|item| item.reason == "ontologySourceChanged")
        );

        store.save_data_source(&original_profile).await.unwrap();
        let returned = store
            .list_ontology(&scope(&snapshot))
            .await
            .unwrap()
            .remove(0);
        assert_ne!(returned.source_change_id, pending.source_change_id);
        assert!(store.draft_ontology_last_month(&input()).await.is_err());

        let mut tunnel = original_profile;
        tunnel.security.ssh = Some(schema_model::SshConfig {
            host: "bastion-a.example".into(),
            port: 22,
            username: "forwarder".into(),
            authentication: schema_model::SshAuthentication::Agent,
            private_key: None,
            known_hosts: None,
        });
        store
            .save_verified_source(&tunnel, &snapshot)
            .await
            .unwrap();
        let old_route = tunnel.clone();
        tunnel.security.ssh.as_mut().unwrap().host = "bastion-b.example".into();
        store.save_data_source(&tunnel).await.unwrap();
        assert!(
            store
                .save_captured_snapshot_for(&old_route, &snapshot)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn editing_the_calculation_clears_a_sample_but_renaming_does_not() {
        let store = LocalSnapshotStore::open("sqlite::memory:").await.unwrap();
        let snapshot = snapshot(Uuid::new_v4());
        store.save_captured_snapshot(&snapshot).await.unwrap();
        let mut definition = definition();
        let entry = store
            .confirm_ontology(ConfirmOntologyInput {
                scope: scope(&snapshot),
                target: None,
                definition: definition.clone(),
            })
            .await
            .unwrap();
        let sample = PaidOrdersSample {
            month: "2026-10".into(),
            expected_order_ids: vec![" 007 ".into()],
        };
        store
            .save_ontology_sample(SaveOntologySampleInput {
                scope: scope(&snapshot),
                target: target(&entry),
                sample: sample.clone(),
            })
            .await
            .unwrap();
        definition.name = "Orders with first payment".into();
        let renamed = store
            .confirm_ontology(ConfirmOntologyInput {
                scope: scope(&snapshot),
                target: Some(target(&entry)),
                definition: definition.clone(),
            })
            .await
            .unwrap();
        assert_eq!(renamed.sample, Some(sample));
        definition.payment.success_value = "captured".into();
        let edited = store
            .confirm_ontology(ConfirmOntologyInput {
                scope: scope(&snapshot),
                target: Some(target(&renamed)),
                definition,
            })
            .await
            .unwrap();
        assert!(edited.sample.is_none());
    }
}
