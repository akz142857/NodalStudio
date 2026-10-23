import { useCallback, useEffect, useRef, useState } from "react";
import type { DatabaseSnapshot, KnowledgeDraft, KnowledgeDraftInput, NodalStudioPlatform, SemanticBundle, TableDefinition } from "../platform";
import { objectId, objectLabel } from "../graph/business-discovery";
import "./knowledge-review.css";
interface EditorProps { platform: NodalStudioPlatform; input: KnowledgeDraftInput; sourceId: string; label?: string; chinese?: boolean; onSaved: () => Promise<void> }
export function KnowledgeEditor(props: EditorProps) { return <EditorSession key={JSON.stringify([props.input, props.sourceId])} {...props} />; }
function EditorSession({ platform, input, sourceId, label = "Review and confirm description", chinese = false, onSaved }: EditorProps) {
  const t = (en: string, zh: string) => chinese ? zh : en;
  const [draft, setDraft] = useState<KnowledgeDraft>(); const [text, setText] = useState("");
  const [phase, setPhase] = useState("idle"); const [error, setError] = useState("");
  const version = useRef(0); const currentId = useRef<string | undefined>(undefined); const busy = useRef(false);
  const cancel = useCallback((next = "idle") => { version.current++; busy.current = false; if (currentId.current) void platform.cancelKnowledgeDraft(currentId.current).catch(() => undefined); currentId.current = undefined; setDraft(undefined); setText(""); setError(""); setPhase(next); }, [platform]);
  useEffect(() => () => { version.current++; if (currentId.current) void platform.cancelKnowledgeDraft(currentId.current).catch(() => undefined); }, [platform]);
  useEffect(() => {
    // A confirmation already submitted before expiry may commit before its response arrives.
    // Let that result refresh semantics instead of cancelling the UI while the write is in flight.
    if (!draft || phase === "saved" || phase === "saving") return;
    const expire = () => { if (Date.now() >= Date.parse(draft.expiresAt)) cancel("expired"); };
    const timer = window.setTimeout(expire, Math.max(0, Date.parse(draft.expiresAt) - Date.now()));
    window.addEventListener("focus", expire); document.addEventListener("visibilitychange", expire);
    return () => { clearTimeout(timer); window.removeEventListener("focus", expire); document.removeEventListener("visibilitychange", expire); };
  }, [draft, phase, cancel]);
  async function prepare() {
    if (busy.current) return; cancel(); const epoch = version.current; busy.current = true; setPhase("preparing");
    try {
      const next = await platform.prepareKnowledgeDraft(input);
      if (version.current !== epoch) { void platform.cancelKnowledgeDraft(next.id).catch(() => undefined); return; }
      if (next.sourceId !== sourceId || next.snapshotId !== input.snapshotId || (next.target.kind !== input.target.kind || objectId(next.target) !== objectId(input.target)) || !Number.isFinite(Date.parse(next.expiresAt)) || Date.parse(next.expiresAt) <= Date.now()) { void platform.cancelKnowledgeDraft(next.id).catch(() => undefined); throw new Error("The draft does not match the current target or has expired."); }
      currentId.current = next.id; setDraft(next); setText(next.draftText); setPhase("editing");
    } catch (reason) { if (epoch === version.current) { setError(String(reason)); setPhase("error"); } }
    finally { if (epoch === version.current) busy.current = false; }
  }
  async function confirm() {
    if (!draft || busy.current || !text.trim()) return;
    if (Date.now() >= Date.parse(draft.expiresAt)) { cancel("expired"); return; }
    const epoch = version.current; busy.current = true; setPhase("saving"); setError("");
    try {
      await platform.confirmKnowledgeDraft(draft.id, text);
      if (epoch === version.current) setPhase("saved");
      // Unmount/cancel can discard UI feedback, but cannot undo a committed write.
      await onSaved();
    } catch (reason) { if (epoch === version.current) { setError(String(reason)); setPhase("error"); } }
    finally { if (epoch === version.current) busy.current = false; }
  }
  return <section className="knowledge-review" aria-label="Knowledge confirmation">
    <button type="button" onClick={() => void prepare()} disabled={phase === "preparing" || phase === "saving"}>{draft ? t("Prepare a fresh comparison", "重新核对改动") : label}</button>
    {phase === "preparing" || (draft && phase !== "saved") ? <button type="button" onClick={() => cancel("cancelled")} disabled={phase === "saving"}>{t("Cancel draft", "取消草稿")}</button> : null}
    {draft ? <><h4>{objectLabel(draft.target)} · {draft.target.kind}</h4><p className="ai-policy">{t("Confirming records a team statement on this device, not a database fact. Keep uncertainty and unresolved business questions. Tags, owner and core-table flag are preserved.", "保存为本机确认的团队说明。请保留推测与待确认事项；不会修改数据库结构、标签或负责人。")}</p>
      <div className="knowledge-comparison"><div><strong>{t("Current description", "当前说明")}</strong><p>{draft.oldDescription || t("No saved description", "暂无已保存说明")}</p></div><label>{t("Proposed description", "拟保存的说明")}<textarea rows={5} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} disabled={phase === "saving" || phase === "saved"} /></label></div>
      <details><summary>{t("Current review evidence and origin", "本次依据与来源")}</summary><p>{draft.origin.kind} · {draft.origin.provider ?? "Local review"} {draft.origin.model ?? ""}</p><pre>{JSON.stringify(draft.origin.evidence, null, 2)}</pre></details>
      <p className="ai-policy">{t("Local draft; confirm before saving. Review expires", "草稿仅在本地；确认后才保存。本次核对有效至")} {new Date(draft.expiresAt).toLocaleTimeString()}</p>
      {phase !== "saved" ? <button type="button" onClick={() => void confirm()} disabled={phase === "preparing" || phase === "saving" || !text.trim()}>{phase === "saving" ? t("Saving…", "正在保存…") : t("Confirm this description", "确认保存说明")}</button> : null}
    </> : null}
    {error ? <p role="alert">{error} {t("Your edited draft is retained. Retry, or prepare a fresh comparison if the evidence changed.", "已保留你编辑的草稿。可重试；依据变化后请重新核对。")}</p> : null}
    <p role="status">{phase === "saved" ? t("Description confirmed on this device.", "说明已在本机确认。") : phase === "expired" ? t("Draft expired. Review current evidence again.", "草稿已过期，请重新核对。") : phase === "cancelled" ? t("Draft cancelled.", "已取消草稿。") : ""}</p>
  </section>;
}
export function KnowledgeReview({ platform, snapshot, semantics, table, desktop, onRefresh }: { platform: NodalStudioPlatform; snapshot: DatabaseSnapshot; semantics: SemanticBundle; table?: TableDefinition; desktop: boolean; onRefresh: () => Promise<void> }) {
  const [latest, setLatest] = useState<string>(); const [limit, setLimit] = useState(10);
  useEffect(() => { let active = true; if (desktop) void platform.listSnapshots(snapshot.sourceId).then((items) => { if (active) setLatest(items[0]?.id); }).catch(() => undefined); return () => { active = false; }; }, [desktop, platform, snapshot.sourceId, snapshot.id]);
  if (!desktop) return <p>Shared descriptions do not carry local review proof. Confirm knowledge in Desktop.</p>;
  if (latest !== snapshot.id) return <p>Knowledge review requires the latest loaded snapshot.</p>;
  const states = semantics.knowledge ?? [];
  const selected = states.find((s) => table && objectId(s.objectKey) === objectId(table.key) && s.objectKey.kind === "table");
  const pending = states.filter((s) => s.status !== "confirmed" && s !== selected);
  const editor = (target: import("../platform").ObjectKey) => <KnowledgeEditor key={JSON.stringify([target, semantics.annotations, states])} platform={platform} input={{ snapshotId: snapshot.id, target, requestId: null, interpretationIndex: null }} sourceId={snapshot.sourceId} onSaved={onRefresh} />;
  return <section className="knowledge-review" aria-label="Local knowledge validity"><h3>Local review</h3>
    {table ? <><p><strong>{selected?.status === "confirmed" ? "Confirmed team statement" : selected?.status === "unavailable" ? "Object unavailable" : "Needs review"}</strong> · {selected?.reason ?? "No local confirmation has been recorded."}</p>{editor(table.key)}{selected?.confirmation ? <details><summary>Previous confirmation and original evidence</summary><pre>{JSON.stringify(selected.confirmation, null, 2)}</pre></details> : null}</> : null}
    <p>{pending.length} other descriptions need review.</p>
    <details><summary>About local confirmation</summary><p>Git, cloud and portable backups share text without proof of current validity. Confirm descriptions on this device against the current snapshot.</p></details>
    {pending.slice(0, limit).map((state) => <details key={JSON.stringify(state.objectKey)}><summary>{objectLabel(state.objectKey)} · {state.status}</summary><p>{state.reason}</p><p>{[...semantics.annotations, ...semantics.orphanedAnnotations].find((a) => JSON.stringify(a.objectKey) === JSON.stringify(state.objectKey))?.description}</p>{state.confirmation ? <pre>{JSON.stringify(state.confirmation, null, 2)}</pre> : null}{state.status !== "unavailable" ? editor(state.objectKey) : null}</details>)}
    {pending.length > limit ? <button onClick={() => setLimit((value) => value + 10)}>Show more pending descriptions</button> : null}
  </section>;
}
