import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n";
import type { NodalStudioPlatform, ObjectKey } from "../../platform";
import type { ChangeReviewEvent, ChangeReviewItem, ChangeReviewRequest, ChangeReviewWorkspace as Workspace } from "../../platform/change-review-types";
import "./change-review.css";

type Props = { platform: NodalStudioPlatform; sourceId: string; revision: string; onChanged: () => Promise<void>; onLocate: (key: ObjectKey) => boolean | void; onRefresh: () => void };
export function ChangeReviewWorkspace(props: Props) { return <ReviewSession key={props.sourceId} {...props} />; }
function ReviewSession({ platform, sourceId, revision, onChanged, onLocate, onRefresh }: Props) {
  const { locale, formatDate } = useI18n();
  const tr = (en: string, zh: string) => locale === "zh-CN" ? zh : en;
  const [data, setData] = useState<Workspace>();
  const [error, setError] = useState(""); const [refreshError, setRefreshError] = useState(false);
  const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(""); const [query, setQuery] = useState("");
  const [tab, setTab] = useState("impact");
  const [cursor, setCursor] = useState<string>(); const [trail, setTrail] = useState<(string | undefined)[]>([]);
  const [checked, setChecked] = useState<string[]>([]); const [loadedKey, setLoadedKey] = useState("");
  const [previewNames, setPreviewNames] = useState<string[]>([]);
  const [restoreText, setRestoreText] = useState("");
  const pageKey = JSON.stringify([tab, query, cursor]);
  const currentPage = loadedKey === pageKey;
  const [drafts, setDrafts] = useState<Record<string, string>>({}); const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<ChangeReviewRequest>(); const [message, setMessage] = useState("");
  const loadedRevision = useRef("");
  const requestEpoch = useRef(0); const mounted = useRef(true); const working = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const reload = useCallback(async () => {
    if (working.current) return;
    const epoch = ++requestEpoch.current;
    try { const next = await platform.getChangeReview(sourceId, { view: tab, search: query, cursor, limit: 50 }); if (mounted.current && epoch === requestEpoch.current) { if (loadedRevision.current !== next.revision) setChecked([]); loadedRevision.current = next.revision; setData(next); setLoadedKey(pageKey); setError(""); } }
    catch (e) { if (mounted.current && epoch === requestEpoch.current) { setError(String(e)); if (cursor && String(e).includes("page expired")) { setCursor(undefined); setTrail([]); setChecked([]); } } }
    finally { if (mounted.current && epoch === requestEpoch.current) setLoading(false); }
  }, [platform, sourceId, tab, query, cursor, pageKey]);
  useEffect(() => { mounted.current = true; queueMicrotask(() => { if (mounted.current) void reload(); }); return () => { mounted.current = false; }; }, [reload, revision]);
  useEffect(() => { const timer = window.setInterval(() => { if (!working.current && !document.hidden) void reload(); }, 10000); return () => clearInterval(timer); }, [reload]);
  useEffect(() => { if (preview && !dialog.current?.open) dialog.current?.showModal(); }, [preview]);
  const labels: Record<string, string> = {
    restore: tr("Restore archived statement", "恢复归档说明"), seenBatch: tr("Mark selected structure reviewed", "批量标为已查看"),
    confirm: tr("Confirm this description", "确认这条说明"), archive: tr("Archive statement", "归档本条理解"), defer: tr("Defer", "暂缓处理"),
    disable: tr("Disable relationship", "停用逻辑关系"), seen: tr("Mark reviewed", "标为已查看"), acceptLimitation: tr("Keep missing references", "保留缺失引用"),
    start: tr("Establish starting point", "建立比较起点"), restart: tr("Restart comparison", "重新建立比较起点"), complete: tr("Complete this round", "完成本轮复核"),
    annotation: tr("Description", "业务说明"), relationship: tr("Logical relationship", "逻辑关系"), domain: tr("Business domain", "业务域"), view: tr("Saved view", "保存视图"), coverage: tr("Coverage", "采集范围"), structure: tr("Structure", "结构变化"),
    open: tr("Needs review", "待复核"), deferred: tr("Deferred", "已暂缓"), resolved: tr("Reviewed", "已处理"),
  };
  const reasons: Record<string, string> = {
    supportChanged: tr("A supporting table, relationship or statement changed. Table-level checks are conservative: review whether your explanation still applies.", "所依赖的表、关系或说明变化。当前采用保守的表级校验，请判断原说明是否仍适用。"),
    notConfirmed: tr("This existing description has no valid local confirmation. It is not necessarily caused by this round's changes.", "这条已有说明尚无有效本机确认，不一定由本轮变化引起。"),
    notObserved: tr("The object was not observed in this capture. It may have been renamed, removed or become inaccessible.", "本次未观测到该对象，可能改名、删除或失去访问权限。"),
    missingReferences: tr("Some saved members are not observable. Keep them with an explicit limitation or defer for investigation.", "部分已保存成员本次不可见。可以明确保留此限制，或暂缓调查。"),
    captureFailed: tr("The last capture failed. Retry database refresh before completing this review. The saved model is retained.", "最近一次采集失败。请重试数据库刷新后再完成复核；已保存模型仍保留。"),
    scopeChanged: tr("Observed schema scope changed. Check permissions and capture scope before restarting comparison; this does not prove deletion.", "观测到的 schema 范围变化。请检查权限和采集范围后再重新建立起点，这不能证明对象被删除。"),
    baselineMissing: tr("The baseline snapshot is unavailable. Establish a new starting point explicitly.", "基线快照不可用，请显式重新建立起点。"),
    relationshipUnavailable: tr("Relationship endpoints are missing or incompatible. Resolve in the relationship editor, disable, or defer.", "关系端点缺失或不兼容。请在关系编辑器处理，或停用、暂缓。"),
    relationshipChanged: tr("The structure supporting this relationship changed. Inspect endpoints before marking reviewed.", "支撑该关系的结构变化，请核对端点后标为已查看。"),
  };
  const items = data?.items ?? [];
  const visible = currentPage ? items : [];
  const item = visible.find(i => i.key === selected) ?? visible[0];
  const pending = data?.pendingCount ?? 0;
  const oldText = item?.kind === "annotation" ? String((item.before as { description?: string })?.description ?? "") : "";
  const draft = item ? drafts[item.key] ?? oldText : "";
  function prepare(action: string, target?: ChangeReviewItem) {
    if (!data) return;
    setError(""); setMessage(""); setPreviewNames(action === "seenBatch" ? visible.filter(i => checked.includes(i.key)).map(i => i.title) : []);
    setPreview({ sourceId, revision: data.revision, preparedAt: new Date().toISOString(), operationId: crypto.randomUUID(), action, itemKey: target?.key ?? null, itemKeys: action === "seenBatch" ? checked : undefined, text: action === "confirm" ? draft : action === "seenBatch" ? "" : reason });
  }
  function restore(event: ChangeReviewEvent) {
    if (!data || !event.restorable || !currentPage) return;
    setPreviewNames([event.item?.title ?? ""]);
    setRestoreText(String((event.item?.before as {description?: string})?.description ?? ""));
    setPreview({ sourceId, revision: data.revision, preparedAt: new Date().toISOString(), operationId: crypto.randomUUID(), action: "restore", itemKey: event.id, text: null });
    setError(""); setMessage("");
  }
  function firstPage() { setCursor(undefined); setTrail([]); setChecked([]); }
  function changeTab(next: string) { setTab(next); firstPage(); }
  async function apply() {
    if (!preview || working.current) return;
    working.current = true; setBusy(true); requestEpoch.current++;
    try {
      const next = await platform.applyChangeReview(preview, { view: tab, search: query, limit: 50 });
      if (!mounted.current) return;
      requestEpoch.current++;
      loadedRevision.current = next.revision;
      const decidedKey = preview.action === "restore" ? data?.events.find(e => e.id === preview.itemKey)?.item?.key : preview.itemKey;
      if (decidedKey && ["confirm", "archive", "restore"].includes(preview.action)) {
        setDrafts(previous => { const remaining = { ...previous }; delete remaining[decidedKey]; return remaining; });
      }
      setData(next); firstPage(); setLoadedKey(JSON.stringify([tab, query, undefined])); setMessage("saved"); setPreview(undefined); dialog.current?.close(); setReason(""); setError("");
      try { await onChanged(); if (mounted.current) setRefreshError(false); } catch { if (mounted.current) setRefreshError(true); }
    } catch (e) { if (mounted.current) setError(String(e)); }
    finally { working.current = false; if (mounted.current) setBusy(false); }
  }
  const reasonRequired = (action: string) => ["defer", "archive", "disable", "acceptLimitation", "restart"].includes(action);
  return <section className="change-review ds-surface" aria-label={tr("Current change review", "本轮变化复核")}>
    <header className="review-heading"><div><h2>{tr("Current change review", "本轮变化复核")}</h2><p>{tr("Preserve understanding. Review changed evidence.", "保留已有理解，复核变化依据。")}</p></div><div className="review-actions"><button disabled={busy} onClick={onRefresh}>{tr("Refresh database", "刷新数据库")}</button><button disabled={busy || loading} onClick={() => void reload()}>{tr("Reload review", "重新加载复核")}</button>{data?.initialized && !data.identityChanged ? <button disabled={busy || loading || !currentPage || pending > 0 || data.completed} onClick={() => prepare("complete")}>{labels.complete}</button> : null}</div></header>
    {loading ? <p role="status">{tr("Loading review…", "正在加载复核…")}</p> : null}
    {error ? <p role="alert">{error} · {tr("Your edited draft is retained.", "已编辑的草稿仍保留。")}</p> : null}
    {message ? <p role="status">{message === "saved" ? tr("Decision saved locally.", "决定已保存到本机。") : tr("This object is absent from the current model. Inspect the recorded evidence or History comparison.", "当前模型中没有此对象，请查看记录依据或历史比较。")}</p> : null}
    {refreshError ? <p role="alert">{tr("Saved, but the model view could not refresh.", "已保存，但模型视图未能刷新。")} <button onClick={() => void onChanged().then(() => setRefreshError(false)).catch(() => setRefreshError(true))}>{tr("Retry view refresh", "重试视图刷新")}</button></p> : null}
    {data ? <>
      <div className="review-baseline"><span>{tr("Baseline", "复核起点")}：{data.baselineAt ? formatDate(data.baselineAt) : tr("Not established", "尚未建立")}</span><span>→ {tr("Target", "目标")}：{formatDate(data.targetAt)}</span><strong>{data.completed ? tr("This round is complete", "本轮已完成") : `${pending} ${tr("items remaining", "项待处理")}`}</strong></div>
      <p className="review-coverage">{tr("Limited to observed metadata. Unchanged structure does not prove business meaning. Missing objects may reflect permission changes.", "仅覆盖已观测的元数据。结构未变化不代表业务含义正确；对象缺失也可能来自权限变化。")}{data.coverage === "legacyCoverageUnknown" ? tr(" This older snapshot has no capture receipt.", " 此旧快照没有采集收据。") : null}</p>
      {!data.initialized || data.identityChanged ? <div className="review-start"><h3>{data.identityChanged ? tr("Connection identity changed", "连接身份已变化") : tr("Start tracking your understanding", "开始跟踪已有理解")}</h3><p>{tr("Establishing a starting point does not confirm existing descriptions. Deferred items will remain until resolved.", "建立比较起点不会确认已有说明。暂缓事项在处理前始终保留。")}</p>{data.identityChanged ? <textarea aria-label={tr("Reason", "处理理由")} value={reason} onChange={e => setReason(e.target.value)} /> : null}<button disabled={busy || (data.identityChanged && !reason.trim())} onClick={() => prepare(data.identityChanged ? "restart" : "start")}>{data.identityChanged ? labels.restart : labels.start}</button></div> : <>
        <nav className="review-tabs" aria-label={tr("Review views", "复核视图")}>{[["impact", tr("Understanding impacts", "理解影响")], ["structure", tr("All structure changes", "全部结构变化")], ["events", tr("Decision history", "处理记录")]].map(([key, label]) => <button key={key} aria-pressed={tab === key} onClick={() => changeTab(key)}>{label}{key !== "events" ? ` (${key === "structure" ? data.structureCount : data.impactCount})` : ""}</button>)}</nav>
        <label className="review-search">{tr("Find an item", "查找复核事项")}<input maxLength={200} value={query} onChange={e => { setQuery(e.target.value); firstPage(); }} /></label>
        <div className="review-pagination" aria-label={tr("Review pagination", "复核分页")}><span>{tr("Matches", "匹配事项")}：{data.total} · {tr("Page", "页")} {trail.length + 1}</span><button disabled={busy || !trail.length} onClick={() => { setCursor(trail.at(-1)); setTrail(t => t.slice(0,-1)); setChecked([]); }}>{tr("Previous page", "上一页")}</button><button disabled={busy || !currentPage || !data.nextCursor} onClick={() => { setTrail(t => [...t, cursor]); setCursor(data.nextCursor!); setChecked([]); }}>{tr("Next page", "下一页")}</button><button disabled={busy || !cursor} onClick={firstPage}>{tr("First page", "第一页")}</button></div>
        {tab === "structure" && currentPage ? <div className="review-actions"><button disabled={busy} onClick={() => setChecked(visible.filter(i => i.status !== "resolved" && i.actions.includes("seen")).map(i => i.key))}>{tr("Select this page", "选择本页")}</button><button disabled={busy || !checked.length} onClick={() => setChecked([])}>{tr("Clear selection", "清空选择")}</button><button disabled={busy || !checked.length} onClick={() => prepare("seenBatch")}>{labels.seenBatch} ({checked.length})</button><span>{tr("Only selected structure changes; descriptions are never confirmed in bulk.", "仅处理所选结构变化，不会批量确认业务说明。")}</span></div> : null}
        {tab === "events" ? <ol className="review-events">{(currentPage ? data.events : []).map(e => <li key={e.id}><strong>{labels[e.action] ?? e.action} · {e.item?.title}</strong><time>{formatDate(e.at)}</time>{e.text ? <p>{e.text}</p> : null}{e.item?.kind === "annotation" ? <details><summary>{tr("Original statement", "原说明")}</summary><p>{String((e.item.before as { description?: string }).description ?? "")}</p></details> : null}{e.items?.length ? <details><summary>{tr("Reviewed structure changes", "已查看结构变化")} ({e.items.length})</summary><ul>{e.items.map(i => <li key={i.key}>{i.title}</li>)}</ul></details> : null}{e.action === "archive" ? <button disabled={busy || !e.restorable || data.identityChanged} onClick={() => restore(e)}>{labels.restore}</button> : null}</li>)}</ol> : <>
          <div className="review-columns"><aside className="review-list" aria-label={tr("Review items", "复核事项")}>{visible.map(i => <div className="review-row" key={i.key}>{tab === "structure" && i.status !== "resolved" ? <input type="checkbox" aria-label={`${tr("Select", "选择")} ${i.title}`} checked={checked.includes(i.key)} disabled={busy} onChange={e => setChecked(keys => e.target.checked ? [...keys, i.key] : keys.filter(k => k !== i.key))} /> : null}<button key={i.key} aria-current={item?.key === i.key ? "true" : undefined} onClick={() => { setSelected(i.key); setReason(""); }}><strong>{i.title}</strong><span>{labels[i.kind]} · {labels[i.status]}</span></button></div>)}</aside>
            <article className="review-detail" aria-live="polite">{item ? <>
              <h3>{item.title}</h3><p className="review-reason">{reasons[item.reason] ?? tr("Review the captured structural change below.", "请核对下方采集到的结构变化。")}</p>
              {item.note ? <p>{tr("Recorded reason", "已记录理由")}：{item.note}</p> : null}
              {item.kind === "annotation" ? <><h4>{tr("Original understanding", "原有理解")}</h4><p>{oldText}</p>{item.actions.includes("confirm") ? <label>{tr("Description to confirm (keep or revise)", "待确认说明（可保留或修订）")}<textarea rows={5} maxLength={2000} value={draft} onChange={e => setDrafts(d => ({ ...d, [item.key]: e.target.value }))} /></label> : null}</> : null}
              <div className="review-evidence"><div><h4>{tr("Before / recorded evidence", "之前／记录依据")}</h4><Evidence value={item.before} /></div><div><h4>{tr("Current evidence", "当前依据")}</h4><Evidence value={item.after} /></div></div>
              {item.object ? <button onClick={() => { if (onLocate(item.object!) === false) setMessage("missing"); }}>{tr("Locate in model", "在模型中定位")}</button> : null}
              <label>{tr("Reason for deferral, archival or accepted limitation", "暂缓、归档或保留限制的理由")}<textarea rows={2} maxLength={2000} value={reason} onChange={e => setReason(e.target.value)} /></label>
              <div className="review-actions">{item.actions.map(action => <button key={action} disabled={busy || (action === "confirm" && !draft.trim()) || (reasonRequired(action) && !reason.trim())} onClick={() => prepare(action, item)}>{labels[action] ?? action}</button>)}</div>
            </> : <p>{data.completed ? tr("This round is complete. Your decisions remain in history; future changes will be compared with this starting point.", "本轮已完成，处理记录仍保留；后续变化将以此起点进行比较。") : tr("No matching items. Check structure changes before completing the round.", "没有匹配事项。完成本轮前请查看结构变化。")}</p>}</article></div>
        </>}
        <details className="review-restart"><summary>{tr("Comparison scope or identity changed?", "比较范围或身份发生变化？")}</summary><p>{tr("Restart preserves history and invalidates earlier confirmations. It does not mark this round complete.", "重新建立起点会保留历史，并要求重新复核旧说明，不会将本轮标为完成。")}</p><label>{tr("Reason", "理由")}<input value={reason} onChange={e => setReason(e.target.value)} /></label><button disabled={busy || !reason.trim()} onClick={() => prepare("restart")}>{labels.restart}</button></details>
      </>}
    </> : null}
    <dialog ref={dialog} className="review-dialog" onCancel={e => { if (busy) e.preventDefault(); else setPreview(undefined); }}>
      {preview ? <><h3>{labels[preview.action]}{preview.action === "seenBatch" ? ` (${previewNames.length})` : ""}</h3><p>{tr("This changes local review records only. It does not modify your database schema.", "此操作仅修改本机复核记录，不修改数据库表结构。")}</p>{preview.action === "complete" ? <p>{tr("All items in this observed scope have been handled. Accepted limitations remain documented; this is not proof of business correctness.", "本次观测范围内的事项已处理。已接受限制仍保留记录；这不代表业务正确性已被证明。")}</p> : null}{preview.action === "archive" ? <p>{tr("The original statement is preserved in decision history and removed from current AI and export context. Tags and owner are retained.", "原说明保存在处理记录中，不再进入当前 AI 和导出上下文；标签与负责人保留。")}</p> : null}{preview.action === "restore" ? <p>{tr("Restore the original text for review. Existing tags and owner are preserved. Old confirmation is not restored; missing objects remain unavailable.", "恢复原文并重新待复核，保留当前标签和负责人；不会恢复旧确认资格，对象缺失时仍不可确认。")}</p> : null}{previewNames.length ? <ul>{previewNames.map(name => <li key={name}>{name}</li>)}</ul> : null}<p className="review-preview-text">{preview.action === "restore" ? restoreText : preview.text}</p>{preview.revision !== data?.revision ? <p role="alert">{tr("Evidence changed. Cancel and prepare again; your draft is retained.", "依据已变化，请取消并重新准备；草稿仍保留。")}</p> : null}{error ? <p role="alert">{error}</p> : null}<div className="review-actions"><button autoFocus disabled={busy} onClick={() => { dialog.current?.close(); setPreview(undefined); }}>{tr("Cancel", "取消")}</button><button disabled={busy || preview.revision !== data?.revision} onClick={() => void apply()}>{busy ? tr("Saving…", "保存中…") : tr("Confirm decision", "确认决定")}</button></div></> : null}
    </dialog>
  </section>;
}
/** Readable, progressively disclosed evidence; raw JSON is never required for review. */
function Evidence({ value, depth = 0 }: { value: unknown; depth?: number }) {
  const { locale } = useI18n();
  if (value === null || value === undefined) return <span>—</span>;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return <span className="review-value">{String(value)}</span>;
  if (typeof value !== "object") return <span>—</span>;
  const entries: [string, unknown][] = Array.isArray(value) ? (value as unknown[]).map((v, i) => [String(i + 1), v]) : Object.entries(value).filter(([key]) => !["id", "sourceId", "snapshotId", "descriptionDigest", "fingerprint", "basis", "origin", "state"].includes(key));
  const names: Record<string, string> = { description: "说明", confirmation: "确认记录", tables: "依赖表", relationships: "依赖关系", notes: "依赖说明", state: "状态依据", columns: "字段", name: "名称", dataType: "数据类型", nullable: "允许为空", defaultValue: "默认值", comment: "注释", basis: "确认依据", confirmedAt: "确认时间", finalText: "确认文本", primaryKey: "主键", foreignKeys: "外键", indexes: "索引", schema: "Schema", key: "对象", target: "目标", source: "来源", origin: "依据来源", evidence: "原始依据" };
  if (!entries.length) return <span>—</span>;
  return <dl className="review-evidence-tree">{entries.map(([key, v]) => <div key={key}><dt>{locale === "zh-CN" ? names[key] ?? key : key}</dt><dd>{typeof v === "object" && v !== null && depth >= 0 ? <details><summary>{Array.isArray(v) ? `${v.length} ${locale === "zh-CN" ? "项" : "items"}` : locale === "zh-CN" ? "查看详情" : "View details"}</summary><Evidence value={v} depth={depth + 1} /></details> : <Evidence value={v} depth={depth + 1} />}</dd></div>)}</dl>;
}
