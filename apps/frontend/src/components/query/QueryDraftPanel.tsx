import { useEffect, useId, useState } from "react";
import type { DatabaseSnapshot, EffectiveSettings, NodalStudioPlatform, ObjectKey, SemanticBundle, TableDefinition } from "../../platform";
import { objectId, objectLabel } from "../../graph/business-discovery";
import { DiscoveryAssistant } from "../DiscoveryAssistant";
import { ActionIcon } from "../ActionIcon";
import { resolveDraftContext, validateDraftContext, type DraftContext } from "./query-context";
import "./query-draft.css";

export interface QueryDraftSeed {
  id: number;
  sourceId: string;
  snapshotId: string;
  question: string;
  root: ObjectKey | null;
  tables: ObjectKey[];
  domainId: string | null;
}
interface Props {
  platform: NodalStudioPlatform;
  snapshot: DatabaseSnapshot;
  settings: EffectiveSettings;
  semantics: SemanticBundle;
  seed?: QueryDraftSeed;
  initialTable?: TableDefinition;
  onUseSql: (sql: string) => void;
  onOpenSettings: () => void;
}
export function QueryDraftPanel(props: Props) {
  return <DraftPanel key={JSON.stringify([props.snapshot.id, props.snapshot.sourceId, props.snapshot.fingerprint, props.settings.source, props.settings.app.privacy, props.seed?.id])} {...props} />;
}
function DraftPanel({ platform, snapshot, settings, semantics, seed, initialTable, onUseSql, onOpenSettings }: Props) {
  const questionId = useId();
  const [revision, setRevision] = useState(0);
  const usableSeed = seed?.sourceId === snapshot.sourceId && seed.snapshotId === snapshot.id ? seed : undefined;
  const carried = usableSeed?.root && usableSeed.tables.length ? { root: usableSeed.root, tables: usableSeed.tables } : undefined;
  const [question, setQuestion] = useState(usableSeed?.question ?? "");
  const [manual, setManual] = useState<DraftContext | undefined>(carried);
  const [clarified, setClarified] = useState<DraftContext>();
  const [submitted, setSubmitted] = useState(Boolean(carried && usableSeed?.question));
  const [autoPrepare, setAutoPrepare] = useState(false);
  const [domainId, setDomainId] = useState(usableSeed?.domainId ?? "");
  const [contextSearch, setContextSearch] = useState("");
  const [latest, setLatest] = useState(false);
  const [snapshotError, setSnapshotError] = useState("");
  useEffect(() => {
    let active = true;
    void platform.listSnapshots(snapshot.sourceId).then((items) => { if (active) setLatest(items[0]?.id === snapshot.id); }).catch(() => { if (active) setSnapshotError("Unable to verify the latest snapshot. Reopen drafting to retry."); });
    return () => { active = false; };
  }, [platform, snapshot.sourceId, snapshot.id]);
  const tables = snapshot.schemas.flatMap((schema) => schema.tables);
  const domains = semantics.domainGroups.filter((d) => d.sourceId === snapshot.sourceId);
  const scope = settings.source?.ai.contextScope ?? "currentTable";
  const configured = settings.source?.sourceId === snapshot.sourceId && settings.source.ai.enabled && settings.source.ai.provider === "openAiCompatible" && !settings.app.privacy.offlineMode;
  const automatic = submitted && !manual && !clarified ? resolveDraftContext(snapshot, semantics, settings, question, domainId, initialTable?.key) : undefined;
  const context = manual ?? clarified ?? (automatic?.kind === "ready" ? automatic.context : undefined);
  const problem = context ? validateDraftContext(snapshot, semantics, settings, context, domainId) : automatic?.kind === "blocked" ? automatic.message : undefined;
  const ready = submitted && context && !problem;
  const input = { snapshotId: snapshot.id, domainId: domainId || null, task: { operation: "draftSql" as const, question, root: context?.root ?? null, candidates: context?.tables ?? [], pathTables: [], pathRelationships: [] } };
  const examples = ["按月汇总最近半年的趋势", "哪些客户最近没有订单？", "按状态统计用户数量"];
  function changeQuestion(value: string) { setQuestion(value); setClarified(undefined); setSubmitted(false); setAutoPrepare(false); }
  function pinContext(next: DraftContext) { setManual(next); setClarified(undefined); setSubmitted(false); setAutoPrepare(false); }
  function submit() { if (!question.trim()) return; setSubmitted(true); setAutoPrepare(true); setRevision((n) => n + 1); }
  return <section className="query-draft-panel" aria-label="Draft query with AI" data-start={!submitted || undefined}>
    <div className="query-draft-content">
      <header className="query-ask-heading"><span className="query-ask-symbol"><ActionIcon name="ai" /></span><h2>What would you like to know?</h2><p>Ask in your own words. We’ll find the relevant data and help you write the SQL.</p></header>
      <form className="query-composer" onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <label className="visually-hidden" htmlFor={questionId}>Question</label>
        <textarea id={questionId} aria-label="Question" value={question} rows={3} maxLength={2000} placeholder="例如：最近 30 天，哪些客户的订单金额最高？" onChange={(e) => changeQuestion(e.target.value)} />
        <div className="query-composer-footer"><span><ActionIcon name="database" />{snapshot.database.name}</span><button className="query-compose-submit" type="submit" disabled={!question.trim()}><ActionIcon name="ai" />{submitted ? "Review again" : "Create SQL draft"}</button></div>
      </form>
      {!question.trim() ? <div className="query-example-prompts" aria-label="Example questions">{examples.map((example) => <button type="button" key={example} onClick={() => changeQuestion(example)}>{example}</button>)}</div> : null}
      <div className="query-context-tools">
        <span>{manual ? carried && JSON.stringify(manual) === JSON.stringify(carried) ? "Context from Business question" : "Custom context" : "Automatic context"}</span>
        <details><summary>Adjust context</summary><div className="query-context-adjustment">
          <p>Optional. Let the question guide discovery, or pin data you already know.</p>
          {manual ? <button type="button" onClick={() => { setManual(undefined); setSubmitted(false); }}>Find context automatically</button> : null}
          <label>Search data<input type="search" value={contextSearch} onChange={(e) => setContextSearch(e.target.value)} placeholder="Search tables…" /></label>
          <div className="query-context-options">{tables.filter((t) => objectLabel(t.key).toLowerCase().includes(contextSearch.toLowerCase())).map((table) => {
            const checked = manual?.tables.some((key) => objectId(key) === objectId(table.key)) ?? false;
            return <label key={objectId(table.key)}><input type="checkbox" checked={checked} disabled={!checked && (manual?.tables.length ?? 0) >= 3} onChange={(e) => {
              const next = e.target.checked ? [...manual?.tables ?? [], table.key] : manual?.tables.filter((key) => objectId(key) !== objectId(table.key)) ?? [];
              if (next.length) pinContext({ root: next[0], tables: next }); else { setManual(undefined); setSubmitted(false); }
            }} /><span>{objectLabel(table.key)}</span></label>;
          })}</div><small>Up to three tables; relationships and AI scope are checked before sending.</small>
        </div></details>
      </div>
      {scope === "domain" && !domainId ? <div className="query-domain-choice"><p>Which business domain should this question use?</p>{domains.map((d) => <button type="button" key={d.id} onClick={() => { setDomainId(d.id); setSubmitted(false); }}>{d.name}</button>)}{!domains.length ? <button type="button" onClick={onOpenSettings}>Review AI scope in settings</button> : null}</div> : null}
      {scope === "domain" && domainId ? <div className="query-domain-choice"><span>Domain: {domains.find((d) => d.id === domainId)?.name ?? domainId}</span><button type="button" onClick={() => { setDomainId(""); setClarified(undefined); setSubmitted(false); }}>Change domain</button></div> : null}
      {!configured ? <div className="query-model-setup"><ActionIcon name="ai" /><div><strong>Connect your AI model</strong><p>Use the model configured for this database to turn your question into SQL.</p></div><button type="button" onClick={onOpenSettings}>Open AI settings</button></div> : null}
      {submitted && automatic?.kind === "clarify" ? <section className="query-context-response" aria-label="Clarify query context"><h3>A little more context</h3><p>{automatic.message}</p><div className="query-context-choices">{automatic.choices.map((choice) => <button type="button" key={objectId(choice.key)} onClick={() => { setClarified({ root: choice.key, tables: [choice.key] }); setAutoPrepare(true); }}><strong>{objectLabel(choice.key)}</strong><span>{choice.reason}</span></button>)}</div></section> : null}
      {problem ? <p className="query-context-response" role="alert">{problem}</p> : null}
      {snapshotError ? <p role="alert">{snapshotError}</p> : null}
      {ready ? <section className="query-context-response" aria-label="Query context"><h3>Data for this question</h3><div className="query-context-chips">{context.tables.map((key) => <span key={objectId(key)}><ActionIcon name="database" />{objectLabel(key)}</span>)}</div><p>{manual ? "Using your chosen context. You can adjust it above." : clarified ? "Using the data you confirmed for this question." : automatic?.kind === "ready" ? automatic.reason : ""}</p>
        {configured ? <DiscoveryAssistant platform={platform} snapshot={snapshot} settings={settings} input={input} autoPrepare={autoPrepare} binding={JSON.stringify([revision, semantics.logicalRelationships, semantics.domainGroups, semantics.knowledge])} available={latest} onApplyTerms={() => {}} onLocate={() => {}} onOpenSettings={onOpenSettings} onUseSql={onUseSql} /> : null}
      </section> : null}
      <p className="query-draft-footnote"><ActionIcon name="shield" />Schema context only. SQL runs only when you choose Run in the editor.</p>
    </div>
  </section>;
}
