import { useState } from "react";
import type {
  AiExplanation,
  ExplainSchemaInput,
  NodalStudioPlatform,
} from "../platform";

interface AiAssistantProps {
  platform: NodalStudioPlatform;
  input: Omit<ExplainSchemaInput, "aiEnabled" | "question" | "relationshipDepth">;
  onConfirmCandidate?: (candidate: string) => Promise<void>;
  enabled: boolean;
  providerLabel: string;
  onOpenSettings: () => void;
}

export function AiAssistant({ platform, input, onConfirmCandidate, enabled, providerLabel, onOpenSettings }: AiAssistantProps) {
  const [question, setQuestion] = useState("");
  const [depth, setDepth] = useState(1);
  const [result, setResult] = useState<AiExplanation>();
  const [status, setStatus] = useState<"idle" | "loading" | "error" | "confirmed">("idle");

  async function explain() {
    setStatus("loading");
    try {
      setResult(
        await platform.explainSchema({
          ...input,
          aiEnabled: enabled,
          question: question || undefined,
          relationshipDepth: depth,
        }),
      );
      setStatus("idle");
    } catch {
      setStatus("error");
    }
  }

  async function confirmCandidate() {
    if (!result?.candidateAnnotation || !onConfirmCandidate) return;
    setStatus("loading");
    try {
      await onConfirmCandidate(result.candidateAnnotation);
      setStatus("confirmed");
    } catch {
      setStatus("error");
    }
  }

  return (
    <section className="ai-assistant inspector-section">
      <div className="annotation-heading">
        <h3>AI explanation</h3>
        <span className="ai-provider-status">{enabled ? providerLabel : "Off"}</span>
      </div>
      <p className="ai-policy">Disabled by default · schema metadata only · no rows or credentials</p>
      {enabled ? (
        <>
          <textarea
            rows={2}
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="Optional question about this structure…"
          />
          {input.targetType === "table" ? (
            <label className="ai-depth">
              Relationship context
              <select value={depth} onChange={(event) => setDepth(Number(event.target.value))}>
                <option value={0}>Target only</option>
                <option value={1}>1 hop</option>
                <option value={2}>2 hops</option>
              </select>
            </label>
          ) : null}
          <button type="button" onClick={() => void explain()} disabled={status === "loading"}>
            {status === "loading" ? "Analyzing…" : "Explain from metadata"}
          </button>
        </>
      ) : <button type="button" className="panel-settings-link" onClick={onOpenSettings}>Configure in Settings → AI</button>}
      {status === "error" ? <p className="error-message">Explanation failed.</p> : null}
      {result ? (
        <div className="ai-result">
          <strong>{result.title}</strong>
          <p>{result.explanation}</p>
          <ul>
            {result.evidence.map((evidence) => (
              <li key={evidence}>{evidence}</li>
            ))}
          </ul>
          <small>
            Inferred candidate · {result.provider}{result.model ? ` · ${result.model}` : ""}{result.generatedAt ? ` · ${new Date(result.generatedAt).toLocaleString()}` : ""} · Context: {result.contextPolicy.relationshipDepth} hop · rows: no · credentials: no
          </small>
          {result.candidateAnnotation && onConfirmCandidate ? (
            <div className="candidate-annotation">
              <p>{result.candidateAnnotation}</p>
              <button type="button" onClick={() => void confirmCandidate()}>
                {status === "confirmed" ? "Annotation confirmed" : "Confirm and save annotation"}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
