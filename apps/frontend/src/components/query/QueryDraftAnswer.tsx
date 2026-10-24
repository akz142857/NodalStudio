import { defineRegistry, JSONUIProvider, Renderer } from "@json-render/react";
import type { QueryExecutionResult, SqlDraft } from "../../platform";
import { queryAnswerCatalog, queryAnswerSpec } from "./query-answer-spec";
import { QueryResultArtifact } from "./QueryResultArtifact";

const { registry } = defineRegistry(queryAnswerCatalog, {
  components: {
    Answer: ({ children }) => <div className="query-answer-cards">{children}</div>,
    Summary: ({ props }) => <p className="query-answer-summary">{props.text}</p>,
    Notes: ({ props }) => <section className="query-answer-notes" data-clarification={props.clarification || undefined}><h4>{props.title}</h4><ul>{props.items.map((item, i) => <li key={i}>{item}</li>)}</ul>{props.clarification ? <p>Reply below to refine this question.</p> : null}</section>,
    Sql: ({ props }) => <section className="query-answer-sql"><header><strong>SQL draft</strong><span>Ready for review</span></header><pre aria-label="Generated SQL">{props.sql}</pre></section>,
    Result: ({ props }) => <QueryResultArtifact {...props} />,
  },
});

export function QueryDraftAnswer({ draft, result, disabled, onUseSql }: { draft: SqlDraft; result?: QueryExecutionResult; disabled?: boolean; onUseSql?: (sql: string) => void }) {
  const spec = queryAnswerSpec(draft, result);
  const valid = queryAnswerCatalog.validate(spec);
  return <div className="query-generated-draft">
    {valid.success ? <JSONUIProvider registry={registry}><Renderer spec={spec} registry={registry} /></JSONUIProvider> : <p role="alert">Unable to display this answer. Please generate a new draft.</p>}
    {valid.success && draft.sql && onUseSql ? <div className="query-answer-actions"><button type="button" disabled={disabled} onClick={() => onUseSql(draft.sql!)}>Review in editor</button><span>{result ? "Run again from SQL editor" : "Nothing has run"}</span></div> : null}
  </div>;
}
