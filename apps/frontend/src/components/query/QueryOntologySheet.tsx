import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "../../design-system/Button";
import { ModalSurface } from "../../design-system/ModalSurface";
import { useI18n } from "../../i18n";
import type { NodalStudioPlatform } from "../../platform";
import { ontologyRequiresReview, type ConfirmedDefinition, type OntologyQueryDraft, type OntologyScope } from "../../platform/ontology-types";
import { ActionIcon } from "../ActionIcon";
import { OntologyQueryPreview } from "../ontology/OntologyQueryPreview";
import { SearchSelect } from "../SearchSelect";

interface Props {
  platform: NodalStudioPlatform;
  scope: OntologyScope;
  entries: ConfirmedDefinition[];
  loading: boolean;
  initialPreview?: { id: string; draft: OntologyQueryDraft };
  onDismiss: () => void;
  onReview: (id: string) => void;
  onReload: () => void;
  onUse: (draft: OntologyQueryDraft, target: { id: string; revision: number }) => void;
}

export function QueryOntologySheet({ platform, scope, entries, loading, initialPreview, onDismiss, onReview, onReload, onUse }: Props) {
  const { t } = useI18n();
  const [selectedId, setSelectedId] = useState(() => entries.length === 1 ? entries[0].id : "");
  const [preview, setPreview] = useState(initialPreview);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const operation = useRef(false);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const selected = entries.length === 1 ? entries[0] : entries.find((entry) => entry.id === selectedId);
  const needsReview = selected ? ontologyRequiresReview(selected) : false;
  const draft = !needsReview && selected && preview?.id === selected.id && preview.draft.revision === selected.revision
    ? preview.draft : undefined;
  const title = t("ontology.useDefinition");

  async function previewOrUse() {
    if (!selected || needsReview || operation.current) return;
    operation.current = true;
    setPending(true);
    setError("");
    try {
      const next = await platform.draftOntologyLastMonth({ scope, target: { id: selected.id, revision: selected.revision } });
      if (!mounted.current) return;
      if (next.sourceId !== scope.sourceId || next.snapshotId !== scope.snapshotId || next.revision !== selected.revision) {
        throw new Error(t("ontology.queryScopeChanged"));
      }
      // Fetch again on insertion so a stale approval or a new business month cannot
      // transfer SQL different from the preview the user reviewed.
      if (draft && next.sql === draft.sql && next.startsAt === draft.startsAt && next.endsBefore === draft.endsBefore) onUse(next, { id: selected.id, revision: selected.revision });
      else setPreview({ id: selected.id, draft: next });
    } catch (reason) {
      if (!mounted.current) return;
      setPreview(undefined);
      setError(reason instanceof Error ? reason.message : String(reason));
      onReload();
    } finally {
      operation.current = false;
      if (mounted.current) setPending(false);
    }
  }

  return <ModalSurface label={title} onDismiss={() => { if (!operation.current) onDismiss(); }}>
    <div className="query-dialog-backdrop" role="presentation">
      <form className="ontology-query-sheet query-ontology-sheet ds-surface" onSubmit={(event) => { event.preventDefault(); void previewOrUse(); }}>
        <header><h3>{title}</h3><p>{t("ontology.useLastMonth")}</p></header>
        {!entries.length ? <p role="status">{t(loading ? "ontology.loading" : "ontology.definitionUnavailable")}</p> : null}
        {entries.length > 1 ? <SearchSelect label={t("ontology.name")} value={selectedId} disabled={pending}
          options={entries.map((entry) => ({ value: entry.id, label: entry.definition.name,
            detail: t(ontologyRequiresReview(entry) ? "ontology.needsReview" : "ontology.confirmed") }))}
          placeholder={t("ontology.chooseDefinition")} onChange={(id) => { setSelectedId(id); setError(""); setPreview(undefined); }} /> : null}
        {selected ? <div className="query-ontology-selection">
          <strong>{selected.definition.name}</strong>
          <span>{t(needsReview ? "ontology.needsReview" : "ontology.confirmed")} · {t("ontology.revision", { value0: selected.revision })}</span>
        </div> : null}
        {selected && needsReview ? <div className="query-ontology-review">
          <div className="ontology-notice" data-tone="warning">
            <ActionIcon name="warning" />
            <div><h4>{t(selected.sourceChangeId ? "ontology.sourceChanged" : "ontology.impact")}</h4>
              <p>{t("ontology.reviewRequired")}</p>
              {selected.impacts.length ? <ul>{selected.impacts.map(({ field, reason }) => <li key={field.role}>
                {t(`ontology.${field.role}`)} · <code>{field.table.schema}.{field.table.name}.{field.column}</code> · {t(`ontology.${reason}`)}
              </li>)}</ul> : null}
            </div>
          </div>
          {selected.sample ? <details><summary>{t("ontology.sample")} · {selected.sample.month} ({selected.definition.timeZone})</summary>
            <p>{t("ontology.expectedOrders")}</p>
            <code>{selected.sample.expectedOrderIds.join(", ") || t("ontology.emptySet")}</code>
          </details> : <p>{t("ontology.sampleRequired")}</p>}
        </div> : null}
        {draft ? <OntologyQueryPreview draft={draft} /> : null}
        {error ? <p role="alert">{error}</p> : null}
        <footer className="ontology-actions">
          <Button data-modal-focus disabled={pending} onClick={onDismiss}>{t("business.cancel")}</Button>
          {selected && needsReview ? <Button variant="primary" onClick={() => onReview(selected.id)}>{t("ontology.viewChanges")}</Button>
            : <Button type="submit" variant="primary" disabled={!selected || pending}>{t(draft ? "ontology.insertQuery" : "ontology.previewQuery")}</Button>}
        </footer>
      </form>
    </div>
  </ModalSurface>;
}
