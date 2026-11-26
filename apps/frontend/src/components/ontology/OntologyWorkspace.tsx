import { codeColumnKey } from "../../platform/code-view";
import { useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "../../design-system/Button";
import { EmptyState } from "../../design-system/EmptyState";
import { useI18n } from "../../i18n";
import type { DatabaseSnapshot, NodalStudioPlatform } from "../../platform";
import type { BindingImpact, ConfirmedDefinition, DefinitionRevision, OntologyQueryDraft, PaidOrdersDefinition, PaidOrdersSample } from "../../platform/ontology-types";
import { ontologyDefinitionsKey, ontologySelectionKey, ontologyRequiresReview as requiresReview } from "../../platform/ontology-types";
import { ActionIcon } from "../ActionIcon";
import { DefinitionEditor } from "./DefinitionEditor";
import { OntologyQueryPreview } from "./OntologyQueryPreview";
import { OntologySample } from "./OntologySample";
import { useOntologyDefinitions } from "./use-ontology-definitions";
import "./ontology.css";

interface ScopeProps {
  platform: NodalStudioPlatform;
  snapshot: DatabaseSnapshot;
}

export function OntologyWorkspace({ platform, snapshot, initialDefinitionId, refreshing, onRefresh, onViewChanges, onOpenQuery, onOpenCode }: ScopeProps & {
  initialDefinitionId?: string;
  refreshing: boolean;
  onRefresh: () => void;
  onViewChanges: (id: string) => void;
  onOpenCode?: (key: import("../../platform").ObjectKey, definitionId: string) => void;
  onOpenQuery: (draft: OntologyQueryDraft, target: DefinitionRevision) => void;
}) {
  const { t } = useI18n();
  const client = useQueryClient();
  const scope = { sourceId: snapshot.sourceId, snapshotId: snapshot.id };
  const definitions = useOntologyDefinitions(platform, scope);
  const [selectedId, setSelectedId] = useState(initialDefinitionId);
  const [editor, setEditor] = useState<{ definition: PaidOrdersDefinition; target?: DefinitionRevision }>();
  const [draft, setDraft] = useState<{ target: DefinitionRevision; result: OntologyQueryDraft }>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const newButton = useRef<HTMLButtonElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const detailPane = useRef<HTMLElement>(null);
  const entries = definitions.data ?? [];
  const selected = entries.find((entry) => entry.id === selectedId) ?? entries[0];
  const detailKey = editor ? "edit" : selected?.id;
  useLayoutEffect(() => {
    if (detailPane.current) detailPane.current.scrollTop = 0;
  }, [detailKey, snapshot.sourceId]);
  const needsReview = selected ? requiresReview(selected) : false;
  const edited = entries.find((entry) => entry.id === editor?.target?.id);
  const sampleWillReset = Boolean(edited?.sample && editor
    && ontologySelectionKey(editor.definition) !== ontologySelectionKey(edited.definition));
  const currentDraft = !needsReview && draft && draft.target.id === selected?.id && draft.target.revision === selected.revision
    && draft.result.snapshotId === snapshot.id && draft.result.sourceId === snapshot.sourceId ? draft : undefined;
  const busy = pending || refreshing || definitions.isPending || definitions.isError;

  function cacheDefinition(entry: ConfirmedDefinition) {
    client.setQueryData<ConfirmedDefinition[]>(ontologyDefinitionsKey(scope), (current) =>
      [...(current ?? []).filter((item) => item.id !== entry.id), entry].sort((left, right) => left.definition.name.localeCompare(right.definition.name)));
  }

  function selectDefinition(id: string) {
    setSelectedId(id);
    setEditor(undefined);
    setDraft(undefined);
    setError("");
  }

  function editDefinition(entry?: ConfirmedDefinition) {
    setError("");
    setDraft(undefined);
    setEditor(entry
      ? { definition: entry.definition, target: { id: entry.id, revision: entry.revision } }
      : { definition: newDefinition(t("ontology.order"), t("ontology.payment")) });
  }

  function cancelEdit() {
    const trigger = editor?.target ? editButton : newButton;
    setEditor(undefined);
    setError("");
    requestAnimationFrame(() => trigger.current?.focus());
  }

  async function confirmDefinition() {
    if (!editor || busy) return;
    setPending(true);
    setError("");
    try {
      const entry = await platform.confirmOntology({ scope, ...editor });
      cacheDefinition(entry);
      selectDefinition(entry.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPending(false);
    }
  }

  async function saveSample(entry: ConfirmedDefinition, sample: PaidOrdersSample) {
    if (busy) return false;
    setPending(true);
    setError("");
    try {
      const saved = await platform.saveOntologySample({ scope, target: { id: entry.id, revision: entry.revision }, sample });
      cacheDefinition(saved);
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return false;
    } finally {
      setPending(false);
    }
  }

  async function generateSql(entry: ConfirmedDefinition) {
    if (busy || requiresReview(entry)) return;
    setPending(true);
    setError("");
    setDraft(undefined);
    try {
      const target = { id: entry.id, revision: entry.revision };
      const result = await platform.draftOntologyLastMonth({ scope, target });
      setDraft({ target, result });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPending(false);
    }
  }

  return <section className="ontology-workspace ds-surface" aria-label={t("ontology.title")}>
    <header className="ontology-heading">
      <h2>{t("ontology.title")}</h2>
      <div className="ontology-toolbar-actions">
        <span className="ontology-source" title={snapshot.database.name}><ActionIcon name="database" />{snapshot.database.name}</span>
        <Button busy={refreshing} disabled={pending} onClick={onRefresh}><ActionIcon name="refresh" />{t("ontology.refresh")}</Button>
      </div>
    </header>
    <div className="ontology-columns">
      <aside className="ontology-list" aria-label={t("ontology.definitions")}>
        <div className="ontology-list-heading">
          <h3>{t("ontology.definitions")}</h3>
          <Button ref={newButton} variant="ghost" size="small" disabled={busy} data-active={(editor && !editor.target) || undefined}
            onClick={() => { if (!editor || editor.target) editDefinition(); }}>
            <ActionIcon name="add" />{t("ontology.new")}
          </Button>
        </div>
        <ul className="ontology-definition-list">
          {entries.map((entry) => <li key={entry.id}>
            <Button variant="ghost" disabled={pending} className="ontology-definition-row"
              aria-current={selected?.id === entry.id && (!editor || editor.target?.id === entry.id) ? "true" : undefined} onClick={() => selectDefinition(entry.id)}>
              <ActionIcon name="report" />
              <span><strong>{entry.definition.name}</strong>
                <small>{t(requiresReview(entry) ? "ontology.needsReview" : "ontology.confirmed")} · {t("ontology.revision", { value0: entry.revision })}</small></span>
              {requiresReview(entry) ? <span className="ontology-row-warning"><ActionIcon name="warning" /></span> : null}
            </Button>
          </li>)}
        </ul>
      </aside>
      <article ref={detailPane} className="ontology-detail inspector-surface">
        {definitions.isPending ? <p role="status" className="ontology-feedback">{t("ontology.loading")}</p> : null}
        {definitions.isError ? <div className="ontology-notice" data-tone="danger" role="alert">
          <ActionIcon name="warning" /><p>{String(definitions.error)}</p>
          <Button onClick={() => void definitions.refetch()}>{t("ontology.retry")}</Button>
        </div> : null}
        {error ? <div className="ontology-notice" data-tone="danger" role="alert"><ActionIcon name="warning" /><p>{error}</p></div> : null}
        {editor ? <DefinitionEditor snapshot={snapshot} definition={editor.definition} disabled={busy} title={t(editor.target ? "ontology.edit" : "ontology.new")}
          onChange={(definition) => setEditor({ ...editor, definition })}
          onCancel={cancelEdit}
          onConfirm={() => void confirmDefinition()}>
          {sampleWillReset ? <div className="ontology-notice" data-tone="warning" role="status">
            <ActionIcon name="warning" /><p>{t("ontology.sampleWillReset")}</p>
          </div> : null}
        </DefinitionEditor>
        : selected ? <>
          <div className="ontology-detail-heading">
            <div>
              <h3>{selected.definition.name}</h3>
              <p className="ontology-definition-status" data-review={needsReview || undefined}>
                <ActionIcon name={needsReview ? "warning" : "check"} />{t(needsReview ? "ontology.needsReview" : "ontology.confirmed")} · {t("ontology.revision", { value0: selected.revision })}
              </p>
            </div>
            {!needsReview ? <Button ref={editButton} disabled={busy} onClick={() => editDefinition(selected)}>{t("ontology.edit")}</Button> : null}
          </div>
          {needsReview ? <div className="ontology-notice ontology-impact" data-tone="warning">
            <ActionIcon name="warning" />
            <div><h4>{t(selected.sourceChangeId ? "ontology.sourceChanged" : "ontology.impact")}</h4>
              <p>{t(selected.sourceChangeId ? "ontology.sourceReviewRequired" : "ontology.reviewRequired")}</p>
              {selected.impacts.length ? <ImpactDetails impacts={selected.impacts} /> : null}
            </div>
            <Button variant="primary" disabled={busy} onClick={() => onViewChanges(selected.id)}>{t("ontology.viewChanges")}<ActionIcon name="chevronRight" /></Button>
          </div> : null}
          <p className="ontology-recipe">{t("ontology.recipe")}</p>
          <dl className="ontology-summary ontology-binding-summary">
            <dt>{selected.definition.order.name}</dt><dd><code>{tableName(selected.definition.order.table)}.{selected.definition.order.idColumn}</code>{onOpenCode && <button type="button" aria-label={t("codeView.findColumn", { name: selected.definition.order.idColumn })} onClick={() => onOpenCode(codeColumnKey(selected.definition.order.table, selected.definition.order.idColumn), selected.id)}>{t("codeView.related")}</button>}</dd>
            <dt>{selected.definition.payment.name}</dt><dd><code>{tableName(selected.definition.payment.table)}.{selected.definition.payment.orderIdColumn}</code>{onOpenCode && <button type="button" aria-label={t("codeView.findColumn", { name: selected.definition.payment.orderIdColumn })} onClick={() => onOpenCode(codeColumnKey(selected.definition.payment.table, selected.definition.payment.orderIdColumn), selected.id)}>{t("codeView.related")}</button>}</dd>
            <dt>{t("ontology.paymentStatus")}</dt><dd><code>{selected.definition.payment.statusColumn}</code> = <code>{selected.definition.payment.successValue}</code>{onOpenCode && <button type="button" aria-label={t("codeView.findColumn", { name: selected.definition.payment.statusColumn })} onClick={() => onOpenCode(codeColumnKey(selected.definition.payment.table, selected.definition.payment.statusColumn), selected.id)}>{t("codeView.related")}</button>}</dd>
            <dt>{t("ontology.paymentTime")}</dt><dd><code>{selected.definition.payment.paidAtColumn}</code>{onOpenCode && <button type="button" aria-label={t("codeView.findColumn", { name: selected.definition.payment.paidAtColumn })} onClick={() => onOpenCode(codeColumnKey(selected.definition.payment.table, selected.definition.payment.paidAtColumn), selected.id)}>{t("codeView.related")}</button>}</dd>
            {selected.definition.payment.timeStorage ? <>
              <dt>{t(snapshot.database.databaseType === "mySql" ? "ontology.storageTimeZone" : "ontology.timeStorage")}</dt>
              <dd>{t(`ontology.storage.${selected.definition.payment.timeStorage}`)}</dd>
            </> : null}
            <dt>{t("ontology.timeZone")}</dt><dd>{selected.definition.timeZone}</dd>
          </dl>
          <section className="ontology-query-section">
            <div className="ontology-section-heading">
              <div><h4><ActionIcon name="viewer" />{t("navigation.query")}</h4>
                <p>{t("ontology.lastMonth")} · {selected.definition.timeZone}</p>
              </div>
              <Button variant={needsReview || currentDraft ? "secondary" : "primary"} disabled={busy || needsReview}
                onClick={() => void generateSql(selected)}>{t("ontology.generate")}</Button>
            </div>
            {currentDraft ? <section className="ontology-draft" aria-label={t("ontology.draft")}>
              <OntologyQueryPreview draft={currentDraft.result} />
              <div className="ontology-actions">
                <Button variant="primary" disabled={busy} onClick={() => onOpenQuery(currentDraft.result, currentDraft.target)}>{t("ontology.openQuery")}<ActionIcon name="chevronRight" /></Button>
              </div>
            </section> : null}
          </section>
          <OntologySample key={`${selected.id}:${selected.revision}`} sample={selected.sample} locked={needsReview && Boolean(selected.sample)}
            busy={busy} onSave={(sample) => saveSample(selected, sample)} />
        </> : definitions.isSuccess ? <EmptyState icon={<ActionIcon name="relationships" />} title={t("ontology.emptyTitle")} description={t("ontology.empty")} /> : null}
      </article>
    </div>
  </section>;
}

function ImpactDetails({ impacts }: { impacts: BindingImpact[] }) {
  const { t } = useI18n();
  return <ul>{impacts.map(({ field, reason }) => <li key={field.role}>
    {t(`ontology.${field.role}`)} → <code>{tableName(field.table)}.{field.column}</code> · {t(`ontology.${reason}`)}
  </li>)}</ul>;
}

function tableName(table: { schema: string; name: string }) {
  return `${table.schema}.${table.name}`;
}

function newDefinition(orderName: string, paymentName: string): PaidOrdersDefinition {
  const table = { kind: "table", schema: "", name: "" } as const;
  return {
    name: "",
    order: { name: orderName, table, idColumn: "" },
    payment: { name: paymentName, table, orderIdColumn: "", statusColumn: "", successValue: "", paidAtColumn: "" },
    timeZone: "UTC",
  };
}
