import { useI18n } from "../i18n";
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
  const { t: bt, formatDate } = useI18n();
  const [question, setQuestion] = useState("");
  const [depth, setDepth] = useState(1);
  const [result, setResult] = useState<AiExplanation>();
  const [status, setStatus] = useState<"idle" | "loading" | "error" | "confirmed">("idle");
  const [error, setError] = useState<string>();

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
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setStatus("error");
    }
  }

  async function confirmCandidate() {
    if (!result?.candidateAnnotation || !onConfirmCandidate) return;
    setStatus("loading");
    try {
      await onConfirmCandidate(result.candidateAnnotation);
      setStatus("confirmed");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setStatus("error");
    }
  }

  return (
    <section className="ai-assistant inspector-section">
      <div className="annotation-heading">
        <h3>{bt("businessSupport.aIExplanation")}</h3>
        <span className="ai-provider-status">{enabled ? providerLabel : bt("businessSupport.off")}</span>
      </div>
      <p className="ai-policy">{bt("businessSupport.disabledByDefaultSchemaMetadataOnlyNoRowsOr")}</p>
      {enabled ? (
        <>
          <textarea
            rows={2}
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder={bt("businessSupport.optionalQuestionAboutThisStructure")}
          />
          {input.targetType === "table" ? (
            <label className="ai-depth">
              {bt("businessSupport.relationshipContext")}<select value={depth} onChange={(event) => setDepth(Number(event.target.value))}>
                <option value={0}>{bt("businessSupport.targetOnly")}</option>
                <option value={1}>{bt("businessSupport.1Hop")}</option>
                <option value={2}>{bt("businessSupport.2Hops")}</option>
              </select>
            </label>
          ) : null}
          <button type="button" onClick={() => void explain()} disabled={status === "loading"}>
            {status === "loading" ? bt("businessSupport.analyzing") : bt("businessSupport.explainFromMetadata")}
          </button>
        </>
      ) : <button type="button" className="panel-settings-link" onClick={onOpenSettings}>{bt("businessSupport.configureInSettingsAI")}</button>}
      {status === "error" ? <p className="error-message">{error ?? bt("businessSupport.explanationFailed")}</p> : null}
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
            {bt("businessSupport.inferredCandidate")} {result.provider}{result.model ? ` · ${result.model}` : ""}{result.generatedAt ? ` · ${formatDate(result.generatedAt)}` : ""} {bt("businessSupport.context")} {result.contextPolicy.relationshipDepth} {bt("businessSupport.hopRowsNoCredentialsNo")}</small>
          {result.candidateAnnotation && onConfirmCandidate ? (
            <div className="candidate-annotation">
              <p>{result.candidateAnnotation}</p>
              <button type="button" onClick={() => void confirmCandidate()}>
                {status === "confirmed" ? bt("businessSupport.annotationConfirmed") : bt("businessSupport.confirmAndSaveAnnotation")}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
