import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "../../design-system/Button";
import { useI18n } from "../../i18n";
import type { CodeDefinitionPosition, CodeDocumentOutlineResult, CodeOutlineSymbol } from "../../platform/code-review";
import { ActionIcon } from "../ActionIcon";

type Locate = (position: CodeDefinitionPosition) => void;

function OutlineItem({ symbol, locate }: { symbol: CodeOutlineSymbol; locate: Locate }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(true);
  const childrenId = useId();
  const hasChildren = symbol.children.length > 0;
  const kind = [5, 10, 11, 23].includes(symbol.kind) ? "type" : [6, 9, 12, 25].includes(symbol.kind) ? "callable" : "value";
  return <li>
    <div className="code-outline-row">
      {hasChildren ? <button type="button" className="code-outline-disclosure" aria-expanded={expanded} aria-controls={childrenId}
        aria-label={t(expanded ? "codeReview.outlineCollapse" : "codeReview.outlineExpand", { name: symbol.name })}
        onClick={() => setExpanded((value) => !value)}>
        <ActionIcon name={expanded ? "chevronDown" : "chevronRight"} />
      </button> : <span className="code-outline-disclosure" />}
      <button type="button" className="code-outline-symbol" data-kind={kind} title={symbol.name} onClick={() => locate(symbol.position)}>
        <ActionIcon name={kind === "type" ? "relationships" : kind === "callable" ? "codeDocument" : "document"} />
        <span>{symbol.name}</span>
      </button>
    </div>
    {hasChildren && <ul id={childrenId} hidden={!expanded}>
      {symbol.children.map((child) => <OutlineItem key={symbolKey(child)} symbol={child} locate={locate} />)}
    </ul>}
  </li>;
}

const symbolKey = (symbol: CodeOutlineSymbol) => `${symbol.position.line}:${symbol.position.character}:${symbol.kind}:${symbol.name}`;

export function CodeReviewOutline({ queryKey, load, locate, onRefresh }: {
  queryKey: readonly unknown[];
  load: (enable: boolean) => Promise<CodeDocumentOutlineResult>;
  locate: Locate;
  onRefresh: () => void;
}) {
  const { t } = useI18n();
  const client = useQueryClient();
  const query = useQuery({ queryKey, queryFn: () => load(false), retry: false, gcTime: 30_000 });
  const approve = useMutation({ mutationFn: () => load(true), onSuccess: (result) => { client.setQueryData(queryKey, result); } });
  const result = query.data;
  const failure = query.isError || approve.isError || result?.state === "unavailable" ? t("codeReview.outlineUnavailable")
    : result?.state === "missingServer" ? t("codeReview.outlineMissingServer", { command: result.command })
    : result?.state === "serverFailed" ? t("codeReview.outlineServerFailed", { command: result.command })
    : result?.state === "stale" ? t("codeReview.outlineStale") : undefined;
  return <div aria-busy={query.isFetching || approve.isPending}>
      {query.isPending || approve.isPending ? <p role="status">{t("codeReview.outlineLoading")}</p>
        : failure ? <div className="code-outline-message">
          <p role="status">{failure}</p>
          <Button size="small" variant="secondary" disabled={query.isFetching} onClick={() => {
            approve.reset();
            if (result?.state === "stale") onRefresh();
            else void query.refetch();
          }}>{t(result?.state === "stale" ? "codeReview.refresh" : "codeReview.outlineRetry")}</Button>
        </div>
        : result?.state === "disabled" ? <div className="code-outline-message">
          <p>{t("codeReview.outlineTrust")}</p>
          <Button size="small" variant="secondary" onClick={() => approve.mutate()}>{t("codeReview.outlineEnable")}</Button>
        </div>
        : result?.state === "ready" && result.symbols.length > 0 ? <ul>
          {result.symbols.map((symbol) => <OutlineItem key={symbolKey(symbol)} symbol={symbol} locate={locate} />)}
        </ul> : <p role="status">{t("codeReview.outlineEmpty")}</p>}
  </div>;
}
