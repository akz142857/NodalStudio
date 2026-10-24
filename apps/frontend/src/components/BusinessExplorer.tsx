import { useI18n, useEventTranslator } from "../i18n";
import { useEffect, useMemo, useState } from "react";
import type { DatabaseSnapshot, DiscoveryOperation, EffectiveSettings, NodalStudioPlatform, SemanticBundle, TableDefinition } from "../platform";
import { discoverTables, findKnownPath, knownRelationships, neighborhood, objectId, objectLabel } from "../graph/business-discovery";
import type { QueryDraftSeed } from "./query/QueryDraftPanel";
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
  onDraftQuery?: (seed: Omit<QueryDraftSeed, "id">) => void;
}
export function BusinessExplorer(props: Props) {
  // Changing the model, effective policy or semantic bindings destroys every old task and focus.
  return <ExplorerSession key={JSON.stringify([props.snapshot, props.semantics.domainGroups, props.semantics.logicalRelationships, props.settings.source, props.settings.app.privacy, props.desktop, props.semantics.knowledge])} {...props} />;
}
function ExplorerSession({ snapshot, semantics, settings, platform, desktop, initialTable, sourceLabel, onClose, onLocate, onExplain, onOpenSettings, onDraftQuery }: Props) {
  const { t: bt } = useI18n();
  const eventBt = useEventTranslator(bt);
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
    }).catch(() => { if (active) setLatestError(eventBt("business.unableToVerifyTheLatestSnapshotAIIsUnavailable")); });
    return () => { active = false; };
  }, [desktop, platform, snapshot.id, snapshot.sourceId, eventBt]);
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
  const draftQuery = (table: TableDefinition, withPath = false) => onDraftQuery?.({ sourceId: snapshot.sourceId, snapshotId: snapshot.id, question, root: table.key, tables: withPath && path ? path.tables : [table.key], domainId: aiDomain || null });
  return <section className="business-explorer" aria-label={bt("business.businessTableDiscovery")}>
    <header className="discovery-header"><div><p className="eyebrow">{bt("business.uNDERSTANDADATABASE")}</p><h2>{bt("business.findTablesByBusinessQuestion")}</h2></div><button type="button" onClick={onClose}>{bt("business.backToPreviousView")}</button></header>
    <div className="discovery-workspace">
      <div className="discovery-search-pane">
        <p>{sourceLabel ?? snapshot.database.name} {bt("business.snapshot")} {snapshot.fingerprint.slice(0, 12)}</p>
        <p className="ai-policy">{bt("business.searchTheEntireLoadedSnapshotIndependentOfCanvasFilters")}</p>
        <form onSubmit={(event) => { event.preventDefault(); setSearched(true); setTerms([]); setLimit(5); }}>
          <label className="ai-control">{bt("business.businessQuestion")}<textarea rows={3} maxLength={2000} placeholder={bt("businessExtra.whereShouldIStartExploringOrderAndPaymentStructures")} value={question} onChange={(event) => { setQuestion(event.target.value); setSearched(false); setTerms([]); setLimit(5); }} /></label>
          <label className="ai-control">{bt("business.localSearchDomain")}<select value={localDomain} onChange={(event) => { setLocalDomain(event.target.value); setLimit(5); }}><option value="">{bt("business.entireLoadedSnapshot")}</option>{domains.map((domain) => <option key={domain.id} value={domain.id}>{domain.name}</option>)}</select></label>
          <button type="submit" disabled={!question.trim()}>{bt("business.searchLocally")}</button>
        </form>
        {/account|账户|账号/i.test(question) ? <div className="discovery-ambiguity"><p>{bt("business.accountCanMeanLoginIdentityOrAFinancialAccount")}</p><button type="button" onClick={() => { setQuestion(`${question} login identity 登录`); setSearched(true); setTerms(["login", "identity"]); }}>{bt("business.loginIdentity")}</button><button type="button" onClick={() => { setQuestion(`${question} ledger balance 财务`); setSearched(true); setTerms(["ledger", "balance"]); }}>{bt("business.financialAccount")}</button></div> : null}
        {terms.length ? <p className="ai-policy">{bt("business.appliedSearchTermsHypotheses")} {terms.join(", ")}</p> : null}
        <h3>{bt("business.localCandidates")} {searched ? `· ${candidates.length}` : ""}</h3>
        {searched && !candidates.length ? <p role="status">{bt("business.noReliableLocalCandidatesTryAnotherTermRemoveThe")}</p> : null}
        {candidates.slice(0, limit).map((candidate) => <article className="discovery-candidate" key={objectId(candidate.table.key)}>
          <h4>{objectLabel(candidate.table.key)}</h4><small>{sourceLabel ?? snapshot.database.name} · {candidate.direct ? bt("business.directMetadataMatch") : bt("business.termHypothesisNeedsConfirmation")} {bt("business.localOrder")}</small>
          {candidate.matchingColumns.length ? <p>{bt("business.fieldsDetail")} {candidate.matchingColumns.join(", ")}</p> : null}
          <ul>{candidate.reasons.slice(0, 4).map((reason) => <li key={reason}>{reason}</li>)}</ul>
          <div className="discovery-actions"><button type="button" onClick={() => onLocate(candidate.table)}>{bt("business.locateTable")}</button><button type="button" onClick={() => selectRoot(candidate.table)}>{bt("business.expandRelationships")}</button><button type="button" onClick={() => onExplain(candidate.table)} disabled={!desktop || !latest}>{bt("business.explainThisTable")}</button>{onDraftQuery ? <button type="button" disabled={!question.trim()} onClick={() => draftQuery(candidate.table)}>{bt("business.draftQuery")}</button> : null}</div>
        </article>)}
        {candidates.length > limit ? <button type="button" onClick={() => setLimit((n) => n + 10)}>{bt("business.showMoreCandidates")}</button> : null}
        <section className="discovery-ai-controls">
          <h3>{bt("business.optionalAIStep")}</h3>
          <label className="ai-control">{bt("business.aIOperation")}<select value={operation} onChange={(event) => setOperation(event.target.value as DiscoveryOperation)}><option value="expand">{bt("business.questionOnlyTermExpansion")}</option><option value="rank">{bt("business.rankPermittedCandidates")}</option><option value="path">{bt("business.explainSelectedPath")}</option></select></label>
          {allowed === "domain" && operation !== "expand" ? <label className="ai-control">{bt("business.aISendDomain")}<select value={aiDomain} onChange={(event) => setAiDomain(event.target.value)}><option value="">{bt("business.selectOneDomainExplicitly")}</option>{domains.map((domain) => <option key={domain.id} value={domain.id}>{domain.name}</option>)}</select></label> : null}
          {latestError ? <p role="alert">{latestError}</p> : null}
          {needsScope ? <p>{bt("business.rankingAndPathExplanationNeedOneHopWithAnExplicit")} <button type="button" onClick={onOpenSettings}>{bt("business.changeAISettings")}</button></p> : null}
          {!canStep ? <p>{operation === "rank" ? bt("business.runLocalSearchBeforeRankingCandidates") : bt("business.selectTwoTablesWithAKnownPathBeforeExplaining")}</p> : null}
          {canStep && !needsScope ? <DiscoveryAssistant platform={platform} snapshot={snapshot} settings={settings} input={input} binding={JSON.stringify([localDomain, terms, depth, rootId, targetId, semantics.domainGroups, semantics.logicalRelationships, semantics.knowledge])} available={desktop && latest} onApplyTerms={(next) => { setTerms(next); setSearched(true); setLimit(5); }} onLocate={onLocate} onOpenSettings={onOpenSettings} /> : null}
          {candidates.length > 100 && operation === "rank" ? <p>{bt("business.onlyTheFirst100LocalCandidatesAreSubmittedFor")}</p> : null}
        </section>
      </div>
      <div className="discovery-map-pane">
        <div className="discovery-map-controls">
          <label className="ai-control">{bt("business.explicitRootTable")}<select value={rootId} onChange={(event) => { setRootId(event.target.value); setLocalSelection(tables.find((t) => objectId(t.key) === event.target.value)); setTargetId(""); setDepth(1); }}><option value="">{bt("business.selectARoot")}</option>{tables.map((table) => <option key={objectId(table.key)} value={objectId(table.key)}>{objectLabel(table.key)}</option>)}</select></label>
          <label className="ai-control">{bt("business.localGraphDepth")}<select value={depth} onChange={(event) => setDepth(Number(event.target.value))}><option value={1}>{bt("business.oneHop")}</option><option value={2}>{bt("business.twoHops")}</option></select></label>
          <label className="ai-control">{bt("business.pathDestination")}<select value={targetId} onChange={(event) => setTargetId(event.target.value)} disabled={!root}><option value="">{bt("business.selectADestination")}</option>{tables.filter((table) => objectId(table.key) !== rootId).map((table) => <option key={objectId(table.key)} value={objectId(table.key)}>{objectLabel(table.key)}</option>)}</select></label>
          <p className="ai-policy">{bt("business.temporaryLocalViewFullModelLayoutAndSelectionAre")}</p>
        </div>
        {local ? <div className="discovery-local-canvas"><SchemaCanvas key={JSON.stringify([rootId, depth, targetId])} snapshot={local.snapshot} query="" selectedTable={localSelection && local.snapshot.schemas.some((s) => s.tables.includes(localSelection)) ? localSelection : undefined} onSelectTable={setLocalSelection} semantics={localSemantics} platform={platform} runtimeKind={desktop ? "desktop" : "web"} canvasSettings={settings.app.canvas} temporaryViewKind="discovery" temporaryViewLabel={bt("businessExtra.discoveryTemporaryView")} /></div> : <div className="discovery-map-empty"><h3>{bt("business.aSmallMapAroundYourQuestion")}</h3><p>{bt("business.expandACandidateSRelationshipsToInspectOneOr")}</p></div>}
        {local && local.omitted > 0 ? <p>{local.omitted} {bt("business.neighborhoodTablesOmittedFromThe100TableLocalView")}</p> : null}
        <section className="discovery-path" aria-label={bt("business.knownRelationshipPath")}>
          <h3>{bt("business.knownStructuralPath")}</h3>{onDraftQuery && root ? <button type="button" disabled={!question.trim()} onClick={() => draftQuery(root, true)}>{bt("business.draftQueryWithThisContext")}</button> : null}
          {target && root && !path ? <p>{bt("business.noKnownRelationshipPathInTheCurrent")} {depth}{bt("business.hopRangeThisDoesNotProveTheTablesAre")}</p> : null}
          {path ? <><p>{path.tables.map(objectLabel).join(" ↔ ")}</p><ol>{path.relationships.map((edge) => <li key={edge.id}><strong>{edge.kind === "physical" ? bt("business.physicalFK") : bt("business.confirmedLogicalRelationshipModelOnly")}</strong><ol>{edge.sourceColumns.map((column, i) => <li key={i}>{objectLabel(edge.source)}.{column} → {objectLabel(edge.target)}.{edge.targetColumns[i]}</li>)}</ol></li>)}</ol><p>{bt("business.arrowsShowReferenceDirectionNotBusinessExecutionOrderCardinality")}</p></> : <p>{bt("business.selectARootAndDestinationToComputeAPath")}</p>}
          {graph.gaps.length ? <details><summary>{bt("business.snapshotInformationGaps")}{graph.gaps.length})</summary><ul>{graph.gaps.map((gap, i) => <li key={i}>{gap}</li>)}</ul></details> : null}
        </section>
      </div>
    </div>
  </section>;
}
