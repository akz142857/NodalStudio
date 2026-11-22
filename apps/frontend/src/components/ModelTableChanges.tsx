import { useState } from "react";
import { translateUiLabel } from "../i18n/business-labels";
import { useI18n } from "../i18n";
import type { ModelTableChange } from "../graph/model-table-changes";
import type { DatabaseSnapshot, NodalStudioPlatform, RuntimeInfo, SchemaChangeSet, SchemaOperation } from "../platform";
import { changeLabel, operationProperties, PROPERTY_LABELS, propertyValue } from "./schema-change-details";
import { useComparisonSnapshot } from "./use-comparison-snapshot";
import "./model-table-changes.css";

const CHANGE_PAGE_SIZE = 10;

export function ModelTableChangeDetails({ change, changeSet, snapshot, platform, runtimeKind }: {
  change: ModelTableChange;
  changeSet: SchemaChangeSet;
  snapshot: DatabaseSnapshot;
  platform: NodalStudioPlatform;
  runtimeKind?: RuntimeInfo["kind"];
}) {
  const { t } = useI18n();
  const [limit, setLimit] = useState(CHANGE_PAGE_SIZE);
  const before = useComparisonSnapshot(changeSet.beforeSnapshotId, snapshot, platform, runtimeKind);
  const operations = change.operations.filter((operation) => operation.operationType !== "alterTable");
  const definitionChange = change.operations.find((operation) => operation.operationType === "alterTable");
  return <section className="model-table-change-details" aria-label={t("modelChanges.tableDetails")}>
    <h3>{t("modelChanges.tableDetails")}</h3>
    {operations.length > 0 && <ol>{operations.slice(0, limit).map((operation, index) => (
      <li key={index}>
        <div className="model-table-change-heading">
          <strong>{operation.object.name}</strong>
          <span>{translateUiLabel(changeLabel(operation.operationType), t)}</span>
        </div>
        <ModelOperationValues operation={operation} before={before.snapshot} after={snapshot} />
      </li>
    ))}</ol>}
    {limit < operations.length && <button type="button" onClick={() => setLimit((value) => value + CHANGE_PAGE_SIZE)}>{t("modelChanges.showMore")}</button>}
    {definitionChange && <SqliteDefinitionChange operation={definitionChange} />}
  </section>;
}

function sqliteDefinition(summary: string | null): string | undefined {
  if (!summary) return undefined;
  try {
    const metadata = JSON.parse(summary) as { definition?: unknown } | null;
    return typeof metadata?.definition === "string" ? metadata.definition : undefined;
  } catch {
    return undefined;
  }
}

function SqliteDefinitionChange({ operation }: { operation: SchemaOperation }) {
  const { t } = useI18n();
  const before = sqliteDefinition(operation.before);
  const after = sqliteDefinition(operation.after);
  if (before === after) return <p className="model-table-definition-change">{t("modelChanges.sqliteMetadataChanged")}</p>;
  return <details className="model-table-definition-change">
    <summary>{t("modelChanges.viewDefinitionChange")}</summary>
    <dl>
      <div><dt>{t("business.beforeDetail")}</dt><dd><pre tabIndex={0}>{before ?? t("business.objectDetailsUnavailable")}</pre></dd></div>
      <div><dt>{t("business.after")}</dt><dd><pre tabIndex={0}>{after ?? t("business.objectDetailsUnavailable")}</pre></dd></div>
    </dl>
  </details>;
}

function ModelOperationValues({ operation, before, after }: {
  operation: SchemaOperation;
  before?: DatabaseSnapshot;
  after: DatabaseSnapshot;
}) {
  const { t } = useI18n();
  const left = before && operation.before !== null && operationProperties(before, operation, "before");
  const right = operation.after !== null && operationProperties(after, operation, "after");
  const changed = left && right ? [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .filter((key) => JSON.stringify(left[key]) !== JSON.stringify(right[key])
      && (key !== "typeName" || left.formattedType === right.formattedType)) : [];
  const formatValue = (value: unknown, key: string) =>
    Array.isArray(value) && value.every((item) => typeof item === "string") && value.length
      ? value.join(", ") : propertyValue(value, t, key);
  if (left && right && changed.length) return <div className="model-table-property-changes">
    {changed.map((key) => <div key={key}>
      <small>{translateUiLabel(PROPERTY_LABELS[key] ?? changeLabel(key), t)}</small>
      <dl className="model-table-change-values">
        <div><dt>{t("business.beforeDetail")}</dt><dd>{formatValue(left[key], key)}</dd></div>
        <div><dt>{t("business.after")}</dt><dd>{formatValue(right[key], key)}</dd></div>
      </dl>
    </div>)}
  </div>;
  return <dl className="model-table-change-values">
    <div><dt>{t("business.beforeDetail")}</dt><dd>{operation.before ?? t("business.notPresent")}</dd></div>
    <div><dt>{t("business.after")}</dt><dd>{operation.after ?? t("business.notPresent")}</dd></div>
  </dl>;
}
