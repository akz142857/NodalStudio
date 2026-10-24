import { useI18n } from "../i18n";
import type { IndexDefinition } from "../platform/types";

/** Shared read-only index rendering for tables and materialized views. */
export function SchemaIndexDetails({ indexes, focusedName }: { indexes: IndexDefinition[]; focusedName?: string }) {
  const { t } = useI18n();
  if (!indexes.length) return null;
  return <section className="inspector-section">
    <h3>{t("business.indexes")}</h3>
    <ul className="inspector-list">{indexes.map(index => <li key={index.name} tabIndex={-1} data-evidence-target={focusedName === index.name ? "true" : undefined} data-evidence-focus={focusedName === index.name ? "true" : undefined}>
      <strong>{index.name}</strong>
      <span>{index.method} · {index.columns.join(", ")}{index.unique ? t("business.uniqueDetail") : ""}{index.primary ? ` · ${t("objects.primary")}` : ""}</span>
      {index.definition ? <pre tabIndex={0}>{index.definition}</pre> : null}
      {index.predicate ? <pre tabIndex={0}>{t("objects.predicate")}: {index.predicate}</pre> : null}
    </li>)}</ul>
  </section>;
}
