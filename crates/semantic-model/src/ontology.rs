//! Confirmed field bindings and the first-paid-order query.

mod dialect;

use chrono::{DateTime, Datelike, FixedOffset, Months, NaiveDate, TimeZone, Utc};
use schema_model::{ColumnDefinition, DatabaseSnapshot, DatabaseType, ObjectKey, TableDefinition};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderObject {
    pub name: String,
    pub table: ObjectKey,
    pub id_column: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaymentObject {
    pub name: String,
    pub table: ObjectKey,
    pub order_id_column: String,
    pub status_column: String,
    pub success_value: String,
    pub paid_at_column: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_storage: Option<PaymentTimeStorage>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PaymentTimeStorage {
    UtcDateTime,
    SingaporeDateTime,
    Iso8601,
    UnixSeconds,
    UnixMilliseconds,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaidOrdersDefinition {
    pub name: String,
    pub order: OrderObject,
    pub payment: PaymentObject,
    pub time_zone: BusinessTimeZone,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BusinessTimeZone {
    #[serde(rename = "UTC")]
    Utc,
    #[serde(rename = "Asia/Singapore")]
    Singapore,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BindingRole {
    OrderId,
    PaymentOrderId,
    PaymentStatus,
    PaymentTime,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldBinding {
    pub role: BindingRole,
    pub table: ObjectKey,
    pub column: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BindingEvidence {
    pub field: FieldBinding,
    pub type_schema: String,
    pub type_name: String,
    pub formatted_type: String,
    pub nullable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order_key_collation: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ImpactReason {
    MissingTable,
    MissingColumn,
    ChangedColumn,
    ChangedOrderKey,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BindingImpact {
    pub field: FieldBinding,
    pub reason: ImpactReason,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmedDefinition {
    pub id: Uuid,
    pub revision: u32,
    pub confirmed_snapshot_id: Uuid,
    #[serde(default)]
    pub database_type: DatabaseType,
    pub definition: PaidOrdersDefinition,
    pub evidence: Vec<BindingEvidence>,
    pub impacts: Vec<BindingImpact>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_change_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sample: Option<PaidOrdersSample>,
}

pub const MAX_SAMPLE_ORDERS: usize = 200;

pub fn valid_sample_order_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && !id.contains('\0')
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaidOrdersSample {
    pub month: String,
    pub expected_order_ids: Vec<String>,
}

impl PaidOrdersSample {
    /// Normalizes the approved order set and verifies that it can be checked completely.
    /// # Errors
    /// Rejects invalid months, empty IDs, or an oversized sample.
    pub fn validate(&mut self) -> Result<(), &'static str> {
        self.start_of_month()?;
        if self.expected_order_ids.len() > MAX_SAMPLE_ORDERS
            || self
                .expected_order_ids
                .iter()
                .any(|id| !valid_sample_order_id(id))
        {
            return Err("Use at most 200 nonempty order IDs of up to 128 bytes.");
        }
        self.expected_order_ids.sort_unstable();
        self.expected_order_ids.dedup();
        Ok(())
    }

    fn start_of_month(&self) -> Result<NaiveDate, &'static str> {
        NaiveDate::parse_from_str(&format!("{}-01", self.month), "%Y-%m-%d")
            .ok()
            .filter(|date| {
                (1..=9999).contains(&date.year()) && date.format("%Y-%m").to_string() == self.month
            })
            .ok_or("Enter a business month in YYYY-MM format.")
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OntologyQueryDraft {
    pub source_id: Uuid,
    pub snapshot_id: Uuid,
    pub definition_name: String,
    pub revision: u32,
    pub time_zone: BusinessTimeZone,
    pub starts_at: String,
    pub ends_before: String,
    pub sql: String,
}

impl PaidOrdersDefinition {
    /// Compares the fields and rules that determine the paid-order set.
    pub fn same_order_selection(&self, other: &Self) -> bool {
        self.fields() == other.fields()
            && self.time_zone == other.time_zone
            && self.payment.success_value == other.payment.success_value
            && self.payment.time_storage == other.payment.time_storage
    }

    fn fields(&self) -> [FieldBinding; 4] {
        let order = &self.order;
        let payment = &self.payment;
        [
            binding(BindingRole::OrderId, &order.table, &order.id_column),
            binding(
                BindingRole::PaymentOrderId,
                &payment.table,
                &payment.order_id_column,
            ),
            binding(
                BindingRole::PaymentStatus,
                &payment.table,
                &payment.status_column,
            ),
            binding(
                BindingRole::PaymentTime,
                &payment.table,
                &payment.paid_at_column,
            ),
        ]
    }

    /// Validates the recipe and captures the exact field types used for confirmation.
    ///
    /// # Errors
    /// Returns guidance if a mapping is missing or the captured types cannot support this recipe.
    pub fn confirm(
        &self,
        snapshot: &DatabaseSnapshot,
    ) -> Result<Vec<BindingEvidence>, &'static str> {
        dialect::validate_engine(&snapshot.database)?;
        if [&self.name, &self.order.name, &self.payment.name]
            .iter()
            .any(|name| name.trim().is_empty() || name.chars().count() > 120)
        {
            return Err("Enter a definition name and object names of 1 to 120 characters.");
        }
        if self.payment.success_value.trim().is_empty()
            || self.payment.success_value.chars().count() > 120
            || self.payment.success_value.contains('\0')
        {
            return Err("Enter a successful payment value of 1 to 120 characters.");
        }
        let fields = self.fields();
        let resolve = |field| {
            resolve_column(snapshot, field).map_err(|reason| match reason {
                ImpactReason::ChangedOrderKey => {
                    "Choose the order table's single-column primary key."
                }
                _ => "Choose a current table and column for every mapping.",
            })
        };
        let [id_field, join_field, status_field, time_field] = &fields;
        let columns = [
            resolve(id_field)?,
            resolve(join_field)?,
            resolve(status_field)?,
            resolve(time_field)?,
        ];
        let [(_, order_id), (_, payment_order_id), (_, status), (_, time)] = columns;
        let database_type = snapshot.database.database_type;
        dialect::validate_key(database_type, order_id, payment_order_id)?;
        dialect::validate_status(database_type, status)?;
        dialect::PaymentTime::resolve(database_type, time, self.payment.time_storage)?;
        Ok(fields
            .into_iter()
            .zip(columns)
            .map(|(field, (table, column))| evidence(database_type, field, table, column))
            .collect())
    }
}

impl ConfirmedDefinition {
    /// Finds changes to the confirmed bindings while allowing unrelated schema changes.
    pub fn current_impacts(&self, snapshot: &DatabaseSnapshot) -> Vec<BindingImpact> {
        self.evidence
            .iter()
            .filter_map(|confirmed| {
                let reason = match resolve_column(snapshot, &confirmed.field) {
                    Ok((table, column))
                        if self.database_type == snapshot.database.database_type
                            && confirmed.type_schema == column.type_schema
                            && confirmed.type_name == column.type_name
                            && confirmed.formatted_type == column.formatted_type
                            && confirmed.nullable == column.nullable =>
                    {
                        let collation = order_key_collation(
                            self.database_type,
                            &confirmed.field,
                            table,
                            column,
                        );
                        if collation.map(str::to_ascii_uppercase) == confirmed.order_key_collation {
                            return None;
                        }
                        ImpactReason::ChangedOrderKey
                    }
                    Ok(_) => ImpactReason::ChangedColumn,
                    Err(reason) => reason,
                };
                Some(BindingImpact {
                    field: confirmed.field.clone(),
                    reason,
                })
            })
            .collect()
    }

    /// Compiles the last full business calendar month against the current snapshot.
    ///
    /// # Errors
    /// Returns guidance if the definition requires review or the time window is invalid.
    pub fn last_month_draft(
        &self,
        snapshot: &DatabaseSnapshot,
        now: DateTime<Utc>,
    ) -> Result<OntologyQueryDraft, &'static str> {
        if snapshot.database.database_type != self.database_type
            || self.source_change_id.is_some()
            || !self.impacts.is_empty()
            || !self.current_impacts(snapshot).is_empty()
        {
            return Err("Review and confirm the ontology definition before generating SQL.");
        }
        dialect::validate_engine(&snapshot.database)?;
        let zone = self.definition.zone()?;
        let month_start = now
            .with_timezone(&zone)
            .date_naive()
            .with_day(1)
            .and_then(|day| day.checked_sub_months(Months::new(1)))
            .ok_or("Invalid business month.")?;
        let (starts_at, ends_before) = self.definition.month_bounds(month_start)?;
        Ok(OntologyQueryDraft {
            source_id: snapshot.source_id,
            snapshot_id: snapshot.id,
            definition_name: self.definition.name.clone(),
            revision: self.revision,
            time_zone: self.definition.time_zone,
            sql: self
                .definition
                .order_sql(snapshot, starts_at, ends_before, false)?,
            starts_at: starts_at.to_rfc3339(),
            ends_before: ends_before.to_rfc3339(),
        })
    }
}

impl PaidOrdersDefinition {
    /// Compiles the approved fixed-month check using the same order selection as Query.
    /// # Errors
    /// Rejects incompatible schema bindings or an invalid sample month.
    pub fn sample_sql(
        &self,
        snapshot: &DatabaseSnapshot,
        sample: &PaidOrdersSample,
    ) -> Result<String, &'static str> {
        self.confirm(snapshot)?;
        let (start, end) = self.month_bounds(sample.start_of_month()?)?;
        self.order_sql(snapshot, start, end, true)
    }

    fn zone(&self) -> Result<FixedOffset, &'static str> {
        let offset = match self.time_zone {
            BusinessTimeZone::Utc => 0,
            BusinessTimeZone::Singapore => 8 * 3600,
        };
        FixedOffset::east_opt(offset).ok_or("Invalid business time zone.")
    }

    fn month_bounds(
        &self,
        month_start: NaiveDate,
    ) -> Result<(DateTime<FixedOffset>, DateTime<FixedOffset>), &'static str> {
        let zone = self.zone()?;
        let bound = |day: NaiveDate| {
            day.and_hms_opt(0, 0, 0)
                .and_then(|time| zone.from_local_datetime(&time).single())
                .ok_or("Invalid business month.")
        };
        let end = month_start
            .checked_add_months(Months::new(1))
            .ok_or("Invalid business month.")?;
        Ok((bound(month_start)?, bound(end)?))
    }

    fn order_sql(
        &self,
        snapshot: &DatabaseSnapshot,
        starts_at: DateTime<FixedOffset>,
        ends_before: DateTime<FixedOffset>,
        ids_only: bool,
    ) -> Result<String, &'static str> {
        let database_type = snapshot.database.database_type;
        if database_type != DatabaseType::PostgreSql {
            let field = binding(
                BindingRole::PaymentTime,
                &self.payment.table,
                &self.payment.paid_at_column,
            );
            let (_, column) = resolve_column(snapshot, &field)
                .map_err(|_| "Choose a current payment time column.")?;
            let time =
                dialect::PaymentTime::resolve(database_type, column, self.payment.time_storage)?;
            let sqlite_key = if database_type == DatabaseType::Sqlite {
                let field = binding(
                    BindingRole::OrderId,
                    &self.order.table,
                    &self.order.id_column,
                );
                let (table, column) = resolve_column(snapshot, &field)
                    .map_err(|_| "Choose the order table's single-column primary key.")?;
                Some(dialect::SqliteKey {
                    storage: if column.type_name == "TEXT" {
                        "text"
                    } else {
                        "integer"
                    },
                    collation: order_key_collation(database_type, &field, table, column)
                        .unwrap_or("BINARY"),
                })
            } else {
                None
            };
            return Ok(dialect::order_sql(
                self,
                time,
                sqlite_key.as_ref(),
                starts_at,
                ends_before,
                ids_only,
            ));
        }
        let starts_at = starts_at.to_rfc3339();
        let ends_before = ends_before.to_rfc3339();
        let order = &self.order;
        let payment = &self.payment;
        let order_table = qualified_name(&order.table);
        let payment_table = qualified_name(&payment.table);
        let order_id = quote_identifier(&order.id_column);
        let payment_order_id = quote_identifier(&payment.order_id_column);
        let status = quote_identifier(&payment.status_column);
        let paid_at = quote_identifier(&payment.paid_at_column);
        let succeeded = pg_literal(&payment.success_value);
        // Text preserves exact PostgreSQL IDs (including bigint values beyond JS integer precision).
        let projection = if ids_only {
            format!("o.{order_id}::text AS order_id")
        } else {
            format!("o.{order_id} AS order_id, fp.first_paid_at")
        };
        Ok(format!(
            "WITH first_payments AS (\n    SELECT p.{payment_order_id} AS order_id, MIN(p.{paid_at}) AS first_paid_at\n    FROM {payment_table} AS p\n    WHERE p.{status} = {succeeded}\n    GROUP BY p.{payment_order_id}\n)\nSELECT {projection}\nFROM {order_table} AS o\nJOIN first_payments AS fp ON fp.order_id = o.{order_id}\nWHERE fp.first_paid_at >= TIMESTAMPTZ '{starts_at}'\n  AND fp.first_paid_at < TIMESTAMPTZ '{ends_before}'\nORDER BY o.{order_id};"
        ))
    }
}

fn binding(role: BindingRole, table: &ObjectKey, column: &str) -> FieldBinding {
    FieldBinding {
        role,
        table: table.clone(),
        column: column.to_owned(),
    }
}

fn resolve_column<'a>(
    snapshot: &'a DatabaseSnapshot,
    field: &FieldBinding,
) -> Result<(&'a TableDefinition, &'a ColumnDefinition), ImpactReason> {
    let table = snapshot
        .schemas
        .iter()
        .find(|schema| schema.name == field.table.schema)
        .and_then(|schema| schema.tables.iter().find(|table| table.key == field.table))
        .ok_or(ImpactReason::MissingTable)?;
    let column = table
        .columns
        .iter()
        .find(|column| column.name == field.column)
        .ok_or(ImpactReason::MissingColumn)?;
    if field.role == BindingRole::OrderId
        && table
            .primary_key
            .as_ref()
            .is_none_or(|key| key.columns.as_slice() != [column.name.as_str()])
    {
        return Err(ImpactReason::ChangedOrderKey);
    }
    Ok((table, column))
}

fn order_key_collation<'a>(
    engine: DatabaseType,
    field: &FieldBinding,
    table: &'a TableDefinition,
    column: &ColumnDefinition,
) -> Option<&'a str> {
    if engine != DatabaseType::Sqlite
        || field.role != BindingRole::OrderId
        || column.type_name != "TEXT"
    {
        return None;
    }
    let index = table.indexes.iter().find(|index| index.primary)?;
    let terms = table.sqlite.as_ref()?.index_terms.get(&index.name)?;
    terms
        .first()?
        .collation
        .as_deref()
        .filter(|value| !value.eq_ignore_ascii_case("BINARY"))
}

fn evidence(
    engine: DatabaseType,
    field: FieldBinding,
    table: &TableDefinition,
    column: &ColumnDefinition,
) -> BindingEvidence {
    let order_key_collation =
        order_key_collation(engine, &field, table, column).map(str::to_ascii_uppercase);
    BindingEvidence {
        field,
        type_schema: column.type_schema.clone(),
        type_name: column.type_name.clone(),
        formatted_type: column.formatted_type.clone(),
        nullable: column.nullable,
        order_key_collation,
    }
}

fn quote_identifier(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}

fn qualified_name(key: &ObjectKey) -> String {
    format!(
        "{}.{}",
        quote_identifier(&key.schema),
        quote_identifier(&key.name)
    )
}

fn pg_literal(value: &str) -> String {
    format!("E'{}'", value.replace('\\', "\\\\").replace('\'', "''"))
}
