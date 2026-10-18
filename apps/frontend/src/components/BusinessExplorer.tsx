import { useEffect, useMemo, useState } from "react";
import type { DatabaseSnapshot, DiscoveryOperation, EffectiveSettings, NodalStudioPlatform, SemanticBundle, TableDefinition } from "../platform";
import { discoverTables, findKnownPath, knownRelationships, neighborhood, objectId, objectLabel } from "../graph/business-discovery";
import { DiscoveryAssistant } from "./DiscoveryAssistant";
import { SchemaCanvas } from "./SchemaCanvas";
import "./business-explorer.css";

interface Props {
  snapshot: DatabaseSnapshot;
  semantics: SemanticBundle;
  settings: EffectiveSettings;
  platform: NodalStudioPlatform;
  desktop: boolean;
  initialTable?: TableDefinition;
  sourceLabel?: string;
  onClose: () => void;
  onLocate: (table: TableDefinition) => void;
  onExplain: (table: TableDefinition) => void;
  onOpenSettings: () => void;
}
export function BusinessExplorer(props: Props) {
  // Changing the model, effective policy or semantic bindings destroys every old task and focus.
  return <ExplorerSession key={JSON.stringify([props.snapshot, props.semantics.domainGroups, props.semantics.logicalRelationships, props.settings.source, props.settings.app.privacy, props.desktop, props.semantics.knowledge])} {...props} />;
}
function ExplorerSession({ snapshot, semantics, settings, platform, desktop, initialTable, sourceLabel, onClose, onLocate, onExplain, onOpenSettings }: Props) {
  const [question, setQuestion] = useState(""); const [searched, setSearched] = useState(false);
  const [terms, setTerms] = useState<string[]>([]); const [limit, setLimit] = useState(5);
  const [localDomain, setLocalDomain] = useState(""); const [aiDomain, setAiDomain] = useState("");
  const [rootId, setRootId] = useState(initialTable ? objectId(initialTable.key) : "");
  const [localSelection, setLocalSelection] = useState<TableDefinition | undefined>(initialTable);
  const [targetId, setTargetId] = useState(""); const [depth, setDepth] = useState(1);
  const [operation, setOperation] = useState<DiscoveryOperation>("expand");
  const [latest, setLatest] = useState(false); const [latestError, setLatestError] = useState("");
  useEffect(() => {
    if (!desktop) return;
    let active = true;
    void platform.listSnapshots(snapshot.sourceId).then((items) => {
      if (active) setLatest(items[0]?.id === snapshot.id);
    }).catch(() => { if (active) setLatestError("Unable to verify the latest snapshot; AI is unavailable."); });
    return () => { active = false; };
  }, [desktop, platform, snapshot.id, snapshot.sourceId]);
  const domains = semantics.domainGroups.filter((group) => group.sourceId === snapshot.sourceId);
  const tables = snapshot.schemas.flatMap((schema) => schema.tables);
  const root = tables.find((table) => objectId(table.key) === rootId);
  const target = tables.find((table) => objectId(table.key) === targetId);
  const candidates = useMemo(() => discoverTables(snapshot, searched ? question : "", semantics.domainGroups, !!settings.source?.ai.includeComments, localDomain, terms, settings.source?.ai.includeConfirmedSemantics ? semantics.knowledge : []), [snapshot, searched, question, semantics.domainGroups, settings.source?.ai.includeComments, localDomain, terms, settings.source?.ai.includeConfirmedSemantics, semantics.knowledge]);
  const graph = useMemo(() => knownRelationships(snapshot, semantics.logicalRelationships), [snapshot, semantics.logicalRelationships]);
  const path = useMemo(() => {
    const keys = snapshot.schemas.flatMap((schema) => schema.tables).map((table) => table.key);
    const a = keys.find((key) => objectId(key) === rootId); const b = keys.find((key) => objectId(key) === targetId);
    return a && b ? findKnownPath(a, b, graph.relationships, depth) : undefined;
  }, [snapshot, rootId, targetId, graph.relationships, depth]);
  const local = useMemo(() => {
    const key = snapshot.schemas.flatMap((schema) => schema.tables).find((table) => objectId(table.key) === rootId)?.key;
    return key ? neighborhood(snapshot, key, graph.relationships, depth, path) : undefined;
  }, [snapshot, rootId, graph.relationships, depth, path]);
  const localSemantics = useMemo(() => {
    const included = new Set(local?.snapshot.schemas.flatMap((schema) => schema.tables).map((table) => objectId(table.key)) ?? []);
    const visible = new Set(graph.relationships.filter((edge) => included.has(objectId(edge.source)) && included.has(objectId(edge.target))).map((edge) => edge.id));
    return { ...semantics, annotations: [], orphanedAnnotations: [], layout: null, savedViews: [], logicalRelationships: semantics.logicalRelationships.filter((r) => visible.has(`logical|${r.id}`)) };
  }, [semantics, graph.relationships, local]);
  const selectRoot = (table: TableDefinition) => { setRootId(objectId(table.key)); setLocalSelection(table); setTargetId(""); setDepth(1); };
  const input = { snapshotId: snapshot.id, domainId: aiDomain || null, task: { operation, question, root: root?.key ?? null, candidates: candidates.slice(0, 100).map((c) => c.table.key), pathTables: path?.tables ?? [], pathRelationships: path?.relationships.map((r) => r.id) ?? [] } };
  const canStep = operation === "expand" || (operation === "rank" ? searched && candidates.length > 0 : !!path);
  const allowed = settings.source?.ai.contextScope;
  const needsScope = operation !== "expand" && (allowed === "currentTable" || (allowed === "oneHop" && !root) || (allowed === "domain" && !aiDomain));
  return <section className="business-explorer" aria-label="Business table discovery">
    <header className="discovery-header"><div><p className="eyebrow">UNDERSTAND A DATABASE</p><h2>Find tables by business question</h2></div><button type="button" onClick={onClose}>Back to previous view</button></header>
    <div className="discovery-workspace">
      <div className="discovery-search-pane">
        <p>{sourceLabel ?? snapshot.database.name} · Snapshot {snapshot.fingerprint.slice(0, 12)}</p>
        <p className="ai-policy">Search the entire loaded snapshot, independent of canvas filters. Only current, locally confirmed team statements are reusable. No row data is read.</p>
        <form onSubmit={(event) => { event.preventDefault(); setSearched(true); setTerms([]); setLimit(5); }}>
          <label className="ai-control">Business question<textarea rows={3} maxLength={2000} placeholder="订单支付相关的结构，从哪张表开始看？" value={question} onChange={(event) => { setQuestion(event.target.value); setSearched(false); setTerms([]); setLimit(5); }} /></label>
          <label className="ai-control">Local search domain<select value={localDomain} onChange={(event) => { setLocalDomain(event.target.value); setLimit(5); }}><option value="">Entire loaded snapshot</option>{domains.map((domain) => <option key={domain.id} value={domain.id}>{domain.name}</option>)}</select></label>
          <button type="submit" disabled={!question.trim()}>Search locally</button>
        </form>
        {/account|账户|账号/i.test(question) ? <div className="discovery-ambiguity"><p>“Account” can mean login identity or a financial account. Choose a meaning to refine locally.</p><button type="button" onClick={() => { setQuestion(`${question} login identity 登录`); setSearched(true); setTerms(["login", "identity"]); }}>Login identity</button><button type="button" onClick={() => { setQuestion(`${question} ledger balance 财务`); setSearched(true); setTerms(["ledger", "balance"]); }}>Financial account</button></div> : null}
        {terms.length ? <p className="ai-policy">Applied search terms · hypotheses: {terms.join(", ")}</p> : null}
        <h3>Local candidates {searched ? `· ${candidates.length}` : ""}</h3>
        {searched && !candidates.length ? <p role="status">No reliable local candidates. Try another term, remove the domain filter, or explicitly preview question-only term expansion. Uncollected schemas and other sources are not covered.</p> : null}
        {candidates.slice(0, limit).map((candidate) => <article className="discovery-candidate" key={objectId(candidate.table.key)}>
          <h4>{objectLabel(candidate.table.key)}</h4><small>{sourceLabel ?? snapshot.database.name} · {candidate.direct ? "Direct metadata match" : "Term hypothesis · needs confirmation"} · local order</small>
          {candidate.matchingColumns.length ? <p>Fields: {candidate.matchingColumns.join(", ")}</p> : null}
          <ul>{candidate.reasons.slice(0, 4).map((reason) => <li key={reason}>{reason}</li>)}</ul>
          <div className="discovery-actions"><button type="button" onClick={() => onLocate(candidate.table)}>Locate table</button><button type="button" onClick={() => selectRoot(candidate.table)}>Expand relationships</button><button type="button" onClick={() => onExplain(candidate.table)} disabled={!desktop || !latest}>Explain this table</button></div>
        </article>)}
        {candidates.length > limit ? <button type="button" onClick={() => setLimit((n) => n + 10)}>Show more candidates</button> : null}
        <section className="discovery-ai-controls">
          <h3>Optional AI step</h3>
          <label className="ai-control">AI operation<select value={operation} onChange={(event) => setOperation(event.target.value as DiscoveryOperation)}><option value="expand">Question-only term expansion</option><option value="rank">Rank permitted candidates</option><option value="path">Explain selected path</option></select></label>
          {allowed === "domain" && operation !== "expand" ? <label className="ai-control">AI send domain<select value={aiDomain} onChange={(event) => setAiDomain(event.target.value)}><option value="">Select one domain explicitly…</option>{domains.map((domain) => <option key={domain.id} value={domain.id}>{domain.name}</option>)}</select></label> : null}
          {latestError ? <p role="alert">{latestError}</p> : null}
          {needsScope ? <p>Ranking and path explanation need OneHop with an explicit root, or one explicit Domain. CurrentTable supports the selected table’s explanation. <button type="button" onClick={onOpenSettings}>Change AI settings</button></p> : null}
          {!canStep ? <p>{operation === "rank" ? "Run local search before ranking candidates." : "Select two tables with a known path before explaining it."}</p> : null}
          {canStep && !needsScope ? <DiscoveryAssistant platform={platform} snapshot={snapshot} settings={settings} input={input} binding={JSON.stringify([localDomain, terms, depth, rootId, targetId, semantics.domainGroups, semantics.logicalRelationships, semantics.knowledge])} available={desktop && latest} onApplyTerms={(next) => { setTerms(next); setSearched(true); setLimit(5); }} onLocate={onLocate} onOpenSettings={onOpenSettings} /> : null}
          {candidates.length > 100 && operation === "rank" ? <p>Only the first 100 local candidates are submitted for scope filtering; at most 20 tables fit one AI request. Remaining candidates stay local.</p> : null}
        </section>
      </div>
      <div className="discovery-map-pane">
        <div className="discovery-map-controls">
          <label className="ai-control">Explicit root table<select value={rootId} onChange={(event) => { setRootId(event.target.value); setLocalSelection(tables.find((t) => objectId(t.key) === event.target.value)); setTargetId(""); setDepth(1); }}><option value="">Select a root…</option>{tables.map((table) => <option key={objectId(table.key)} value={objectId(table.key)}>{objectLabel(table.key)}</option>)}</select></label>
          <label className="ai-control">Local graph depth<select value={depth} onChange={(event) => setDepth(Number(event.target.value))}><option value={1}>One hop</option><option value={2}>Two hops</option></select></label>
          <label className="ai-control">Path destination<select value={targetId} onChange={(event) => setTargetId(event.target.value)} disabled={!root}><option value="">Select a destination…</option>{tables.filter((table) => objectId(table.key) !== rootId).map((table) => <option key={objectId(table.key)} value={objectId(table.key)}>{objectLabel(table.key)}</option>)}</select></label>
          <p className="ai-policy">Temporary local view · full model layout and selection are preserved. Graph depth does not change AI scope.</p>
        </div>
        {local ? <div className="discovery-local-canvas"><SchemaCanvas key={JSON.stringify([rootId, depth, targetId])} snapshot={local.snapshot} query="" selectedTable={localSelection && local.snapshot.schemas.some((s) => s.tables.includes(localSelection)) ? localSelection : undefined} onSelectTable={setLocalSelection} semantics={localSemantics} platform={platform} runtimeKind={desktop ? "desktop" : "web"} canvasSettings={settings.app.canvas} temporaryViewLabel="Business discovery · temporary local view; full model layout is preserved." /></div> : <div className="discovery-map-empty"><h3>A small map around your question</h3><p>Expand a candidate’s relationships to inspect one or two hops locally.</p></div>}
        {local && local.omitted > 0 ? <p>{local.omitted} neighborhood tables omitted from the 100-table local view. The selected path is kept complete.</p> : null}
        <section className="discovery-path" aria-label="Known relationship path">
          <h3>Known structural path</h3>
          {target && root && !path ? <p>No known relationship path in the current {depth}-hop range. This does not prove the tables are unrelated in the business.</p> : null}
          {path ? <><p>{path.tables.map(objectLabel).join(" ↔ ")}</p><ol>{path.relationships.map((edge) => <li key={edge.id}><strong>{edge.kind === "physical" ? "Physical FK" : "Confirmed logical relationship · model only"}</strong><ol>{edge.sourceColumns.map((column, i) => <li key={i}>{objectLabel(edge.source)}.{column} → {objectLabel(edge.target)}.{edge.targetColumns[i]}</li>)}</ol></li>)}</ol><p>Arrows show reference direction, not business execution order. Cardinality and business meaning need supporting key, nullability and domain evidence.</p></> : <p>Select a root and destination to compute a path from existing relationships. Unconfirmed naming inferences are excluded from known paths.</p>}
          {graph.gaps.length ? <details><summary>Snapshot information gaps ({graph.gaps.length})</summary><ul>{graph.gaps.map((gap, i) => <li key={i}>{gap}</li>)}</ul></details> : null}
        </section>
      </div>
    </div>
  </section>;
}
