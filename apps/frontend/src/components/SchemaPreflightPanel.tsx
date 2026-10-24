import { translateUiLabel } from "../i18n/business-labels";
import { useI18n } from "../i18n";
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
  const { t: bt } = useI18n();
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
    catch (reason) { return { scope: reviewScope, revision: reviewReload, reviews: {}, error: bt("business.reviewNotesCouldNotBeLoaded", { value0: String(reason) }) }; }
  }, [snapshot, reviewScope, reviewReload, bt]);
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
      setReviewFeedback({ scope: reviewScope, message: bt("business.reviewNotesSavedOnThisDeviceForThisSource") });
    } catch (reason) {
      setReviewFeedback({ scope: reviewScope, error: bt("business.reviewNotesRemainInThisSessionSaveFailed", { value0: String(reason) }) });
    }
  };
  const updateReview = (finding: PreflightFinding, reason?: string) => {
    const next = { ...reviews };
    if (reason?.trim()) next[finding.id] = { reason: reason.trim().slice(0, 500), evidence: reviewEvidence(finding) };
    else delete next[finding.id];
    persistReviews(next);
  };

  return <section className="schema-preflight" aria-label={bt("business.structurePreflight")}>
    <header className="preflight-header"><div><h2>{bt("business.structurePreflight")}</h2><p>{snapshot.database.name} · {report?.dialect ?? (snapshot.database.databaseType === "mySql" ? "MySQL" : snapshot.database.databaseType === "postgreSql" ? "PostgreSQL" : bt("business.unsupportedDialect"))} {snapshot.database.version}</p></div>
      <div><button type="button" disabled={!current} onClick={() => setRevision((value) => value + 1)}>{bt("business.runChecksAgain")}</button><button type="button" onClick={onClose}>{bt("business.closePreflight")}</button></div></header>
    <p>{bt("business.entireLoadedSnapshotCaptured")} {snapshot.capturedAt} {bt("business.fingerprintDetailDetail")} {snapshot.fingerprint.slice(0, 12)}{bt("businessExtra.diagramFiltersComparisonGhostsAndBusinessSemanticsAreExcluded")}</p>
    <p>{bt("business.checksUseCapturedMetadataOnlyFindingsDoNotGuarantee")}</p>
    <label className="preflight-style"><input type="checkbox" checked={names} onChange={(event) => setNames(event.target.checked)} />{bt("business.includeWhitespaceNamingHintsQuotedNamesAreLegal")}</label>
    <OperationFeedback label={bt("business.structureChecks")} state={!current ? { phase: "running", summary: bt("business.runningStructureChecks") } : current.error ? { phase: "error", summary: bt("business.preflightFailed"), details: current.error } : report ? { phase: "success", summary: bt("business.tablesColumnsPhysicalForeignKeysFindingsIgnoredMs", { value0: report.tableCount, value1: report.columnCount, value2: report.foreignKeyCount, value3: report.findings.length, value4: ignoredCount, value5: Math.ceil(current.duration) }) } : undefined} onRetry={() => setRevision((value) => value + 1)} retryLabel={bt("business.retryPreflight")} />
    {report ? <>
      <details className="preflight-coverage" open><summary>{bt("business.ruleCoverage")} {report.excludedViewCount} {bt("business.viewsExcludedFKIndexesAreOutsideThisVersion")}</summary>
        <ul>{report.coverage.map((rule) => <li key={rule.ruleId}><strong>{rule.name}</strong> <span>{rule.status === "checked" ? bt("business.checkedAvailableMetadata") : rule.status === "partial" ? bt("business.partial") : bt("business.skipped")}</span>
          <p>{rule.checked} {bt("business.checked")} {rule.incomplete} {bt("business.incomplete")} {rule.skipped} {bt("business.excluded")} <code>{rule.ruleId}</code></p><p>{rule.explanation}</p></li>)}</ul>
      </details>
      <div className="preflight-filters">
        <label>{bt("business.searchFindings")}<input type="search" value={query} onChange={(event) => { setQuery(event.target.value); setLimit(100); }} /></label>
        <label>{bt("business.rule")}<select value={ruleFilter} onChange={(event) => { setRuleFilter(event.target.value); setLimit(100); }}><option value="">{bt("business.allRules")}</option>{report.coverage.map((rule) => <option key={rule.ruleId} value={rule.ruleId}>{rule.name}</option>)}</select></label>
        <label>{bt("business.outcome")}<select value={outcomeFilter} onChange={(event) => { setOutcomeFilter(event.target.value); setLimit(100); }}><option value="">{bt("business.allOutcomes")}</option>{Object.entries(outcomeLabels).map(([key, label]) => <option key={key} value={key}>{translateUiLabel(label, bt)}</option>)}</select></label>
        <label><input type="checkbox" checked={showIgnored} onChange={(event) => { setShowIgnored(event.target.checked); setLimit(100); }} />{bt("business.showIgnoredFindings")}</label>
      </div>
      <p>{Math.min(limit, visible.length)} {bt("business.shownOf")} {visible.length} {bt("business.matching")} {report.findings.length - ignoredCount} {bt("business.activeFindings")}</p>
      {visible.length ? <div className="preflight-findings">{visible.slice(0, limit).map((finding) => <Finding key={finding.id} finding={finding} reason={findingReview(finding, reviews)?.reason} onReview={(reason) => updateReview(finding, reason)} onLocate={onLocate} />)}</div>
        : <p>{report.findings.length ? bt("business.noFindingsMatchTheCurrentFilters") : bt("business.noFindingsFromTheEnabledChecksReviewRuleCoverage")}</p>}
      {visible.length > limit ? <button type="button" onClick={() => setLimit((value) => value + 100)}>{bt("business.load100MoreFindings")}</button> : null}
    </> : null}
    <OperationFeedback label={bt("business.preflightReviewNotes")} state={reviewFeedback?.scope === reviewScope && reviewFeedback.error ? { phase: "error", summary: bt("business.reviewNotesRemainInThisSession"), details: reviewFeedback.error } : reviewFeedback?.scope === reviewScope && reviewFeedback.message ? { phase: "success", summary: reviewFeedback.message } : loadedReviews.error ? { phase: "error", summary: bt("business.reviewNotesCouldNotBeLoadedNewReviewNotes"), details: loadedReviews.error } : undefined}
      onRetry={reviewFeedback?.scope === reviewScope && reviewFeedback.error ? () => persistReviews(reviews) : () => setReviewReload((value) => value + 1)} retryLabel={reviewFeedback?.scope === reviewScope && reviewFeedback.error ? bt("business.retryReviewSave") : bt("business.retryReviewLoad")} />
  </section>;
}
function Finding({ finding, reason, onReview, onLocate }: { finding: PreflightFinding; reason?: string; onReview: (reason?: string) => void; onLocate: (key: TableDefinition["key"]) => void }) {
  const { t: bt } = useI18n();
  const [draft, setDraft] = useState("");
  return <article aria-label={`${finding.ruleId}: ${finding.objectKey.schema}.${finding.objectKey.name}`} data-outcome={finding.outcome}>
    <header><strong>{translateUiLabel(outcomeLabels[finding.outcome], bt)}</strong><code>{finding.ruleId}</code><span>{finding.severity}</span></header>
    <h3>{finding.objectKey.schema}.{finding.objectKey.name}</h3><p>{finding.message}</p>
    <details><summary>{bt("business.evidenceAndExplanation")}</summary><ul>{finding.evidence.map((item, index) => <li key={index}>{item}</li>)}</ul><p>{finding.recommendation}</p></details>
    <div className="preflight-object-actions"><button type="button" onClick={() => onLocate(finding.tableKey)}>{bt("business.locateTable")}</button>{finding.relatedTables.map((key) => <button key={JSON.stringify(key)} type="button" onClick={() => onLocate(key)}>{bt("business.locateReferencedTable")} {key.schema}.{key.name}</button>)}</div>
    {reason ? <div><p>{bt("business.ignored")} {reason}</p><button type="button" onClick={() => onReview()}>{bt("business.restoreFinding")}</button></div> : <details><summary>{bt("business.ignoreWithAReason")}</summary>
      <label>{bt("business.ignoreReason")}<textarea value={draft} maxLength={500} onChange={(event) => setDraft(event.target.value)} /></label><button type="button" disabled={!draft.trim()} onClick={() => onReview(draft)}>{bt("business.ignoreFinding")}</button></details>}
  </article>;
}
