import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { KnowledgeEditor } from "./KnowledgeReview";
import type { DatabaseSnapshot, DomainGroup, EffectiveSettings, NodalStudioPlatform, TableAiEvidence, TableAiPreview, TableAiResult, TableDefinition } from "../platform";

interface Props {
  platform: NodalStudioPlatform; snapshot: DatabaseSnapshot; table: TableDefinition;
  settings: EffectiveSettings; domains: DomainGroup[]; desktop: boolean; active?: boolean;
  onOpenSettings: () => void;
  onLocateEvidence: (evidence: TableAiEvidence, requestId: string) => void;
  onKnowledgeSaved?: () => Promise<void>;
  onTaskChange: (requestId: string | undefined) => void;
}
interface Completed { result: TableAiResult; preview: TableAiPreview; question: string }
type Phase = "idle" | "preparing" | "ready" | "running" | "error" | "cancelled" | "expired";

export function TableAiAssistant(props: Props) {
  const { snapshot, table, settings } = props;
  return <TableSession key={JSON.stringify([snapshot.sourceId, snapshot.id, snapshot.fingerprint, table.key, settings.source, settings.app.privacy.offlineMode, settings.app.general.language])} {...props} />;
}
function TableSession({ platform, snapshot, table, settings, domains, desktop, active = true, onOpenSettings, onLocateEvidence, onTaskChange, onKnowledgeSaved }: Props) {
  const ai = settings.source?.ai;
  const remote = ai?.provider === "openAiCompatible";
  const settingsReady = settings.source?.sourceId === snapshot.sourceId;
  const enabled = desktop && settingsReady && Boolean(ai?.enabled) && !(remote && settings.app.privacy.offlineMode);
  const chinese = settings.app.general.language === "zhCn" || (settings.app.general.language === "system" && navigator.language.toLowerCase().startsWith("zh"));
  const t = (en: string, zh: string) => chinese ? zh : en;
  const questions = [t("What does one row represent?", "这一行代表什么？"), t("How is this table related?", "这张表怎么关联其他表？"), t("Explain a field", "解释一个字段")];
  const scopeLabels = { currentTable: t("Current table", "当前表"), oneHop: t("Table + direct neighbors", "当前表及直接关联表"), domain: t("Selected business domain", "所选业务域") };
  const [question, setQuestion] = useState(questions[0]);
  const [focusColumn, setFocusColumn] = useState("");
  const [domainId, setDomainId] = useState("");
  const [preview, setPreview] = useState<TableAiPreview>();
  const [completed, setCompleted] = useState<Completed>();
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const epoch = useRef(0);
  const pendingId = useRef<string | undefined>(undefined);
  const completedId = useRef<string | undefined>(undefined);
  const busy = useRef(false);
  const resultPanel = useRef<HTMLDivElement>(null);
  const fieldControl = useRef<HTMLSelectElement>(null);
  const options = useRef<HTMLDetailsElement>(null);
  const availableDomains = domains.filter(domain => domain.sourceId === snapshot.sourceId && domain.tableKeys.some(key => key.schema === table.key.schema && key.name === table.key.name));

  const invalidate = useCallback((next: Phase = "idle") => {
    epoch.current++; busy.current = false;
    if (pendingId.current && pendingId.current !== completedId.current) void platform.cancelTableExplanation(pendingId.current).catch(() => undefined);
    pendingId.current = undefined; setPreview(undefined); setError(undefined); setPhase(next);
    if (!completedId.current) onTaskChange(undefined);
  }, [platform, onTaskChange]);
  useEffect(() => () => {
    epoch.current++;
    for (const id of new Set([pendingId.current, completedId.current])) if (id) void platform.cancelTableExplanation(id).catch(() => undefined);
    onTaskChange(undefined);
  }, [platform, onTaskChange]);
  useEffect(() => { if (completed) resultPanel.current?.scrollIntoView?.({ block: "nearest" }); }, [completed]);

  function matchesSettings(candidate: TableAiPreview) {
    return settingsReady && candidate.provider === (remote ? "openai-compatible" : "offline-schema") && candidate.context.scope === ai?.contextScope && (!remote || candidate.model === ai?.model);
  }
  async function prepare() {
    if (busy.current || pendingId.current || !enabled || !active || !question.trim() || (ai?.contextScope === "domain" && !domainId)) return;
    const current = epoch.current; busy.current = true; setPhase("preparing");
    try {
      const next = await platform.prepareTableExplanation({ snapshotId: snapshot.id, target: table.key, question, focusColumn: focusColumn || null, domainId: domainId || null });
      if (current !== epoch.current) { void platform.cancelTableExplanation(next.requestId).catch(() => undefined); return; }
      if (next.sourceId !== snapshot.sourceId || next.snapshotId !== snapshot.id || next.fingerprint !== snapshot.fingerprint || next.context.target.schema !== table.key.schema || next.context.target.name !== table.key.name || next.context.focusColumn !== (focusColumn || null)) {
        void platform.cancelTableExplanation(next.requestId).catch(() => undefined);
        throw new Error("The preview belongs to a different source or target. Prepare a new request.");
      }
      if (!matchesSettings(next)) {
        void platform.cancelTableExplanation(next.requestId).catch(() => undefined);
        throw new Error("AI settings changed. Reload Settings before preparing another preview.");
      }
      if (!Number.isFinite(Date.parse(next.expiresAt)) || Date.parse(next.expiresAt) <= Date.now()) {
        void platform.cancelTableExplanation(next.requestId).catch(() => undefined); invalidate("expired"); return;
      }
      pendingId.current = next.requestId;
      if (!completedId.current) onTaskChange(next.requestId);
      setPreview(next); setPhase("ready");
    } catch (reason) { if (current === epoch.current) { setError(String(reason instanceof Error ? reason.message : reason)); setPhase("error"); } }
    finally { if (current === epoch.current) busy.current = false; }
  }
  const prepareLatest = useEffectEvent(() => { void prepare(); });
  // Preparation is local only. A separate, explicit submit is the only network trigger.
  useEffect(() => {
    const timer = window.setTimeout(prepareLatest, 300);
    return () => { window.clearTimeout(timer); };
  }, [question, focusColumn, domainId, enabled, active, attempt]);
  useEffect(() => {
    if (!preview || (phase !== "ready" && phase !== "running")) return;
    const expire = () => { if (Date.now() >= Date.parse(preview.expiresAt)) invalidate("expired"); };
    const timer = window.setTimeout(expire, Math.max(0, Date.parse(preview.expiresAt) - Date.now()));
    document.addEventListener("visibilitychange", expire); window.addEventListener("focus", expire);
    return () => { clearTimeout(timer); document.removeEventListener("visibilitychange", expire); window.removeEventListener("focus", expire); };
  }, [preview, phase, invalidate]);

  async function run() {
    if (!preview || busy.current || phase !== "ready" || !enabled || !active || !matchesSettings(preview)) return;
    if (Date.now() >= Date.parse(preview.expiresAt)) { invalidate("expired"); return; }
    const current = epoch.current; busy.current = true; setPhase("running"); setError(undefined);
    if (completedId.current) void platform.cancelTableExplanation(completedId.current).catch(() => undefined);
    completedId.current = undefined; setCompleted(undefined); onTaskChange(preview.requestId);
    try {
      const next = await platform.runTableExplanation(preview.requestId);
      if (current !== epoch.current) return;
      if (Date.now() >= Date.parse(preview.expiresAt)) { invalidate("expired"); return; }
      if (next.requestId !== preview.requestId || next.sourceId !== snapshot.sourceId || next.snapshotId !== snapshot.id || next.target.schema !== table.key.schema || next.target.name !== table.key.name || next.provider !== preview.provider || next.model !== preview.model || next.answer.schemaVersion !== 2) throw new Error("The returned explanation does not match this task.");
      completedId.current = next.requestId; pendingId.current = undefined;
      setCompleted({ result: next, preview, question }); setPreview(undefined); setQuestion(""); setPhase("idle");
    } catch (reason) { if (current === epoch.current) { setError(String(reason instanceof Error ? reason.message : reason)); setPhase("error"); } }
    finally { if (current === epoch.current) busy.current = false; }
  }
  function editQuestion(value: string) { invalidate(); setQuestion(value); }
  function evidenceName(e: TableAiEvidence) {
    const kinds: Record<string, string> = { column: t("field", "字段"), primaryKey: t("primary key", "主键"), databaseComment: t("comment", "注释"), table: t("table", "表"), foreignKey: t("foreign key", "外键"), teamStatement: t("team statement", "团队说明"), index: t("index", "索引"), constraint: t("constraint", "约束"), physicalRelationship: t("foreign key", "外键"), logicalRelationship: t("logical relationship", "逻辑关系") };
    const name = e.tableKey.schema === table.key.schema && e.tableKey.name === table.key.name ? e.objectKey.name : `${e.tableKey.schema}.${e.tableKey.name}.${e.objectKey.name}`;
    return `${name} · ${kinds[e.kind] ?? e.kind}`;
  }
  function evidenceList(context: TableAiPreview, ids?: string[], locate = true) {
    return <ul className="ai-readable-evidence">{context.context.evidence.filter(e => !ids || ids.includes(e.id)).map(e => <li key={e.id}>
      {locate ? <button type="button" onClick={() => onLocateEvidence(e, context.requestId)}>{evidenceName(e)}</button> : <strong>{evidenceName(e)}</strong>}
      <span className="ai-policy">{e.kind === "teamStatement" ? t("Confirmed locally; not a database constraint", "本机已确认说明，非数据库约束") : e.kind === "logicalRelationship" ? t("Model relationship; not a database constraint", "模型中的逻辑关系，非数据库约束") : e.kind === "databaseComment" ? t("Database comment; business meaning may need confirmation", "数据库注释，业务含义可能仍需确认") : e.kind === "column" ? t("Captured field structure; comments are not constraints", "已采集的字段结构；字段注释不代表约束") : t("Captured in this snapshot", "采集自当前快照")}</span>
      <details><summary>{t("Captured value", "查看原始依据")}</summary><pre>{e.detail}</pre></details>
    </li>)}</ul>;
  }
  const answer = completed?.result.answer;
  const detailsPreview = preview ?? completed?.preview;
  let destination = preview?.model ?? "";
  if (preview?.endpoint) {
    try { destination = `${new URL(preview.endpoint).hostname} (${preview.model})`; }
    catch { destination = preview.model ?? t("configured provider", "已配置的提供方"); }
  }
  const blocked = !desktop ? t("Available in the desktop app.", "请在桌面应用中使用。") : !settingsReady ? t("AI settings for this source are not loaded.", "当前来源的 AI 设置尚未加载。") : !enabled ? t("Enable AI in Settings to ask about this table.", "在设置中启用 AI，即可询问这张表。") : undefined;
  const status = phase === "preparing" ? t("Preparing this table locally…", "正在本地整理当前表…") : phase === "running" ? t(`Explaining ${table.key.name}…`, `正在解释 ${table.key.name}…`) : phase === "expired" ? t("Preview expired. Refresh before sending.", "发送内容已过期，请刷新后发送。") : phase === "cancelled" ? t("Cancelled. Data already sent cannot be recalled.", "已取消；已经发送的数据无法撤回。") : "";
  const friendlyError = error && (/truncat|output limit|finish_reason|incomplete/i.test(error) ? t("The answer was cut off. Retry or ask a narrower question.", "回答未完成，请重试或缩小问题。") : /structured|evidence|answer limits/i.test(error) ? t("The answer did not pass validation. Please retry.", "回答未通过校验，请重试。") : t("The request could not finish. Review the details or retry.", "请求未完成，请查看详情或重试。"));

  return <section className="ai-assistant table-understanding ai-task-panel" aria-label={t("Single-table understanding", "单表 AI 助手")}>
    <div className="annotation-heading"><h3>{t("Ask about this table", "理解这张表")}</h3><span>{remote ? t("AI", "AI") : t("Local", "本地")}</span></div>
    {blocked ? <div className="inspector-empty-state"><p>{blocked}</p>{desktop ? <button type="button" onClick={onOpenSettings}>{t("Configure AI", "配置 AI")}</button> : null}</div> : <>
      {completed && answer ? <div ref={resultPanel} className="ai-answer" aria-label={t("Answer", "回答")}>
        <p className="ai-asked-question">{completed.question}</p>
        {answer.summary ? <p className="ai-answer-summary">{answer.summary.text}</p> : <p>{t("Local mode shows captured structure. It does not infer business meaning.", "本地模式展示已采集结构，不推断业务含义。")}</p>}
        {answer.interpretations.length ? <ul className="ai-supporting-points">{answer.interpretations.map((claim, index) => <li key={index}>{claim.text}</li>)}</ul> : null}
        {answer.unknowns.length ? <div className="ai-answer-gaps"><strong>{t("What is still needed", "还需确认")}</strong><ul>{answer.unknowns.map((item, index) => <li key={index}>{item}</li>)}</ul></div> : null}
        <details className="ai-answer-evidence"><summary>{t("View supporting evidence", "查看回答依据")}</summary>
          {evidenceList(completed.preview, answer.summary ? [...answer.summary.evidenceIds, ...answer.interpretations.flatMap(claim => claim.evidenceIds)] : undefined)}
        </details>
        {answer.summary && onKnowledgeSaved ? <KnowledgeEditor platform={platform} input={{ snapshotId: snapshot.id, target: table.key, requestId: completed.result.requestId, interpretationIndex: null }} sourceId={snapshot.sourceId} label={t("Draft a table description", "整理成表说明")} chinese={chinese} onSaved={onKnowledgeSaved} /> : null}
      </div> : null}
      <div className="ai-composer">
        <div className="ai-compact-suggestions">{questions.map((text, index) => <button key={text} type="button" onClick={() => { if (index === 2) { if (options.current) options.current.open = true; fieldControl.current?.focus(); } editQuestion(text); }}>{text}</button>)}</div>
        <label className="ai-control">{completed ? t("Ask another question about this table", "继续提问 · 当前表") : t("Question", "问题")}<textarea rows={2} maxLength={2000} value={question} placeholder={t("What would you like to understand?", "想了解这张表的什么？")} onChange={event => editQuestion(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void run(); } }} /></label>
        <details ref={options} className="ai-scope-options"><summary>{scopeLabels[ai?.contextScope ?? "currentTable"]}{focusColumn ? ` · ${focusColumn}` : ""}</summary>
          <label className="ai-control">{t("Focus field", "关注字段")}<select ref={fieldControl} value={focusColumn} onChange={event => { invalidate(); setFocusColumn(event.target.value); }}><option value="">{t("Whole table", "整张表")}</option>{table.columns.map(column => <option key={column.name} value={column.name}>{column.name}</option>)}</select></label>
          <button type="button" onClick={onOpenSettings}>{t("Change allowed scope in Settings", "在设置中调整允许范围")}</button>
        </details>
        {ai?.contextScope === "domain" ? <label className="ai-control">{t("Business domain", "业务域")}<select value={domainId} onChange={event => { invalidate(); setDomainId(event.target.value); }}><option value="">{t("Choose one domain…", "选择一个业务域…")}</option>{availableDomains.map(domain => <option key={domain.id} value={domain.id}>{domain.name}</option>)}</select></label> : null}
        {preview ? <p className="ai-send-summary">{remote ? t(`Send to ${destination}: ${preview.context.tables.length} table(s), your question`, `将向 ${destination} 发送 ${preview.context.tables.length} 张表的结构和你的问题`) : t("Local analysis only; no network request", "仅本地分析，不发送网络请求")}{remote ? ` · ${t("no rows or credentials", "不含业务行或凭据")}` : ""}{remote && ai?.includeComments ? t(" · includes comments", " · 含注释") : ""}{remote && preview.context.evidence.some(e => e.kind === "teamStatement") ? t(" · includes confirmed team statements", " · 含本机已确认团队说明") : ""}</p> : null}
        <div className="ai-actions"><button type="button" className="ds-primary" disabled={phase !== "ready" || !preview} onClick={() => void run()}>{remote ? t("Send and answer", "发送并回答") : t("Show local structure", "查看本地结构")}</button>
          {phase === "preparing" || phase === "ready" || phase === "running" ? <button type="button" onClick={() => invalidate("cancelled")}>{t("Cancel", "取消")}</button> : null}
          {phase === "error" || phase === "expired" || phase === "cancelled" ? <button type="button" onClick={() => { invalidate(); setAttempt(n => n + 1); }}>{t("Refresh request", "重新准备")}</button> : null}
        </div>
        <p role="status" className="ai-policy">{status}</p>
        {error ? <div role="alert"><p>{friendlyError}</p><details><summary>{t("Error details", "错误详情")}</summary><p>{error}</p></details></div> : null}
      </div>
      {detailsPreview ? <details className="ai-request-details"><summary>{t("Request details", "请求详情")}</summary>
        <p>{detailsPreview.model ?? t("Local structure", "本地结构")} · {detailsPreview.endpoint ?? t("No network request", "无网络请求")}</p>
        <p>{scopeLabels[detailsPreview.context.scope]} · {t("Snapshot", "快照")} {snapshot.fingerprint.slice(0, 12)}</p>
        <ul>{detailsPreview.context.tables.map(key => <li key={JSON.stringify(key)}>{key.schema}.{key.name}</li>)}</ul>
        <details><summary>{t("Exact request body (API key excluded)", "完整请求正文（不含密钥）")}</summary><pre>{JSON.stringify(remote ? detailsPreview.requestBody : detailsPreview.context, null, 2)}</pre></details>
        <details><summary>{t("Coverage and limits", "覆盖范围与限制")}</summary><ul>{detailsPreview.context.coverage.map(item => <li key={item}>{item}</li>)}</ul></details>
        <details><summary>{t("All captured evidence", "全部采集依据")}</summary>{evidenceList(detailsPreview, undefined, !completed || detailsPreview.requestId === completed.result.requestId)}</details>
      </details> : null}
    </>}
  </section>;
}
