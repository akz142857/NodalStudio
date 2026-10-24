import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import type { DatabaseSnapshot, DiscoveryInput, DiscoveryPreview, DiscoveryResult, EffectiveSettings, NodalStudioPlatform, QueryExecutionResult, SqlDraft, TableAiEvidence, TableDefinition } from "../platform";
import { QueryDraftAnswer } from "./query/QueryDraftAnswer";
import { objectId, objectLabel } from "../graph/business-discovery";
import { TableStructure } from "./TableInspector";

interface Props {
  platform: NodalStudioPlatform;
  snapshot: DatabaseSnapshot;
  settings: EffectiveSettings;
  input: DiscoveryInput;
  binding: string;
  available: boolean;
  onApplyTerms: (terms: string[]) => void;
  onLocate: (table: TableDefinition) => void;
  onOpenSettings: () => void;
  onUseSql?: (sql: string) => void;
  autoPrepare?: boolean;
  onSqlDraft?: (draft: SqlDraft) => void;
  execution?: { sql: string; result: QueryExecutionResult };
}

/** Key every input and policy dependency, including the local search revision. */
export function DiscoveryAssistant(props: Props) {
  return <DiscoveryRequest key={JSON.stringify([props.input, props.binding, props.snapshot.id, props.snapshot.sourceId, props.snapshot.fingerprint, props.settings.source, props.settings.app.privacy, props.available])} {...props} />;
}
function DiscoveryRequest({ platform, snapshot, settings, input, available, onApplyTerms, onLocate, onOpenSettings, onUseSql, autoPrepare = false, onSqlDraft, execution }: Props) {
  const ai = settings.source?.ai;
  const remote = ai?.provider === "openAiCompatible";
  const enabled = available && settings.source?.sourceId === snapshot.sourceId && !!ai?.enabled && !(remote && settings.app.privacy.offlineMode);
  const [preview, setPreview] = useState<DiscoveryPreview>();
  const [result, setResult] = useState<DiscoveryResult>();
  const [evidence, setEvidence] = useState<TableAiEvidence>();
  const [phase, setPhase] = useState("idle");
  const [error, setError] = useState("");
  const generation = useRef(0); const busy = useRef(false); const request = useRef<string | undefined>(undefined);
  const invalidate = useCallback((next = "idle") => {
    generation.current++; busy.current = false;
    if (request.current) void platform.cancelDiscovery(request.current).catch(() => undefined);
    request.current = undefined; setPreview(undefined); setResult(undefined); setEvidence(undefined); setError(""); setPhase(next);
  }, [platform]);
  useEffect(() => () => {
    generation.current++;
    if (request.current) void platform.cancelDiscovery(request.current).catch(() => undefined);
  }, [platform]);
  useEffect(() => {
    if (!preview || (phase !== "ready" && phase !== "running")) return;
    const expire = () => { if (Date.now() >= Date.parse(preview.expiresAt)) invalidate("expired"); };
    const timer = window.setTimeout(() => invalidate("expired"), Math.max(0, Date.parse(preview.expiresAt) - Date.now()));
    window.addEventListener("focus", expire); document.addEventListener("visibilitychange", expire);
    return () => { window.clearTimeout(timer); window.removeEventListener("focus", expire); document.removeEventListener("visibilitychange", expire); };
  }, [preview, phase, invalidate]);
  async function prepare() {
    if (busy.current || !enabled) return;
    invalidate(); const current = generation.current; busy.current = true; setPhase("preparing");
    try {
      const next = await platform.prepareDiscovery(input);
      if (current !== generation.current) { void platform.cancelDiscovery(next.requestId).catch(() => undefined); return; }
      if (next.sourceId !== snapshot.sourceId || next.snapshotId !== snapshot.id || next.fingerprint !== snapshot.fingerprint || next.context.operation !== input.task.operation || next.context.scope !== ai?.contextScope || next.provider !== (remote ? "openai-compatible" : "offline-schema") || (remote && next.model !== ai?.model)) {
        void platform.cancelDiscovery(next.requestId).catch(() => undefined);
        throw new Error("The preview does not match this task or current settings. Prepare it again.");
      }
      if (input.task.operation === "draftSql" && (next.context.tables.length !== input.task.candidates.length || next.context.tables.some((table) => !input.task.candidates.some((candidate) => objectId(candidate) === objectId(table))))) {
        void platform.cancelDiscovery(next.requestId).catch(() => undefined);
        throw new Error("The SQL preview changed the selected tables. Review a new request.");
      }
      if (!Number.isFinite(Date.parse(next.expiresAt)) || Date.parse(next.expiresAt) <= Date.now()) {
        void platform.cancelDiscovery(next.requestId).catch(() => undefined); invalidate("expired"); return;
      }
      request.current = next.requestId; setPreview(next); setPhase("ready");
    } catch (reason) { if (current === generation.current) { setError(String(reason instanceof Error ? reason.message : reason)); setPhase("error"); } }
    finally { if (current === generation.current) busy.current = false; }
  }
  const prepareAutomatically = useEffectEvent(() => { void prepare(); });
  const cancelAutomatic = useEffectEvent(() => {
    generation.current++; busy.current = false;
    if (request.current) void platform.cancelDiscovery(request.current).catch(() => undefined);
    request.current = undefined;
  });
  useEffect(() => {
    if (!autoPrepare || !enabled) return;
    let active = true;
    queueMicrotask(() => { if (active) prepareAutomatically(); });
    return () => { active = false; cancelAutomatic(); };
  }, [autoPrepare, enabled]);
  async function run() {
    if (!preview || phase !== "ready" || busy.current || !enabled) return;
    if (Date.now() >= Date.parse(preview.expiresAt)) { invalidate("expired"); return; }
    const current = generation.current; busy.current = true; setPhase("running");
    try {
      const next = await platform.runDiscovery(preview.requestId);
      if (current !== generation.current) return;
      if (Date.now() >= Date.parse(preview.expiresAt)) { invalidate("expired"); return; }
      if (next.requestId !== preview.requestId || next.sourceId !== snapshot.sourceId || next.snapshotId !== snapshot.id || next.operation !== input.task.operation || next.provider !== preview.provider || next.model !== preview.model) throw new Error("The returned answer belongs to a different task.");
      setResult(next); setPhase("done");
      if (next.answer.sqlDraft) onSqlDraft?.(next.answer.sqlDraft);
    } catch (reason) { if (current === generation.current) { setError(String(reason instanceof Error ? reason.message : reason)); setPhase("error"); } }
    finally { if (current === generation.current) { busy.current = false; request.current = undefined; } }
  }
  const tableFor = (key: { schema: string; name: string }) => snapshot.schemas.flatMap((s) => s.tables).find((t) => t.key.schema === key.schema && t.key.name === key.name);
  const candidateFor = (id: string) => preview?.context.candidates.find((c) => c.id === id);
  const refs = (ids: string[]) => <span className="ai-evidence-links">{ids.map((id) => {
    const item = preview?.context.evidence.find((e) => e.id === id);
    return item ? <button type="button" key={id} onClick={() => setEvidence(item)} aria-label={`Inspect discovery evidence ${id}`}>{id}</button> : null;
  })}</span>;
  const focusedTable = evidence && tableFor(evidence.tableKey);
  return <section className="ai-assistant discovery-assistant" aria-label="Business discovery AI">
    {input.task.operation !== "draftSql" ? <h3>{input.task.operation === "expand" ? "Expand search terms" : input.task.operation === "rank" ? "Rank permitted candidates" : "Explain the complete path"}</h3> : null}
    {input.task.operation !== "draftSql" ? <p className="ai-policy">{`AI scope: ${ai?.contextScope ?? "currentTable"}. Local search and graph depth do not expand this scope. Each step needs its own preview.`}</p> : null}
    {!available ? <p>AI requires the latest desktop snapshot. Local results remain available.</p> : !enabled ? <button type="button" onClick={onOpenSettings}>Configure in Settings → AI</button> : <div className="ai-actions">
      {!autoPrepare || ["error", "cancelled", "expired"].includes(phase) ? <button type="button" onClick={() => void prepare()} disabled={phase === "preparing" || phase === "running" || !input.task.question.trim()}>{input.task.operation === "draftSql" ? "Review AI request" : "Prepare discovery preview"}</button> : null}
      {["preparing", "ready", "running"].includes(phase) ? <button type="button" onClick={() => invalidate("cancelled")}>Cancel AI step</button> : null}
    </div>}
    <p role="status">{phase === "ready" ? "Preview ready; nothing sent yet." : phase === "running" ? "Waiting for the model…" : phase === "preparing" ? "Preparing permitted context…" : phase === "cancelled" ? "Cancelled. A request already sent cannot be recalled." : phase === "expired" ? "Preview expired. Prepare again before sending." : phase === "done" && input.task.operation === "draftSql" ? result?.answer.sqlDraft?.sql ? "Draft ready to review below." : "More detail is needed. Review the questions below." : ""}</p>
    {error ? <p role="alert">{error}</p> : null}
    {preview ? <section className="ai-preview" aria-label="Discovery request scope">
      {input.task.operation === "draftSql" ? <>
        <div className="query-send-summary"><div><strong>{phase === "done" ? "Request details" : "Ready to generate"}</strong><p>{preview.model ?? preview.provider} · {preview.context.tables.length} {preview.context.tables.length === 1 ? "table" : "tables"} · schema only</p></div>{phase === "ready" && enabled ? <button type="button" onClick={() => void run()}>Generate SQL</button> : null}</div>
        <details><summary>Review what will be sent</summary><p>{preview.endpoint ?? "No network request"}</p><p>Expires {new Date(preview.expiresAt).toLocaleTimeString()}</p><ul>{preview.context.coverage.map((text, i) => <li key={i}>{text}</li>)}</ul><pre>{JSON.stringify(remote ? preview.requestBody : preview.context, null, 2)}</pre></details>
      </> : <>
      <h4>{remote ? "Actual request preview" : "Local context"}</h4>
      <p>{preview.model ?? preview.provider} · {preview.endpoint ?? "No network request"}</p>
      <p>{preview.context.tables.length} tables · {preview.context.evidence.length} evidence items · expires {new Date(preview.expiresAt).toLocaleTimeString()}</p>
      <ul>{preview.context.tables.map((key) => <li key={objectId(key)}>{objectLabel(key)}</li>)}</ul>
      <details><summary>View exact request body (API key excluded)</summary><pre>{JSON.stringify(remote ? preview.requestBody : preview.context, null, 2)}</pre></details>
      <ul>{preview.context.coverage.map((text, i) => <li key={i}>{text}</li>)}</ul>
      {phase === "ready" && enabled ? <button type="button" onClick={() => void run()}>{remote ? "Send this discovery request" : "Show local limitations"}</button> : null}
      </>}
    </section> : null}
    {result && preview ? <section className="ai-result" aria-label="Discovery answer">
      <h4>{input.task.operation === "draftSql" ? "Review your query draft" : "Model suggestions · unverified"}</h4>
      {result.answer.sqlDraft ? <QueryDraftAnswer draft={result.answer.sqlDraft} disabled={!enabled} onUseSql={onUseSql} result={execution && execution.sql.trim() === result.answer.sqlDraft.sql?.trim() ? execution.result : undefined} /> : null}
      {result.answer.terms.length ? <><p>{result.answer.terms.join(" · ")}</p><button type="button" onClick={() => onApplyTerms(result.answer.terms)}>Apply terms to local search</button></> : null}
      {result.answer.meanings.map((meaning) => <button type="button" key={meaning.label} onClick={() => onApplyTerms(meaning.terms)}>{meaning.label} · search locally</button>)}
      {input.task.operation === "rank" ? <p>AI order covers only the candidates below. All other results keep their local order; this is not a whole-database ranking.</p> : null}
      <ol>{result.answer.rankings.map((ranking) => {
        const candidate = candidateFor(ranking.candidateId); const table = candidate && tableFor(candidate.tableKey);
        return table ? <li key={ranking.candidateId}><button type="button" onClick={() => onLocate(table)}>{objectLabel(table.key)}</button><p>{ranking.reason}</p>{refs(ranking.evidenceIds)}</li> : null;
      })}</ol>
      {result.answer.interpretations.map((claim, i) => <div key={i}><p>{claim.text}</p>{refs(claim.evidenceIds)}</div>)}
      {result.answer.readingOrder.length ? <><h4>Suggested reading order · not execution order</h4><ol>{result.answer.readingOrder.map((id) => {
        const candidate = candidateFor(id); const table = candidate && tableFor(candidate.tableKey);
        return table ? <li key={id}><button type="button" onClick={() => onLocate(table)}>{objectLabel(table.key)}</button></li> : null;
      })}</ol></> : null}
      {result.answer.unknowns.length ? <><h4>Still to confirm</h4><ul>{result.answer.unknowns.map((item, i) => <li key={i}>{item}</li>)}</ul></> : null}
    </section> : null}
    {evidence && focusedTable ? <section className="discovery-evidence" aria-label="Located discovery evidence"><button type="button" onClick={() => setEvidence(undefined)}>Close evidence</button><h4>{evidence.label}</h4><p>{evidence.kind} · Snapshot {snapshot.fingerprint.slice(0, 12)}</p><pre>{evidence.detail}</pre><TableStructure table={focusedTable} focusedEvidence={evidence} /></section> : null}
  </section>;
}
