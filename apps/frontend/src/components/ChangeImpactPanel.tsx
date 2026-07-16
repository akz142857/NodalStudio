import { useEffect, useMemo, useState } from "react";
import type { DatabaseSnapshot, NodalStudioPlatform, SchemaChangeSet } from "../platform";
import { loadChangeImpacts, type ChangeImpact } from "../graph/change-impact";

interface ChangeImpactPanelProps { platform: NodalStudioPlatform; snapshot: DatabaseSnapshot; changeSet: SchemaChangeSet; }
export function ChangeImpactPanel({ platform, snapshot, changeSet }: ChangeImpactPanelProps) {
  const [impacts, setImpacts] = useState<ChangeImpact[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  useEffect(() => {
    let disposed = false;
    void loadChangeImpacts(platform, snapshot, changeSet).then((result) => {
      if (!disposed) { setImpacts(result); setStatus("ready"); }
    }, () => { if (!disposed) setStatus("error"); });
    return () => { disposed = true; };
  }, [changeSet, platform, snapshot]);
  const summary = useMemo(() => {
    const direct = new Set<string>(); const potential = new Set<string>();
    for (const impact of impacts) for (const node of impact.nodes.filter((candidate) => !["table", "column"].includes(candidate.kind))) {
      (impact.potential ? potential : direct).add(node.id);
    }
    return { direct: direct.size, potential: potential.size };
  }, [impacts]);
  return <section className="change-impact-panel">
    <div className="section-heading"><h3>Code impact</h3><span>{summary.direct + summary.potential}</span></div>
    {status === "loading" ? <p>Tracing changes through the latest project scans…</p> : null}
    {status === "error" ? <p data-status="error">Code impact could not be calculated.</p> : null}
    {status === "ready" && !impacts.length ? <p>No code usage was found for these database objects.</p> : null}
    {impacts.length ? <div className="impact-summary"><span><b>{summary.direct}</b> direct</span><span><b>{summary.potential}</b> potential</span></div> : null}
    {impacts.map((impact, index) => {
      const codeNodes = impact.nodes.filter((node) => !["table", "column"].includes(node.kind));
      return <article key={`${impact.operation.operationType}:${impact.target.schema}.${impact.target.name}:${index}`}>
        <header><span data-risk={impact.operation.risk}>{impact.operation.operationType}</span><strong>{impact.target.schema}.{impact.target.name}</strong><em>{impact.potential ? "potential" : "direct"}</em></header>
        <ol>{codeNodes.slice(0, 8).map((node) => {
          const evidence = impact.edges.find((edge) => edge.sourceId === node.id || edge.targetId === node.id)?.evidence[0];
          return <li key={node.id}><strong>{node.qualifiedName}</strong><small>{evidence?.relativePath ?? node.relativePath}{evidence?.startLine ? `:${evidence.startLine}` : ""}</small></li>;
        })}</ol>
      </article>;
    })}
  </section>;
}
