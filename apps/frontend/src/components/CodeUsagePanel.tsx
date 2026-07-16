import { useEffect, useMemo, useState } from "react";
import type { CodeUsageResult, ObjectKey, NodalStudioPlatform } from "../platform";

interface CodeUsagePanelProps {
  platform: NodalStudioPlatform;
  sourceId: string;
  objectKey: ObjectKey;
}

export function CodeUsagePanel({ platform, sourceId, objectKey }: CodeUsagePanelProps) {
  const [usage, setUsage] = useState<CodeUsageResult>({ nodes: [], edges: [] });
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let disposed = false;
    void platform.getDatabaseCodeUsage(sourceId, objectKey).then(
      (result) => {
        if (disposed) return;
        setUsage(result);
        setStatus("ready");
      },
      () => {
        if (!disposed) setStatus("error");
      },
    );
    return () => {
      disposed = true;
    };
  }, [objectKey, platform, sourceId]);

  const codeNodes = useMemo(
    () => usage.nodes.filter((node) => node.kind !== "table" && node.kind !== "column"),
    [usage.nodes],
  );
  const counts = useMemo(() => {
    const result = new Map<string, number>();
    for (const node of codeNodes) result.set(node.kind, (result.get(node.kind) ?? 0) + 1);
    return [...result.entries()];
  }, [codeNodes]);

  return (
    <section className="code-usage-panel">
      <div className="section-heading">
        <h3>Used by project</h3>
        <span>{codeNodes.length}</span>
      </div>
      {status === "loading" ? <p>Loading local code evidence…</p> : null}
      {status === "error" ? <p data-status="error">Code usage is unavailable.</p> : null}
      {status === "ready" && !codeNodes.length ? (
        <p>No confirmed code references in the latest successful scans.</p>
      ) : null}
      {counts.length ? (
        <div className="code-usage-counts">
          {counts.map(([kind, count]) => <span key={kind}><b>{count}</b> {kind}</span>)}
        </div>
      ) : null}
      <ol>
        {codeNodes.map((node) => {
          const evidence = usage.edges
            .find((edge) => edge.sourceId === node.id || edge.targetId === node.id)
            ?.evidence[0];
          return (
            <li key={node.id}>
              <strong>{node.qualifiedName}</strong>
              <small>{evidence?.relativePath ?? node.relativePath}{evidence?.startLine ? `:${evidence.startLine}` : ""}</small>
              {evidence ? <span>{evidence.explanation} · {evidence.analyzer}</span> : null}
              {evidence?.relativePath || node.relativePath ? <button type="button" onClick={() => void platform.openCodeLocation(node.projectId, evidence?.relativePath ?? node.relativePath ?? "", evidence?.startLine ?? node.line)}>Open file</button> : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
