import { translateUiLabel } from "../../i18n/business-labels";
import { useI18n, useEventTranslator } from "../../i18n";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { DatabaseSnapshot, EffectiveSettings, NodalStudioPlatform, ObjectKey, QueryExecutionResult, SemanticBundle, SqlDraft, TableDefinition } from "../../platform";
import { objectId, objectLabel } from "../../graph/business-discovery";
import { DiscoveryAssistant } from "../DiscoveryAssistant";
import { ActionIcon } from "../ActionIcon";
import { QueryDraftAnswer } from "./QueryDraftAnswer";
import { resolveDraftContext, validateDraftContext, type DraftContext } from "./query-context";
import "./query-draft.css";

export interface QueryDraftSeed {
  id: number;
  sourceId: string;
  snapshotId: string;
  question: string;
  root: ObjectKey | null;
  tables: ObjectKey[];
  domainId: string | null;
}
interface Props {
  platform: NodalStudioPlatform;
  snapshot: DatabaseSnapshot;
  settings: EffectiveSettings;
  semantics: SemanticBundle;
  seed?: QueryDraftSeed;
  initialTable?: TableDefinition;
  onUseSql: (sql: string) => void;
  onOpenSettings: () => void;
  execution?: { sql: string; result: QueryExecutionResult };
}
interface DraftTurn {
  id: number;
  question: string;
  requestQuestion: string;
  context?: DraftContext;
  answer?: SqlDraft;
  autoPrepare: boolean;
  semanticBinding: string;
}
export function QueryDraftPanel(props: Props) {
  return <DraftPanel key={JSON.stringify([props.snapshot.id, props.snapshot.sourceId, props.snapshot.fingerprint, props.settings.source, props.settings.app.privacy, props.seed?.id])} {...props} />;
}
function DraftPanel({ platform, snapshot, settings, semantics, seed, initialTable, onUseSql, onOpenSettings, execution }: Props) {
  const { t: bt, locale } = useI18n();
  const eventBt = useEventTranslator(bt);
  const semanticBinding = JSON.stringify([semantics.logicalRelationships, semantics.domainGroups, semantics.knowledge]);
  const questionId = useId();
  const contextId = useId();
  const nextId = useRef(1);
  const composer = useRef<HTMLTextAreaElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const usableSeed = seed?.sourceId === snapshot.sourceId && seed.snapshotId === snapshot.id ? seed : undefined;
  const carried = usableSeed?.root && usableSeed.tables.length ? { root: usableSeed.root, tables: usableSeed.tables } : undefined;
  const [question, setQuestion] = useState(carried ? "" : usableSeed?.question ?? "");
  const [turns, setTurns] = useState<DraftTurn[]>(carried && usableSeed?.question ? [{ id: 0, question: usableSeed.question, requestQuestion: usableSeed.question, context: carried, autoPrepare: false, semanticBinding }] : []);
  const [manual, setManual] = useState<DraftContext | undefined>(carried);
  const [contextOpen, setContextOpen] = useState(false);
  const [domainId, setDomainId] = useState(usableSeed?.domainId ?? "");
  const [contextSearch, setContextSearch] = useState("");
  const [latest, setLatest] = useState(false);
  const [snapshotError, setSnapshotError] = useState("");
  const [composerError, setComposerError] = useState("");
  useLayoutEffect(() => {
    const input = composer.current;
    if (!input) return;
    const fitContent = () => {
      input.style.height = "auto";
      input.style.height = `${input.scrollHeight}px`;
    };
    fitContent();
    let width = input.clientWidth;
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => {
      if (input.clientWidth === width) return;
      width = input.clientWidth;
      fitContent();
    });
    observer?.observe(input);
    window.addEventListener("resize", fitContent);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", fitContent);
    };
  }, [question]);
  useEffect(() => {
    let active = true;
    void platform.listSnapshots(snapshot.sourceId).then((items) => { if (active) setLatest(items[0]?.id === snapshot.id); }).catch(() => { if (active) setSnapshotError(eventBt("business.unableToVerifyTheLatestSnapshotReopenDraftingTo")); });
    return () => { active = false; };
  }, [platform, snapshot.sourceId, snapshot.id, eventBt]);
  const followLatest = useRef(true);
  useLayoutEffect(() => {
    followLatest.current = true;
    const node = transcript.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [turns.length]);
  useEffect(() => {
    const node = transcript.current;
    const content = node?.firstElementChild;
    if (!node || !content) return;
    const follow = () => { if (followLatest.current) node.scrollTop = node.scrollHeight; };
    const onScroll = () => { followLatest.current = node.scrollHeight - node.clientHeight - node.scrollTop < 48; };
    // Preview, errors and answers arrive inside the child without changing turns.
    const mutations = new MutationObserver(follow);
    mutations.observe(content, { childList: true, subtree: true, characterData: true });
    const resize = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(follow);
    resize?.observe(content);
    resize?.observe(node);
    node.addEventListener("scroll", onScroll);
    return () => { mutations.disconnect(); resize?.disconnect(); node.removeEventListener("scroll", onScroll); };
  }, []);
  const tables = snapshot.schemas.flatMap((schema) => schema.tables);
  const domains = semantics.domainGroups.filter((d) => d.sourceId === snapshot.sourceId);
  const scope = settings.source?.ai.contextScope ?? "currentTable";
  const configured = settings.source?.sourceId === snapshot.sourceId && settings.source.ai.enabled && settings.source.ai.provider === "openAiCompatible" && !settings.app.privacy.offlineMode;
  const activeTurn = turns.at(-1);
  const automatic = activeTurn && !activeTurn.context ? resolveDraftContext(snapshot, semantics, settings, activeTurn.requestQuestion, domainId, initialTable?.key, bt) : undefined;
  const context = activeTurn?.context ?? (automatic?.kind === "ready" ? automatic.context : undefined);
  const problem = context ? validateDraftContext(snapshot, semantics, settings, context, domainId, bt) : automatic?.kind === "blocked" ? automatic.message : undefined;
  const input = { replyLanguage: { currentQuestion: activeTurn?.question ?? "", uiLocale: locale }, snapshotId: snapshot.id, domainId: domainId || null, task: { operation: "draftSql" as const, question: activeTurn?.requestQuestion ?? "", root: context?.root ?? null, candidates: context?.tables ?? [], pathTables: [], pathRelationships: [] } };
  const examples = ["Summarize monthly trends for the last six months", "Which customers have no recent orders?", "Count users by status"].map((label) => translateUiLabel(label, bt));
  function changeQuestion(value: string) { setQuestion(value); setComposerError(""); }
  function pinContext(next?: DraftContext) {
    setManual(next);
    const id = nextId.current++;
    if (activeTurn && !activeTurn.answer) setTurns((current) => current.map((turn) => turn.id === activeTurn.id ? { ...turn, id, context: next, autoPrepare: false, semanticBinding } : turn));
  }
  function submit() {
    const text = question.trim();
    if (!text) return;
    // Carry requests and the questions being answered, never SQL result rows/history.
    const clarification = activeTurn?.answer?.clarification.length ? `\n\nPrevious clarification questions:\n${activeTurn.answer.clarification.join("\n")}` : "";
    const requestQuestion = activeTurn ? `${activeTurn.requestQuestion}${clarification}\n\nFollow-up request:\n${text}` : text;
    if ([...requestQuestion].length > 2000) { setComposerError(bt("business.thisConversationHasReachedTheContextLimitStartA")); return; }
    const turn: DraftTurn = { id: nextId.current++, question: text, requestQuestion, context: manual ?? context, autoPrepare: true, semanticBinding };
    setTurns((current) => [...current.map((item) => item.id === activeTurn?.id ? { ...item, context } : item), turn]);
    setQuestion(""); setContextOpen(false); setComposerError(""); composer.current?.focus();
  }
  function startNew() { setTurns([]); setManual(undefined); setQuestion(""); setContextOpen(false); setComposerError(""); composer.current?.focus(); }
  return <section className="query-draft-panel" aria-label={bt("business.draftQueryWithAI")} data-start={!turns.length || undefined}>
    <header className="query-conversation-toolbar"><span><ActionIcon name="ai" />{bt("business.queryAssistant")}</span><button type="button" onClick={startNew} disabled={!turns.length && !question.trim()}>{bt("business.newConversation")}</button></header>
    <div className="query-transcript" ref={transcript} aria-label={bt("business.queryConversation")} tabIndex={0}>
      <div className="query-draft-content">
        {!turns.length ? <div className="query-conversation-welcome"><header className="query-ask-heading"><span className="query-ask-symbol"><ActionIcon name="ai" /></span><h2>{bt("business.whatWouldYouLikeToKnow")}</h2><p>{bt("business.exploreYourDataBuildAQueryThenRefineIt")}</p></header><div className="query-example-prompts" aria-label={bt("business.exampleQuestions")}>{examples.map((example) => <button type="button" key={example} onClick={() => { changeQuestion(example); composer.current?.focus(); }}>{example}</button>)}</div></div> : null}
        {!configured ? <div className="query-model-setup"><ActionIcon name="ai" /><div><strong>{bt("business.connectYourAIModel")}</strong><p>{bt("business.useTheModelConfiguredForThisDatabaseToTurn")}</p></div><button type="button" onClick={onOpenSettings}>{bt("business.openAISettings")}</button></div> : null}
        {turns.map((turn) => <article className="query-conversation-turn" key={turn.id} aria-label={bt("business.question", { value0: turn.id + 1 })}>
          <div className="query-user-message"><span>{bt("business.you")}</span><p>{turn.question}</p></div>
          <div className="query-assistant-message"><div className="query-assistant-label"><ActionIcon name="ai" /><span>Nodal Studio</span></div>
            {turn !== activeTurn ? turn.answer ? <QueryDraftAnswer draft={turn.answer} disabled={!configured || !latest || turn.semanticBinding !== semanticBinding || (!turn.context || !!validateDraftContext(snapshot, semantics, settings, turn.context, domainId, bt))} onUseSql={onUseSql} result={execution && execution.sql.trim() === turn.answer.sql?.trim() ? execution.result : undefined} /> : <p className="query-superseded">{bt("business.continuedInTheNextMessage")}</p> : <>
              {automatic?.kind === "clarify" ? <section className="query-context-response" aria-label={bt("business.clarifyQueryContext")}><h3>{bt("business.aLittleMoreContext")}</h3><p>{automatic.message}</p><div className="query-context-choices">{automatic.choices.map((choice) => <button type="button" key={objectId(choice.key)} onClick={() => setTurns((current) => current.map((item) => item.id === turn.id ? { ...item, context: { root: choice.key, tables: [choice.key] }, autoPrepare: true } : item))}><strong>{objectLabel(choice.key)}</strong><span>{choice.reason}</span></button>)}</div></section> : null}
              {problem ? <p className="query-context-response" role="alert">{problem}</p> : null}
              {context && !problem ? <section className="query-context-response" aria-label={bt("business.queryContext")}><div className="query-context-chips">{context.tables.map((key) => <span key={objectId(key)}><ActionIcon name="database" />{objectLabel(key)}</span>)}</div>
                {configured ? <DiscoveryAssistant platform={platform} snapshot={snapshot} settings={settings} input={input} autoPrepare={turn.autoPrepare} directSend binding={JSON.stringify([turn.id, semantics.logicalRelationships, semantics.domainGroups, semantics.knowledge])} available={latest} onApplyTerms={() => {}} onLocate={() => {}} onOpenSettings={onOpenSettings} onUseSql={onUseSql} execution={execution} onSqlDraft={(answer) => setTurns((current) => current.map((item) => item.id === turn.id ? { ...item, answer, context, semanticBinding } : item))} /> : null}
              </section> : null}
            </>}
          </div>
        </article>)}
        {snapshotError ? <p role="alert">{snapshotError}</p> : null}
      </div>
    </div>
    <div className="query-composer-dock">
      <div className="query-composer-width">
        {scope === "domain" ? <div className="query-domain-choice"><label>{bt("business.businessDomainDetail")} <select value={domainId} onChange={(e) => { setDomainId(e.target.value); setTurns([]); }}><option value="">{bt("business.chooseADomain")}</option>{domains.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>{!domains.length ? <button type="button" onClick={onOpenSettings}>{bt("business.reviewAIScopeInSettings")}</button> : null}</div> : null}
        <div className="query-context-tools">
          <span>{manual ? bt("business.customContext") : context ? bt("business.followUpSameData") : bt("business.automaticContext")}</span>
          <button type="button" aria-expanded={contextOpen} aria-controls={contextId} onClick={() => setContextOpen(!contextOpen)}>{bt("business.adjustContext")}</button>
          {contextOpen ? <section id={contextId} role="dialog" aria-label={bt("business.adjustQueryContext")} className="query-context-adjustment" onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setContextOpen(false); composer.current?.focus(); } }}><header><strong>{bt("business.dataForYourQuestion")}</strong><button type="button" onClick={() => setContextOpen(false)} aria-label={bt("business.closeContext")}>×</button></header><p>{bt("business.chooseUpToThreeRelatedTablesStartANew")}</p>{manual ? <button type="button" onClick={() => pinContext(undefined)}>{bt("business.findContextAutomatically")}</button> : null}<label>{bt("business.searchData")}<input type="search" value={contextSearch} onChange={(e) => setContextSearch(e.target.value)} placeholder={bt("business.searchTables")} /></label><div className="query-context-options">{tables.filter((t) => objectLabel(t.key).toLowerCase().includes(contextSearch.toLowerCase())).map((table) => {
            const checked = manual?.tables.some((key) => objectId(key) === objectId(table.key)) ?? false;
            return <label key={objectId(table.key)}><input type="checkbox" checked={checked} disabled={!checked && (manual?.tables.length ?? 0) >= 3} onChange={(e) => { const next = e.target.checked ? [...manual?.tables ?? [], table.key] : manual?.tables.filter((key) => objectId(key) !== objectId(table.key)) ?? []; pinContext(next.length ? { root: next[0], tables: next } : undefined); }} /><span>{objectLabel(table.key)}</span></label>;
          })}</div></section> : null}
        </div>
        {composerError ? <p role="alert">{composerError}</p> : null}
        <form className="query-composer" onSubmit={(event) => { event.preventDefault(); submit(); }}>
          <label className="visually-hidden" htmlFor={questionId}>{bt("business.questionDetail")}</label>
          <textarea ref={composer} id={questionId} aria-label={bt("business.questionDetail")} value={question} wrap="soft" rows={2} maxLength={2000} placeholder={bt(turns.length ? "business.followUpQuestionPlaceholder" : "business.initialQuestionPlaceholder")} onChange={(e) => changeQuestion(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }} />
          <div className="query-composer-footer"><span><ActionIcon name="database" />{snapshot.database.name}<span className="query-model-name">{configured ? settings.source?.ai.model : bt("business.aINotConfigured")}</span></span><button className="query-compose-submit" type="submit" aria-label={turns.length ? bt("business.sendFollowUp") : bt("business.createSQLDraft")} disabled={!question.trim()}><ActionIcon name="chevronUp" /></button></div>
        </form>
        <p className="query-draft-footnote">{bt("business.enterToSendShiftEnterForANewLine")}</p>
      </div>
    </div>
  </section>;
}
