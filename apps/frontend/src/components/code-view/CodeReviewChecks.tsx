import { useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import { Button } from "../../design-system/Button";
import { useI18n } from "../../i18n";
import type { CodeExtension, CodeReviewChanges } from "../../platform/code-review";
import { ActionIcon } from "../ActionIcon";
import { Segmented } from "../Segmented";
import { CodeFileIcon } from "./CodeReviewReader";
import { canCheckWithExtension, isEslintSource, isMarkdown, type CheckFinding } from "./code-review-checks";
import type { CheckedFile, CodeChecks, DisplayedCheckTarget } from "./use-code-review-checks";

export function CodeReviewChecks({ checks, current, changes, extensions, batchUnavailable, locate, search, severity, collapsed, toggleFile, selected, scrollRef }: {
  checks: CodeChecks;
  current?: DisplayedCheckTarget;
  changes?: CodeReviewChanges;
  extensions: CodeExtension[];
  batchUnavailable?: "folder" | "git" | "loading" | "clean";
  locate: (file: CheckedFile, finding: CheckFinding) => void;
  search: string;
  severity: "all" | CheckFinding["severity"];
  collapsed: ReadonlySet<string>;
  toggleFile: (path: string) => void;
  selected?: CheckFinding;
  scrollRef: RefObject<{ runId: number | undefined; top: number }>;
}) {
  const { t } = useI18n();
  const { run, filter, setFilter } = checks;
  const results = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (results.current) results.current.scrollTop = scrollRef.current.runId === run?.id ? scrollRef.current.top : 0;
  }, [run?.id, scrollRef]);
  const files = useMemo(() => run?.files ?? [], [run?.files]);
  const hasDiff = useMemo(() => files.some((file) => file.target.mode === "diff"), [files]);
  const filterMode = !hasDiff ? "all" : filter && filter.id === run?.id ? filter.value : "changed";
  const query = search.toLocaleLowerCase().trim();
  const shown = useMemo(() => files.flatMap((file) => {
    const findings = file.findings.filter((item) =>
      (filterMode === "all" || file.target.mode === "source" || item.location === "changed")
      && (severity === "all" || item.severity === severity)
      && (!query || `${file.target.path} ${file.provider ?? ""} ${item.rule} ${item.message}`.toLocaleLowerCase().includes(query)));
    return findings.length ? [{ file, findings }] : [];
  }), [files, filterMode, query, severity]);
  const { total, retained, checked, skipped, failed, problems, eslintVersions } = useMemo(() => {
    let totalCount = 0;
    let retainedCount = 0;
    let checkedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    const problemFiles: CheckedFile[] = [];
    const versions = new Set<string>();
    for (const file of files) {
      totalCount += file.total;
      retainedCount += file.findings.length;
      if (file.status === "checked") checkedCount += 1;
      else if (file.status === "skipped") skippedCount += 1;
      else if (file.status === "failed" || file.status === "stale") failedCount += 1;
      if (file.reason) problemFiles.push(file);
      if (file.tool) versions.add(file.tool.version);
    }
    return {
      total: totalCount,
      retained: retainedCount,
      checked: checkedCount,
      skipped: skippedCount,
      failed: failedCount,
      problems: problemFiles,
      eslintVersions: [...versions],
    };
  }, [files]);
  const running = run?.status === "running";
  const remaining = files.length - checked - skipped - failed;
  const partial = Boolean(skipped || failed || remaining || run?.incompleteChanges || run?.limited);
  const candidates = useMemo(() => changes?.files.filter((file) => file.kind !== "deleted"
    && (isMarkdown(file.path) || (checks.eslintAvailable && isEslintSource(file.path)))).length ?? 0, [changes?.files, checks.eslintAvailable]);
  const consent = checks.consent;
  const singleProblem = run?.scope === "file" ? files[0]?.reason : undefined;
  const reason = run?.reason ?? singleProblem;
  return <div className="code-checks">
    <div className="code-checks-toolbar">
      <Button size="small" variant="secondary" disabled={!current || Boolean(current.problem)}
        title={current?.problem ? t(`codeReview.checks.reason.${current.problem}`) : undefined}
        onClick={() => { if (current) checks.currentFile(current); }}>{t("codeReview.checks.current")}</Button>
      <Button size="small" variant="secondary" disabled={!changes || Boolean(batchUnavailable)}
        title={batchUnavailable ? t(`codeReview.checks.batch.${batchUnavailable}`) : undefined}
        onClick={() => { if (changes) checks.changedFiles(changes); }}>{t("codeReview.checks.changedFiles")}</Button>
      {current && !current.problem && extensions
        .filter((extension) => canCheckWithExtension(extension, current.target.path)).map((extension) =>
          <Button key={extension.id} size="small" variant="secondary" disabled={running}
            onClick={() => checks.currentFile(current, extension)}>{t("codeReview.extensions.run", { name: extension.name })}</Button>)}
      {running && <Button size="small" variant="ghost" onClick={checks.cancel}>{t("codeReview.checks.cancel")}</Button>}
      {run && hasDiff && total > 0 && <Segmented className="code-review-segments" label={t("codeReview.checks.filter")}
        options={[{ value: "changed", label: t("codeReview.checks.changed") }, { value: "all", label: t("codeReview.checks.all") }]}
        value={filterMode} onChange={(value) => setFilter({ id: run.id, value })} />}
      {checks.eslintApproved && <Button size="small" variant="ghost"
        onClick={() => { void checks.revoke().catch(() => {}); }}>{t("codeReview.checks.eslintRevoke")}</Button>}
    </div>
    <div className="code-checks-results" ref={results} onScroll={(event) => {
      scrollRef.current = { runId: run?.id, top: event.currentTarget.scrollTop };
    }}>
    {consent && <section className="code-checks-consent" aria-label={t("codeReview.checks.eslintConsent")}>
      <h4>{t("codeReview.checks.eslintConsent")}</h4>
      <p>{t(consent.tool.extension ? "codeReview.checks.eslintExtensionTrust" : "codeReview.checks.eslintTrust")}</p>
      <dl>
        {consent.tool.extension && <>
          <dt>{t("codeReview.checks.eslintExtensionServer", { version: consent.tool.extension.version })}</dt><dd>{consent.tool.extension.entry}</dd>
        </>}
        <dt>{t("codeReview.checks.eslintTool", { version: consent.tool.version })}</dt><dd>{consent.tool.entry}</dd>
        <dt>Node</dt><dd>{consent.tool.node}</dd>
        <dt>{t("codeReview.checks.eslintConfiguration")}</dt><dd>{consent.tool.config}</dd>
      </dl>
      <div className="code-checks-actions">
        <Button size="small" variant="primary" onClick={() => consent.decide(true)}>{t("codeReview.checks.eslintApprove")}</Button>
        <Button size="small" variant="secondary" onClick={() => consent.decide(false)}>{t("codeReview.checks.eslintSkip")}</Button>
      </div>
    </section>}
    <div className="code-checks-summary">
    {!run && <p>{current?.problem ? t(`codeReview.checks.reason.${current.problem}`)
      : !current ? t("codeReview.checks.selectFile")
        : t(current.target.indexOnly ? "codeReview.checks.index" : "codeReview.checks.workingTree")}</p>}
    {!run && <p>{batchUnavailable ? t(`codeReview.checks.batch.${batchUnavailable}`)
      : t("codeReview.checks.estimate", { candidates, files: changes?.files.length ?? 0 })}</p>}
    {run?.scope === "file" && files[0] && <p className="code-checks-scope" title={files[0].target.path}>{files[0].target.path}</p>}
    <p role="status">{!run ? "" : running ? t("codeReview.checks.running")
      : run.status === "cancelled" ? t("codeReview.checks.cancelled")
        : reason ? t(`codeReview.checks.reason.${reason}`)
          : total === 1 ? t("codeReview.checks.oneFinding") : total ? t("codeReview.checks.findings", { count: total })
            : checked ? t(partial ? "codeReview.checks.partialClean" : "codeReview.checks.clean")
              : failed ? t("codeReview.checks.failed") : t("codeReview.checks.noCandidates")}</p>
    {run?.scope === "changes" && <p>{t("codeReview.checks.coverage", { checked, skipped, failed, remaining })}</p>}
    {run?.version && <p>markdownlint {run.version} · {t(run.configDigest ? "codeReview.checks.projectConfig" : "codeReview.checks.defaultConfig")}</p>}
    {run?.extension && <p>{run.extension.name} {run.extension.version} · VSIX</p>}
    {run?.extensionError && <p role="alert">{run.extensionError}</p>}
    {eslintVersions.length > 0 && <p>ESLint {eslintVersions.join(", ")} · {t("codeReview.checks.eslintProjectRules")}</p>}
    {run?.incompleteChanges && <p>{t("codeReview.checks.limitedChanges")}</p>}
    {run?.limited && <p>{t("codeReview.checks.batchLimit")}</p>}
    {total > retained && <p>{t("codeReview.checks.truncated", { count: retained })}</p>}
    {total > 0 && shown.length === 0 && <p>{t(query || severity !== "all"
      ? "codeReview.checks.noMatches" : filterMode === "changed" ? "codeReview.checks.noChanged" : "codeReview.checks.noMatches")}</p>}
    </div>
    {shown.map(({ file, findings }) => {
      const path = file.target.path;
      const slash = path.lastIndexOf("/");
      const expanded = !collapsed.has(path);
      return <section className="code-checks-file" key={path}>
        <h4><button type="button" className="code-checks-file-toggle" aria-expanded={expanded} title={path} onClick={() => toggleFile(path)}>
          <ActionIcon name={expanded ? "chevronDown" : "chevronRight"} />
          <CodeFileIcon path={path} />
          <strong>{path.slice(slash + 1)}</strong>
          {slash >= 0 && <span className="code-checks-file-directory">{path.slice(0, slash)}</span>}
          <span className="code-checks-file-count">{findings.length}</span>
        </button></h4>
        {expanded && <ul>{findings.map((finding, index) => <li key={index}>
          <button type="button" className="code-checks-finding" disabled={file.status !== "checked" || running}
            aria-current={finding === selected ? "true" : undefined} onClick={() => locate(file, finding)}>
            <span data-severity={finding.severity}><ActionIcon name={finding.severity} />
              <span className="visually-hidden">{t(`codeReview.checks.severity.${finding.severity}`)}</span></span>
            <span className="code-checks-finding-message">{finding.message}</span>
            <span className="code-checks-finding-meta">
              <span>{file.provider} {finding.rule}</span>
              <span>{finding.range ? finding.range.column === undefined
                ? t("codeReview.checks.line", { line: finding.range.line + 1 })
                : t("codeReview.checks.position", { line: finding.range.line + 1, column: finding.range.column + 1 })
                : t("codeReview.checks.fileLevel")}</span>
              {file.target.mode === "diff" && finding.location === "unknown" && <span>{t("codeReview.checks.locationUnknown")}</span>}
            </span>
          </button>
        </li>)}</ul>}
      </section>;
    })}
    {run?.scope === "changes" && problems.length > 0 && <details className="code-checks-coverage">
      <summary>{t("codeReview.checks.coverageDetails")}</summary>
      <ul>{problems.map((file) => <li key={file.target.path}>
        <p title={file.target.path}><strong>{file.target.path}</strong><br /><span>{t(`codeReview.checks.reason.${file.reason!}`)}</span></p>
      </li>)}</ul>
    </details>}
    </div>
  </div>;
}
