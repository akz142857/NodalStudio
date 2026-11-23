import type { DatabaseInfo, ObjectKey } from "./types";

export type BusinessTimeZone = "UTC" | "Asia/Singapore";
export type PaymentTimeStorage = "utcDateTime" | "singaporeDateTime" | "iso8601" | "unixSeconds" | "unixMilliseconds";
export type BindingRole = "orderId" | "paymentOrderId" | "paymentStatus" | "paymentTime";

export function requiresNewerMySqlForOntology(database: DatabaseInfo) {
  const major = database.version.split(".")[0];
  return database.databaseType === "mySql" && !database.version.toLowerCase().includes("mariadb")
    && /^\d+$/.test(major) && Number(major) < 8;
}

export interface PaidOrdersDefinition {
  name: string;
  order: { name: string; table: ObjectKey; idColumn: string };
  payment: { name: string; table: ObjectKey; orderIdColumn: string; statusColumn: string; successValue: string; paidAtColumn: string; timeStorage?: PaymentTimeStorage };
  timeZone: BusinessTimeZone;
}

export interface BindingImpact {
  field: { role: BindingRole; table: ObjectKey; column: string };
  reason: "missingTable" | "missingColumn" | "changedColumn" | "changedOrderKey";
}

export interface DefinitionRevision {
  id: string;
  revision: number;
}

export interface ConfirmedDefinition extends DefinitionRevision {
  definition: PaidOrdersDefinition;
  confirmedSnapshotId: string;
  impacts: BindingImpact[];
  sourceChangeId?: string;
  sample?: PaidOrdersSample;
}

export function ontologyRequiresReview(entry: ConfirmedDefinition) {
  return Boolean(entry.sourceChangeId || entry.impacts.length);
}

/** The recipe returns the previous business month. Only intercept requests with that meaning. */
export function matchingOntologyDefinitions(entries: readonly ConfirmedDefinition[], question: string) {
  const normalize = (value: string) => value.normalize("NFKC").trim().toLowerCase()
    .replace(/[?.!。！？]+$/u, "").replace(/\s+/g, " ").trim();
  const requested = normalize(question).replace(/^(?:查看|列出|查一下|查询)\s*|^(?:show(?: me)?|list)\s+/u, "");
  return entries.filter(({ definition }) => {
    const name = normalize(definition.name);
    return name && [name, `上月${name}`, `上个月${name}`, `上月的${name}`, `last month ${name}`, `${name} last month`].includes(requested);
  });
}

export interface PaidOrdersSample {
  month: string;
  expectedOrderIds: string[];
}

export interface OntologyVerification {
  id: string;
  snapshotId: string;
  checkedAt: string;
  definition: PaidOrdersDefinition;
  basis: string;
  month: string;
  expectedOrderIds: string[];
  actualOrderIds: string[];
  missingOrderIds: string[];
  unexpectedOrderIds: string[];
  passed: boolean;
  error?: string;
}

export interface OntologyReviewEvidence {
  definitionId: string;
  snapshotId: string;
  impacts: BindingImpact[];
  sourceChangeId?: string | null;
  sample: PaidOrdersSample | null;
  verification?: OntologyVerification;
  confirmedRevision?: number;
}

export interface OntologyScope {
  sourceId: string;
  snapshotId: string;
}

export function ontologyDefinitionsKey({ sourceId, snapshotId }: Pick<OntologyScope, "sourceId"> & Partial<Pick<OntologyScope, "snapshotId">>) {
  return snapshotId ? ["ontology-definitions", sourceId, snapshotId] as const : ["ontology-definitions", sourceId] as const;
}

export function ontologySelectionKey({ order, payment, timeZone }: PaidOrdersDefinition) {
  return JSON.stringify([
    order.table.schema, order.table.name, order.table.kind, order.idColumn,
    payment.table.schema, payment.table.name, payment.table.kind,
    payment.orderIdColumn, payment.statusColumn, payment.successValue, payment.paidAtColumn, payment.timeStorage, timeZone,
  ]);
}

export interface ConfirmOntologyInput {
  scope: OntologyScope;
  target?: DefinitionRevision;
  definition: PaidOrdersDefinition;
}

export interface SaveOntologySampleInput {
  scope: OntologyScope;
  target: DefinitionRevision;
  sample: PaidOrdersSample;
}

export interface VerifyOntologyReviewInput {
  sourceId: string;
  revision: string;
  itemKey: string;
  definition: PaidOrdersDefinition;
  basis: string;
}

export interface DraftOntologyInput {
  scope: OntologyScope;
  target: DefinitionRevision;
}

export interface OntologyQueryDraft extends OntologyScope {
  definitionName: string;
  revision: number;
  timeZone: BusinessTimeZone;
  startsAt: string;
  endsBefore: string;
  sql: string;
}
