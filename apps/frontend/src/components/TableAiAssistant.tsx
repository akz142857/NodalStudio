import { KnowledgeEditor } from "./KnowledgeReview";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DatabaseSnapshot, DomainGroup, EffectiveSettings, NodalStudioPlatform, TableAiEvidence, TableAiPreview, TableAiResult, TableDefinition } from "../platform";

interface Props {
  platform: NodalStudioPlatform;
  snapshot: DatabaseSnapshot;
  table: TableDefinition;
  settings: EffectiveSettings;
  domains: DomainGroup[];
  desktop: boolean;
  onOpenSettings: () => void;
  onLocateEvidence: (evidence: TableAiEvidence, requestId: string) => void;
  onKnowledgeSaved?: () => Promise<void>;
  onTaskChange: (requestId: string | undefined) => void;
}

const QUESTIONS = ["What does one row represent?", "How is this table related to other tables?", "How should I understand these fields?", "What still needs confirmation?"];
const SCOPE_LABELS = { currentTable: "Current table only", oneHop: "Current table + one hop", domain: "One explicitly selected business domain" };

/** Parent keys this task by source/snapshot/target/effective settings and model relationships. */
export function TableAiAssistant({ platform, snapshot, table, settings, domains, desktop, onOpenSettings, onLocateEvidence, onTaskChange, onKnowledgeSaved }: Props) {
  const ai = settings.source?.ai;
  const remote = ai?.provider === "openAiCompatible";
  const settingsReady = settings.source?.sourceId === snapshot.sourceId;
  const enabled = desktop && settingsReady && Boolean(ai?.enabled) && !(remote && settings.app.privacy.offlineMode);
  const [question, setQuestion] = useState(QUESTIONS[0]);
  const [focusColumn, setFocusColumn] = useState("");
  const [domainId, setDomainId] = useState("");
  const [preview, setPreview] = useState<TableAiPreview>();
  const [result, setResult] = useState<TableAiResult>();
  const [phase, setPhase] = useState<"idle" | "preparing" | "ready" | "running" | "done" | "error" | "cancelled" | "expired">("idle");
  const [error, setError] = useState<string>();
  const [visibleFacts, setVisibleFacts] = useState(12);
  const resultPanel = useRef<HTMLDivElement>(null);
  useEffect(() => { if (result) resultPanel.current?.scrollIntoView?.({ block: "nearest" }); }, [result]);
  const epoch = useRef(0);
  const requestId = useRef<string | undefined>(undefined);
  const busy = useRef(false);
  const availableDomains = domains.filter((domain) => domain.sourceId === snapshot.sourceId && domain.tableKeys.some((key) => key.schema === table.key.schema && key.name === table.key.name));

  useEffect(() => () => {
    epoch.current += 1;
    if (requestId.current) void platform.cancelTableExplanation(requestId.current).catch(() => undefined);
    // The parent outlives this keyed task. Drop its evidence even after the
    // request completed, so returning to the same table cannot revive it.
    onTaskChange(undefined);
  }, [platform, onTaskChange]);

  const invalidate = useCallback((nextPhase: "idle" | "cancelled" | "expired" = "idle") => {
    epoch.current += 1;
    busy.current = false;
    if (requestId.current) void platform.cancelTableExplanation(requestId.current).catch(() => undefined);
    requestId.current = undefined;
    setPreview(undefined); setResult(undefined); setError(undefined); setVisibleFacts(12);
    onTaskChange(undefined);
    setPhase(nextPhase);
  }, [platform, onTaskChange]);

  // Background tabs can defer timers; recheck on return and synchronously at send.
  useEffect(() => {
    if (!preview || (phase !== "ready" && phase !== "running")) return;
    const expiresAt = Date.parse(preview.expiresAt);
    const expireIfDue = () => { if (Date.now() >= expiresAt) invalidate("expired"); };
    const timer = window.setTimeout(() => invalidate("expired"), Math.max(0, expiresAt - Date.now()));
    document.addEventListener("visibilitychange", expireIfDue);
    window.addEventListener("focus", expireIfDue);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", expireIfDue);
      window.removeEventListener("focus", expireIfDue);
    };
  }, [preview, phase, invalidate]);

  function matchesSettings(candidate: TableAiPreview) {
    return settingsReady && candidate.provider === (remote ? "openai-compatible" : "offline-schema")
      && candidate.context.scope === ai?.contextScope
      && (!remote || candidate.model === ai?.model);
  }

  async function prepare() {
    if (busy.current || !enabled) return;
    invalidate();
    const current = epoch.current;
    busy.current = true; setPhase("preparing");
    try {
      const next = await platform.prepareTableExplanation({ snapshotId: snapshot.id, target: table.key, question, focusColumn: focusColumn || null, domainId: domainId || null });
      if (current !== epoch.current) { void platform.cancelTableExplanation(next.requestId).catch(() => undefined); return; }
      if (next.sourceId !== snapshot.sourceId || next.snapshotId !== snapshot.id || next.fingerprint !== snapshot.fingerprint || next.context.target.schema !== table.key.schema || next.context.target.name !== table.key.name) {
        void platform.cancelTableExplanation(next.requestId).catch(() => undefined);
        throw new Error("The preview belongs to a different source or target. Prepare a new request.");
      }
      if (!matchesSettings(next)) {
        void platform.cancelTableExplanation(next.requestId).catch(() => undefined);
        throw new Error("AI settings changed. Reload Settings before preparing another preview.");
      }
      if (!Number.isFinite(Date.parse(next.expiresAt)) || Date.parse(next.expiresAt) <= Date.now()) {
        void platform.cancelTableExplanation(next.requestId).catch(() => undefined);
        invalidate("expired");
        return;
      }
      requestId.current = next.requestId;
      onTaskChange(next.requestId);
      setPreview(next); setPhase("ready");
    } catch (reason) {
      if (current === epoch.current) { setError(String(reason instanceof Error ? reason.message : reason)); setPhase("error"); }
    } finally { if (current === epoch.current) busy.current = false; }
  }

  async function run() {
    if (!preview || busy.current || phase !== "ready" || !enabled || !matchesSettings(preview)) return;
    if (Date.now() >= Date.parse(preview.expiresAt)) { invalidate("expired"); return; }
    const current = epoch.current;
    busy.current = true; setPhase("running"); setError(undefined);
    try {
      const next = await platform.runTableExplanation(preview.requestId);
      if (current !== epoch.current) return;
      if (Date.now() >= Date.parse(preview.expiresAt)) { invalidate("expired"); return; }
      if (next.requestId !== preview.requestId || next.sourceId !== snapshot.sourceId || next.snapshotId !== snapshot.id || next.target.schema !== table.key.schema || next.target.name !== table.key.name) throw new Error("The returned explanation does not match this task.");
      setResult(next); setPhase("done");
    } catch (reason) {
      if (current === epoch.current) { setError(String(reason instanceof Error ? reason.message : reason)); setPhase("error"); }
    } finally {
      if (current === epoch.current) { busy.current = false; }
    }
  }

  return <section className="ai-assistant table-understanding" aria-label="Single-table understanding">
    <div className="annotation-heading"><h3>Understand this table</h3><span className="ai-provider-status">{enabled ? remote ? "Remote model" : "Offline structure" : "Off"}</span></div>
    <p className="ai-policy">Snapshot metadata and your question · no automatic row sampling or connection credentials</p>
    <p className="ai-policy">{table.key.schema}.{table.key.name} · Snapshot {snapshot.fingerprint.slice(0, 12)}</p>
    {!desktop ? <p>AI execution requires the desktop app.</p> : !settingsReady ? <p>AI settings for this source are not loaded. Reload them in <button type="button" onClick={onOpenSettings}>Settings → AI</button> before preparing a request.</p> : !enabled ? <button type="button" onClick={onOpenSettings}>Configure in Settings → AI</button> : <>
      <div className="ai-question-presets" aria-label="Suggested questions">{QUESTIONS.map((text) => <button type="button" key={text} onClick={() => { invalidate(); setQuestion(text); }}>{text}</button>)}</div>
      <label className="ai-control">Question<textarea rows={3} maxLength={2000} value={question} onChange={(event) => { invalidate(); setQuestion(event.target.value); }} /></label>
      <label className="ai-control">Focus field<select value={focusColumn} onChange={(event) => { invalidate(); setFocusColumn(event.target.value); }}><option value="">Whole table</option>{table.columns.map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}</select></label>
      <p className="ai-scope"><b>AI scope:</b> {SCOPE_LABELS[ai?.contextScope ?? "currentTable"]} <button type="button" onClick={onOpenSettings}>Change in Settings</button></p>
      {ai?.contextScope === "domain" ? <label className="ai-control">Business domain<select value={domainId} onChange={(event) => { invalidate(); setDomainId(event.target.value); }}><option value="">Select one domain…</option>{availableDomains.map((domain) => <option key={domain.id} value={domain.id}>{domain.name}</option>)}</select><small>Only a domain containing this table can be selected. Domains are never combined.</small></label> : null}
      <p className="ai-policy">Only locally confirmed, current team statements may be included when enabled. Interpretations remain unsaved until you review and confirm an individual draft.</p>
      <div className="ai-actions"><button type="button" onClick={() => void prepare()} disabled={phase === "preparing" || phase === "running" || (ai?.contextScope === "domain" && !domainId)}>{phase === "preparing" ? "Preparing…" : "Prepare request preview"}</button>
        {phase === "preparing" || phase === "running" || phase === "ready" ? <button type="button" onClick={() => invalidate("cancelled")}>Cancel</button> : null}</div>
    </>}
    <p role="status" className="ai-policy">{phase === "expired" ? "Preview expired. Prepare a new preview before sending." : phase === "cancelled" ? "Cancelled. A request already sent cannot be recalled." : phase === "running" ? "Generating explanation…" : phase === "ready" ? "Preview ready. Nothing has been sent to the provider yet." : phase === "done" ? "Explanation complete. Business interpretations remain unverified." : ""}</p>
    {error ? <p role="alert" className="error-message">{error} Prepare a new preview to retry.</p> : null}
    {result && preview ? <div className="ai-result" ref={resultPanel}>
      <h4>Business interpretations · unverified</h4>
      {result.answer.interpretations.length ? result.answer.interpretations.map((claim, index) => <div key={index} className="ai-claim"><p>{claim.text}</p><div className="ai-evidence-links">{claim.evidenceIds.map((id) => {
        const evidence = preview.context.evidence.find((item) => item.id === id);
        return evidence ? <button type="button" key={id} onClick={() => onLocateEvidence(evidence, preview.requestId)} aria-label={`Inspect evidence ${id}`}>{id}</button> : null;
      })}</div>{onKnowledgeSaved && desktop ? <KnowledgeEditor platform={platform} input={{ snapshotId: snapshot.id, target: table.key, requestId: result.requestId, interpretationIndex: index }} sourceId={snapshot.sourceId} label="Generate annotation draft" onSaved={onKnowledgeSaved} /> : null}</div>) : <p>{result.provider === "offline-schema" ? "No business meaning was inferred by the offline provider." : "The supplied evidence did not support a business interpretation."}</p>}
      <h4>Still to confirm</h4><ul>{result.answer.unknowns.map((item, index) => <li key={index}>{item}</li>)}</ul>
      <small>{result.provider}{result.model ? ` · ${result.model}` : ""} · {new Date(result.generatedAt).toLocaleString()}</small>
    </div> : null}
    {preview ? <>
      <section aria-label="AI request scope" className="ai-preview">
        <h4>{preview.provider === "offline-schema" ? "Local context" : "Actual request preview"}</h4>
        <p>{preview.provider === "offline-schema" ? "No network request. Deterministic structural summary only." : `${preview.model} · ${preview.endpoint}`}</p>
        <p>{preview.context.tables.length} tables · {preview.context.evidence.length} evidence items · expires at {new Date(preview.expiresAt).toLocaleTimeString()}</p>
        <p><b>Prepared scope:</b> {SCOPE_LABELS[preview.context.scope]}</p>
        <ul>{preview.context.tables.map((key) => <li key={JSON.stringify(key)}>{key.schema}.{key.name}</li>)}</ul>
        <details><summary>{preview.provider === "openai-compatible" ? "View exact request body (API key excluded)" : "View local evidence context"}</summary><pre>{JSON.stringify(preview.provider === "openai-compatible" ? preview.requestBody : preview.context, null, 2)}</pre></details>
        <details open><summary>Coverage and limits</summary><ul>{preview.context.coverage.map((item) => <li key={item}>{item}</li>)}</ul></details>
        {phase === "ready" && enabled && matchesSettings(preview) ? <button type="button" onClick={() => void run()}>{preview.provider === "openai-compatible" ? "Send this request" : "Show offline explanation"}</button> : null}
      </section>
      {preview.context.evidence.some((e) => e.kind === "teamStatement") ? <section aria-label="Confirmed team statements"><h4>Team statements · confirmed locally, not structural facts</h4>{preview.context.evidence.filter((e) => e.kind === "teamStatement").map((e) => <div key={e.id}><button onClick={() => onLocateEvidence(e, preview.requestId)}>{e.id} · {e.label}</button><pre>{e.detail}</pre></div>)}</section> : null}
      <section aria-label="Structural evidence"><h4>Structural evidence</h4><p className="ai-policy">Read from the snapshot; database comments and model-only relationships are labelled separately.</p>
        <ol className="ai-evidence-list">{preview.context.evidence.filter((item) => item.kind !== "teamStatement").slice(0, visibleFacts).map((evidence) => <li key={evidence.id}><span className="ai-evidence-kind">{evidence.kind}</span><button type="button" onClick={() => onLocateEvidence(evidence, preview.requestId)} aria-label={`Locate evidence ${evidence.id}: ${evidence.label}`}>{evidence.id} · {evidence.label}</button><details><summary>View captured value</summary><pre>{evidence.detail}</pre></details></li>)}</ol>
        {visibleFacts < preview.context.evidence.filter((item) => item.kind !== "teamStatement").length ? <button type="button" onClick={() => setVisibleFacts((n) => n + 20)}>Show more evidence</button> : null}
      </section>
    </> : null}

  </section>;
}
