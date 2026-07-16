import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { NodalStudioPlatform } from "../platform";

export function AiReviewQueue({ platform, scanIds, onGraphChanged }: { platform: NodalStudioPlatform; scanIds: string[]; onGraphChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState<string>();
  const queue = useQuery({ queryKey: ["ai-review", ...scanIds], queryFn: async () => Promise.all(scanIds.map(async (scanId) => ({ scanId, preview: await platform.previewAiProjectContext(scanId), candidates: await platform.listAiCandidates(scanId) }))), enabled: scanIds.length > 0 });
  const pending = (queue.data ?? []).flatMap((item) => item.candidates).filter((candidate) => candidate.status === "pending");
  async function analyze(scanId: string) { setRunning(scanId); try { await platform.runAiProjectAnalysis(scanId); await queue.refetch(); } finally { setRunning(undefined); } }
  async function review(scanId: string, candidateId: string, decision: "confirmed" | "rejected") { await platform.reviewAiCandidate(scanId, candidateId, decision); await queue.refetch(); if (decision === "confirmed") onGraphChanged(); }
  return <section className="ai-review-queue" data-open={open || undefined}>
    <button type="button" className="ai-review-toggle" onClick={() => setOpen(!open)}>AI review <b>{pending.length}</b></button>
    {open ? <div className="ai-review-popover"><header><strong>AI request preview & review</strong><button type="button" onClick={() => setOpen(false)}>×</button></header>{(queue.data ?? []).map(({ scanId, preview, candidates }) => <article key={scanId}><p><b>{preview.model ?? "No Analysis Model"}</b> · {preview.networkUsed ? "network" : "local/no network"} · {preview.requestCount} bounded request(s), at most {preview.maxRequestNodes} nodes each · {preview.nodeCount} indexed nodes · {preview.edgeCount} relations · {preview.sourceExcerpts} source excerpts · uncommitted code: {preview.uncommittedCodeIncluded ? "yes" : "no"}</p><button type="button" disabled={!preview.connectionId || running === scanId} onClick={() => void analyze(scanId)}>{running === scanId ? "Analyzing…" : "Run AI analysis"}</button>{candidates.filter((candidate) => candidate.status === "pending").map((candidate) => <div className="ai-candidate" key={candidate.id}><strong>{candidate.proposedEdge.kind}</strong><span>{candidate.proposedEdge.sourceId.slice(0, 8)} → {candidate.proposedEdge.targetId.slice(0, 8)}</span><p>{candidate.explanation}</p><small>{candidate.model} · {candidate.proposedEdge.evidence.length} existing evidence item(s)</small><div><button type="button" onClick={() => void review(scanId, candidate.id, "confirmed")}>Confirm</button><button type="button" onClick={() => void review(scanId, candidate.id, "rejected")}>Reject</button></div></div>)}</article>)}</div> : null}
  </section>;
}
