import { createPortal } from "react-dom";
import { Button } from "../design-system/Button";
import { Segmented } from "./Segmented";
import { preflightText } from "../preflight/preflight-text";
import "./schema-preflight.css";
import { translateUiLabel } from "../i18n/business-labels";
import { useI18n } from "../i18n";
import { useEffect, useMemo, useState } from "react";
import type { DatabaseSnapshot, TableDefinition } from "../platform";
import { runSchemaPreflight, type PreflightFinding, type PreflightOutcome, type PreflightReport } from "../preflight/schema-preflight";
import { findingReview, loadPreflightReviews, reviewEvidence, savePreflightReviews, type PreflightReviews } from "../preflight/preflight-reviews";
import { OperationFeedback } from "./OperationFeedback";

const outcomeLabels: Record<PreflightOutcome, string> = { design: "Design suggestion", suspected: "Suspected issue", insufficient: "Information gap", style: "Style hint" };
interface Run { snapshot: DatabaseSnapshot; names: boolean; revision: number; report?: PreflightReport; error?: string; duration: number }
export function SchemaPreflightPanel({ snapshot, onClose, onLocate, active = true, detailHost }: {
  active?: boolean;
  detailHost?: HTMLElement | null;
  snapshot: DatabaseSnapshot;
  onClose: () => void;
  onLocate: (key: TableDefinition["key"]) => void;
}) {
  const { t: bt } = useI18n();
  const [tab, setTab] = useState<"findings" | "coverage">("findings");
  const [selectedId, setSelectedId] = useState<string>();
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
    return [finding.ruleId, finding.objectKey.schema, finding.objectKey.name, finding.message, preflightText(finding.message, bt), ...finding.evidence].join(" ").toLowerCase().includes(query.trim().toLowerCase());
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

  const selected = visible.find(finding => finding.id === selectedId) ?? visible[0];
  const detail = <div className="preflight-detail ds-surface" hidden={!active}>
    <h2>{bt("preflight.detail")}</h2>
    {tab === "findings" && selected ? <Finding key={selected.id} finding={selected} reason={findingReview(selected, reviews)?.reason} onReview={reason => updateReview(selected, reason)} onLocate={onLocate} /> : <p>{tab === "coverage" ? bt("business.checksUseCapturedMetadataOnlyFindingsDoNotGuarantee") : bt("preflight.select")}</p>}
  </div>;
  return <section className="schema-preflight ds-surface" hidden={!active} aria-label={bt("business.structurePreflight")}>
    <header className="preflight-header"><div><h2>{bt("business.structurePreflight")}</h2><p>{snapshot.database.name} · {report?.dialect ?? snapshot.database.databaseType} {snapshot.database.version}</p><p>{bt("preflight.scope")}</p></div>
      <div><Button onClick={onClose}>{bt("preflight.back")}</Button><Button disabled={!current} onClick={() => setRevision(value => value + 1)}>{bt("business.runChecksAgain")}</Button></div></header>
    <div className="preflight-toolbar">
      <Segmented label={bt("preflight.views")} value={tab} onChange={setTab} options={[{value:"findings",label:bt("preflight.findings")},{value:"coverage",label:bt("preflight.coverage")}]} />
      <label className="preflight-style"><input type="checkbox" checked={names} onChange={event => setNames(event.target.checked)} />{bt("business.includeWhitespaceNamingHintsQuotedNamesAreLegal")}</label>
    </div>
    <OperationFeedback label={bt("business.structureChecks")} state={!current ? { phase: "running", summary: bt("business.runningStructureChecks") } : current.error ? { phase: "error", summary: bt("business.preflightFailed"), details: current.error } : report ? { phase: "success", summary: bt("business.tablesColumnsPhysicalForeignKeysFindingsIgnoredMs", { value0: report.tableCount, value1: report.columnCount, value2: report.foreignKeyCount, value3: report.findings.length, value4: ignoredCount, value5: Math.ceil(current.duration) }) } : undefined} onRetry={() => setRevision(value => value + 1)} retryLabel={bt("business.retryPreflight")} />
    {report ? <>
      <div className="preflight-summary">{Object.entries(outcomeLabels).map(([key,label]) => <Button key={key} aria-pressed={outcomeFilter === key} onClick={() => {setTab("findings");setOutcomeFilter(outcomeFilter === key ? "" : key);setLimit(100);}}>{translateUiLabel(label,bt)} <strong>{report.findings.filter(finding => finding.outcome === key && !findingReview(finding,reviews)).length}</strong></Button>)}</div>
      <div className="preflight-scroll" hidden={tab !== "coverage"}>
        <p>{report.excludedViewCount} {bt("business.viewsExcludedFKIndexesAreOutsideThisVersion")}</p>
        <div className="preflight-coverage">{report.coverage.map(rule => <details key={rule.ruleId}><summary><strong>{preflightText(rule.name,bt)}</strong><span>{rule.status === "checked" ? bt("business.checkedAvailableMetadata") : rule.status === "partial" ? bt("business.partial") : bt("business.skipped")}</span></summary><p>{bt("preflight.coverageCounts",rule)}</p><p>{preflightText(rule.explanation,bt)}</p><code>{rule.ruleId}</code></details>)}</div>
      </div>
      <div className="preflight-results" hidden={tab !== "findings"}>
        <div className="preflight-filters">
          <label>{bt("business.searchFindings")}<input type="search" value={query} onChange={event => {setQuery(event.target.value);setLimit(100);}} /></label>
          <label>{bt("business.rule")}<select value={ruleFilter} onChange={event => {setRuleFilter(event.target.value);setLimit(100);}}><option value="">{bt("business.allRules")}</option>{report.coverage.map(rule => <option key={rule.ruleId} value={rule.ruleId}>{preflightText(rule.name,bt)}</option>)}</select></label>
          <label>{bt("business.outcome")}<select value={outcomeFilter} onChange={event => {setOutcomeFilter(event.target.value);setLimit(100);}}><option value="">{bt("business.allOutcomes")}</option>{Object.entries(outcomeLabels).map(([key,label]) => <option key={key} value={key}>{translateUiLabel(label,bt)}</option>)}</select></label>
          <label className="preflight-style"><input type="checkbox" checked={showIgnored} onChange={event => {setShowIgnored(event.target.checked);setLimit(100);}} />{bt("business.showIgnoredFindings")}</label>
        </div>
        <p>{bt("preflight.counts",{count:report.findings.length-ignoredCount,ignored:ignoredCount})} · {visible.length} {bt("business.matching")}</p>
        <div className="preflight-scroll">
          {visible.length ? <div className="preflight-findings">{visible.slice(0,limit).map(finding => <Button className="preflight-finding-row" key={finding.id} aria-pressed={selected?.id === finding.id} onClick={() => setSelectedId(finding.id)}><span>{translateUiLabel(outcomeLabels[finding.outcome],bt)}{findingReview(finding,reviews) ? ` · ${bt("business.ignored")}` : ""}</span><strong>{finding.objectKey.schema}.{finding.objectKey.name}</strong><span>{preflightText(finding.message,bt)}</span></Button>)}</div> : <div className="ds-empty-state"><p>{!report.findings.length ? bt("preflight.empty") : ignoredCount === report.findings.length && !showIgnored && !query && !ruleFilter && !outcomeFilter ? bt("preflight.allIgnored") : bt("business.noFindingsMatchTheCurrentFilters")}</p><Button onClick={() => setTab("coverage")}>{bt("preflight.coverage")}</Button></div>}
          {visible.length > limit ? <Button onClick={() => setLimit(value => value+100)}>{bt("business.load100MoreFindings")}</Button> : null}
        </div>
      </div>
    </> : null}
    {detailHost ? createPortal(detail, detailHost) : detail}
    <OperationFeedback label={bt("business.preflightReviewNotes")} state={reviewFeedback?.scope === reviewScope && reviewFeedback.error ? { phase: "error", summary: bt("business.reviewNotesRemainInThisSession"), details: reviewFeedback.error } : reviewFeedback?.scope === reviewScope && reviewFeedback.message ? { phase: "success", summary: bt("business.reviewNotesSavedOnThisDeviceForThisSource") } : loadedReviews.error ? { phase: "error", summary: bt("business.reviewNotesCouldNotBeLoadedNewReviewNotes"), details: loadedReviews.error } : undefined}
      onRetry={reviewFeedback?.scope === reviewScope && reviewFeedback.error ? () => persistReviews(reviews) : () => setReviewReload((value) => value + 1)} retryLabel={reviewFeedback?.scope === reviewScope && reviewFeedback.error ? bt("business.retryReviewSave") : bt("business.retryReviewLoad")} />
  </section>;
}
function Finding({ finding, reason, onReview, onLocate }: { finding: PreflightFinding; reason?: string; onReview: (reason?: string) => void; onLocate: (key: TableDefinition["key"]) => void }) {
  const { t: bt } = useI18n();
  const [draft, setDraft] = useState("");
  return <article aria-label={`${finding.ruleId}: ${finding.objectKey.schema}.${finding.objectKey.name}`} data-outcome={finding.outcome}>
    <header><strong>{translateUiLabel(outcomeLabels[finding.outcome], bt)}</strong><code>{finding.ruleId}</code></header>
    <h3>{finding.objectKey.schema}.{finding.objectKey.name}</h3><p>{preflightText(finding.message,bt)}</p>
    <section><h3>{bt("business.evidenceAndExplanation")}</h3><ul>{finding.evidence.map((item, index) => <li key={index}>{preflightText(item,bt)}</li>)}</ul></section><section><h3>{bt("preflight.recommendation")}</h3><p>{preflightText(finding.recommendation,bt)}</p></section>
    <div className="preflight-object-actions"><Button onClick={() => onLocate(finding.tableKey)}>{bt("business.locateTable")}</Button>{finding.relatedTables.map((key) => <Button key={JSON.stringify(key)} onClick={() => onLocate(key)}>{bt("business.locateReferencedTable")} {key.schema}.{key.name}</Button>)}</div>
    {reason ? <div><p>{bt("business.ignored")} {reason}</p><Button onClick={() => onReview()}>{bt("business.restoreFinding")}</Button></div> : <details><summary>{bt("business.ignoreWithAReason")}</summary>
      <label>{bt("business.ignoreReason")}<textarea value={draft} maxLength={500} onChange={(event) => setDraft(event.target.value)} /></label><Button disabled={!draft.trim()} onClick={() => onReview(draft)}>{bt("business.ignoreFinding")}</Button></details>}
  </article>;
}
