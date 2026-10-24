import { useI18n } from "../../i18n";
import { defineRegistry, JSONUIProvider, Renderer } from "@json-render/react";
import type { QueryExecutionResult, SqlDraft } from "../../platform";
import { queryAnswerCatalog, queryAnswerSpec } from "./query-answer-spec";
import { QueryResultArtifact } from "./QueryResultArtifact";

const { registry } = defineRegistry(queryAnswerCatalog, {
  components: {
    Answer: ({ children }) => <div className="query-answer-cards">{children}</div>,
    Summary: ({ props }) => <p className="query-answer-summary">{props.text}</p>,
    Notes: function Notes({ props }) { const { t: bt } = useI18n(); return <section className="query-answer-notes" data-clarification={props.clarification || undefined}><h4>{props.title}</h4><ul>{props.items.map((item, i) => <li key={i}>{item}</li>)}</ul>{props.clarification ? <p>{bt("business.replyBelowToRefineThisQuestion")}</p> : null}</section>; },
    Sql: function Sql({ props }) { const { t: bt } = useI18n(); return <section className="query-answer-sql"><header><strong>{bt("business.sQLDraft")}</strong><span>{bt("business.readyForReview")}</span></header><pre aria-label={bt("business.generatedSQL")}>{props.sql}</pre></section>; },
    Result: ({ props }) => <QueryResultArtifact {...props} />,
  },
});

export function QueryDraftAnswer({ draft, result, disabled, onUseSql }: { draft: SqlDraft; result?: QueryExecutionResult; disabled?: boolean; onUseSql?: (sql: string) => void }) {
  const { t: bt } = useI18n();
  const spec = queryAnswerSpec(draft, result, bt);
  const valid = queryAnswerCatalog.validate(spec);
  return <div className="query-generated-draft">
    {valid.success ? <JSONUIProvider registry={registry}><Renderer spec={spec} registry={registry} /></JSONUIProvider> : <p role="alert">{bt("business.unableToDisplayThisAnswerPleaseGenerateANew")}</p>}
    {valid.success && draft.sql && onUseSql ? <div className="query-answer-actions"><button type="button" disabled={disabled} onClick={() => onUseSql(draft.sql!)}>{bt("business.reviewInEditor")}</button><span>{result ? bt("business.runAgainFromSQLEditor") : bt("business.nothingHasRun")}</span></div> : null}
  </div>;
}
