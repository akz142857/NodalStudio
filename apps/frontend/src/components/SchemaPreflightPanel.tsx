import { useEffect, useMemo, useState } from "react";
import type { DatabaseSnapshot, TableDefinition } from "../platform";
import { runSchemaPreflight, type PreflightFinding, type PreflightOutcome, type PreflightReport } from "../preflight/schema-preflight";
import { findingReview, loadPreflightReviews, reviewEvidence, savePreflightReviews, type PreflightReviews } from "../preflight/preflight-reviews";
import { OperationFeedback } from "./OperationFeedback";

const outcomeLabels: Record<PreflightOutcome, string> = { design: "Design suggestion", suspected: "Suspected issue", insufficient: "Information gap", style: "Style hint" };
interface Run { snapshot: DatabaseSnapshot; names: boolean; revision: number; report?: PreflightReport; error?: string; duration: number }
export function SchemaPreflightPanel({ snapshot, onClose, onLocate }: {
  snapshot: DatabaseSnapshot;
  onClose: () => void;
  onLocate: (key: TableDefinition["key"]) => void;
}) {
  const [names, setNames] = useState(false);
  const [revision, setRevision] = useState(0);
  const [run, setRun] = useState<Run>();
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(100);
  const [ruleFilter, setRuleFilter] = useState("");
  const [outcomeFilter, setOutcomeFilter] = useState("");
  const [showIgnored, setShowIgnored] = useState(false);
  const [reviewReload, setReviewReload] = useState(0);
  const reviewScope = JSON.stringify([snapshot.sourceId, snapshot.fingerprint]);
  const loadedReviews = useMemo(() => {
    try { return { scope: reviewScope, revision: reviewReload, reviews: loadPreflightReviews(snapshot), error: "" }; }
    catch (reason) { return { scope: reviewScope, revision: reviewReload, reviews: {}, error: `Review notes could not be loaded: ${String(reason)}` }; }
  }, [snapshot, reviewScope, reviewReload]);
  const [editedReviews, setEditedReviews] = useState<{ scope: string; reviews: PreflightReviews }>();
  const [reviewFeedback, setReviewFeedback] = useState<{ scope: string; error?: string; message?: string }>();
  const reviews = editedReviews?.scope === reviewScope ? editedReviews.reviews : loadedReviews.reviews;
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const started = performance.now();
      try { setRun({ snapshot, names, revision, report: runSchemaPreflight(snapshot, { nameSpaces: names }), duration: performance.now() - started }); }
      catch (reason) { setRun({ snapshot, names, revision, error: reason instanceof Error ? reason.message : String(reason), duration: performance.now() - started }); }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [snapshot, names, revision]);
  const current = run?.snapshot === snapshot && run.names === names && run.revision === revision ? run : undefined;
  const report = current?.report;
  const ignoredCount = report?.findings.filter((finding) => findingReview(finding, reviews)).length ?? 0;
  const visible = report?.findings.filter((finding) => {
    if (!showIgnored && findingReview(finding, reviews)) return false;
    if (ruleFilter && finding.ruleId !== ruleFilter) return false;
    if (outcomeFilter && finding.outcome !== outcomeFilter) return false;
    return [finding.ruleId, finding.objectKey.schema, finding.objectKey.name, finding.message, ...finding.evidence].join(" ").toLowerCase().includes(query.trim().toLowerCase());
  }) ?? [];
  const persistReviews = (next: PreflightReviews) => {
    setEditedReviews({ scope: reviewScope, reviews: next });
    try {
      savePreflightReviews(snapshot, next);
      setReviewFeedback({ scope: reviewScope, message: "Review notes saved on this device for this source and snapshot fingerprint." });
    } catch (reason) {
      setReviewFeedback({ scope: reviewScope, error: `Review notes remain in this session. Save failed: ${String(reason)}` });
    }
  };
  const updateReview = (finding: PreflightFinding, reason?: string) => {
    const next = { ...reviews };
    if (reason?.trim()) next[finding.id] = { reason: reason.trim().slice(0, 500), evidence: reviewEvidence(finding) };
    else delete next[finding.id];
    persistReviews(next);
  };

  return <section className="schema-preflight" aria-label="Structure preflight">
    <header className="preflight-header"><div><h2>Structure preflight</h2><p>{snapshot.database.name} · {report?.dialect ?? (snapshot.database.databaseType === "mySql" ? "MySQL" : snapshot.database.databaseType === "postgreSql" ? "PostgreSQL" : "Unsupported dialect")} {snapshot.database.version}</p></div>
      <div><button type="button" disabled={!current} onClick={() => setRevision((value) => value + 1)}>Run checks again</button><button type="button" onClick={onClose}>Close preflight</button></div></header>
    <p>Entire loaded snapshot · Captured {snapshot.capturedAt} · Fingerprint {snapshot.fingerprint.slice(0, 12)}. Diagram filters, comparison ghosts and business semantics are excluded.</p>
    <p>Checks use captured metadata only. Findings do not guarantee database validity, row integrity or complete FK compatibility. No database queries or repair SQL are run.</p>
    <label className="preflight-style"><input type="checkbox" checked={names} onChange={(event) => setNames(event.target.checked)} />Include whitespace naming hints (quoted names are legal)</label>
    <OperationFeedback label="Structure checks" state={!current ? { phase: "running", summary: "Running structure checks…" } : current.error ? { phase: "error", summary: "Preflight failed.", details: current.error } : report ? { phase: "success", summary: `${report.tableCount} tables · ${report.columnCount} columns · ${report.foreignKeyCount} physical foreign keys · ${report.findings.length} findings (${ignoredCount} ignored) · ${Math.ceil(current.duration)} ms` } : undefined} onRetry={() => setRevision((value) => value + 1)} retryLabel="Retry preflight" />
    {report ? <>
      <details className="preflight-coverage" open><summary>Rule coverage · {report.excludedViewCount} views excluded · FK indexes are outside this version</summary>
        <ul>{report.coverage.map((rule) => <li key={rule.ruleId}><strong>{rule.name}</strong> <span>{rule.status === "checked" ? "Checked available metadata" : rule.status === "partial" ? "Partial" : "Skipped"}</span>
          <p>{rule.checked} checked · {rule.incomplete} incomplete · {rule.skipped} excluded · <code>{rule.ruleId}</code></p><p>{rule.explanation}</p></li>)}</ul>
      </details>
      <div className="preflight-filters">
        <label>Search findings<input type="search" value={query} onChange={(event) => { setQuery(event.target.value); setLimit(100); }} /></label>
        <label>Rule<select value={ruleFilter} onChange={(event) => { setRuleFilter(event.target.value); setLimit(100); }}><option value="">All rules</option>{report.coverage.map((rule) => <option key={rule.ruleId} value={rule.ruleId}>{rule.name}</option>)}</select></label>
        <label>Outcome<select value={outcomeFilter} onChange={(event) => { setOutcomeFilter(event.target.value); setLimit(100); }}><option value="">All outcomes</option>{Object.entries(outcomeLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <label><input type="checkbox" checked={showIgnored} onChange={(event) => { setShowIgnored(event.target.checked); setLimit(100); }} />Show ignored findings</label>
      </div>
      <p>{Math.min(limit, visible.length)} shown of {visible.length} matching · {report.findings.length - ignoredCount} active findings</p>
      {visible.length ? <div className="preflight-findings">{visible.slice(0, limit).map((finding) => <Finding key={finding.id} finding={finding} reason={findingReview(finding, reviews)?.reason} onReview={(reason) => updateReview(finding, reason)} onLocate={onLocate} />)}</div>
        : <p>{report.findings.length ? "No findings match the current filters." : "No findings from the enabled checks. Review rule coverage and information limits above."}</p>}
      {visible.length > limit ? <button type="button" onClick={() => setLimit((value) => value + 100)}>Load 100 more findings</button> : null}
    </> : null}
    <OperationFeedback label="Preflight review notes" state={reviewFeedback?.scope === reviewScope && reviewFeedback.error ? { phase: "error", summary: "Review notes remain in this session.", details: reviewFeedback.error } : reviewFeedback?.scope === reviewScope && reviewFeedback.message ? { phase: "success", summary: reviewFeedback.message } : loadedReviews.error ? { phase: "error", summary: "Review notes could not be loaded. New review notes can still be saved.", details: loadedReviews.error } : undefined}
      onRetry={reviewFeedback?.scope === reviewScope && reviewFeedback.error ? () => persistReviews(reviews) : () => setReviewReload((value) => value + 1)} retryLabel={reviewFeedback?.scope === reviewScope && reviewFeedback.error ? "Retry review save" : "Retry review load"} />
  </section>;
}
function Finding({ finding, reason, onReview, onLocate }: { finding: PreflightFinding; reason?: string; onReview: (reason?: string) => void; onLocate: (key: TableDefinition["key"]) => void }) {
  const [draft, setDraft] = useState("");
  return <article aria-label={`${finding.ruleId}: ${finding.objectKey.schema}.${finding.objectKey.name}`} data-outcome={finding.outcome}>
    <header><strong>{outcomeLabels[finding.outcome]}</strong><code>{finding.ruleId}</code><span>{finding.severity}</span></header>
    <h3>{finding.objectKey.schema}.{finding.objectKey.name}</h3><p>{finding.message}</p>
    <details><summary>Evidence and explanation</summary><ul>{finding.evidence.map((item, index) => <li key={index}>{item}</li>)}</ul><p>{finding.recommendation}</p></details>
    <div className="preflight-object-actions"><button type="button" onClick={() => onLocate(finding.tableKey)}>Locate table</button>{finding.relatedTables.map((key) => <button key={JSON.stringify(key)} type="button" onClick={() => onLocate(key)}>Locate referenced table: {key.schema}.{key.name}</button>)}</div>
    {reason ? <div><p>Ignored: {reason}</p><button type="button" onClick={() => onReview()}>Restore finding</button></div> : <details><summary>Ignore with a reason</summary>
      <label>Ignore reason<textarea value={draft} maxLength={500} onChange={(event) => setDraft(event.target.value)} /></label><button type="button" disabled={!draft.trim()} onClick={() => onReview(draft)}>Ignore finding</button></details>}
  </article>;
}
