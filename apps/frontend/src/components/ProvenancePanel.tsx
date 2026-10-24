import { useI18n } from "../i18n";
import { type FormEvent, useState } from "react";
import type { NodalStudioPlatform } from "../platform";

interface ProvenancePanelProps {
  changeSetId: string;
  platform: NodalStudioPlatform;
}

export function ProvenancePanel({ changeSetId, platform }: ProvenancePanelProps) {
  const { t: bt } = useI18n();
  const [branch, setBranch] = useState("");
  const [commitSha, setCommitSha] = useState("");
  const [pullRequestUrl, setPullRequestUrl] = useState("");
  const [migrations, setMigrations] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string>();

  async function save(event: FormEvent) {
    event.preventDefault();
    setStatus("saving");
    try {
      await platform.saveChangeProvenance({
        changeSetId,
        branch: branch || null,
        commitSha: commitSha || null,
        pullRequestUrl: pullRequestUrl || null,
        migrationFiles: migrations.split(",").map((value) => value.trim()).filter(Boolean),
      });
      setStatus("saved");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setStatus("error");
    }
  }

  return (
    <form className="provenance-panel inspector-section" onSubmit={(event) => void save(event)}>
      <label>{bt("businessSupport.branch")}<input aria-label={bt("businessSupport.gitBranch")} value={branch} onChange={(event) => setBranch(event.target.value)} placeholder={bt("businessSupport.branch")} /></label>
      <label>{bt("businessSupport.commit")}<input aria-label={bt("businessSupport.commitSHA")} value={commitSha} onChange={(event) => setCommitSha(event.target.value)} placeholder={bt("businessSupport.commitSHA")} /></label>
      <label>{bt("businessSupport.pullRequest")}<input aria-label={bt("businessSupport.pullRequestURL")} value={pullRequestUrl} onChange={(event) => setPullRequestUrl(event.target.value)} placeholder={bt("businessSupport.pullRequestURL")} /></label>
      <label>{bt("businessSupport.migrationFiles")}<input aria-label={bt("businessSupport.migrationFiles")} value={migrations} onChange={(event) => setMigrations(event.target.value)} placeholder="001.sql, 002.sql" /></label>
      <div className="inspector-actions"><button type="submit" disabled={status === "saving"}>{bt("businessSupport.saveEvidence")}</button></div>
      <small>{status === "saved" ? bt("businessSupport.evidenceSaved") : status === "error" ? (error ?? bt("businessSupport.saveFailed")) : bt("businessSupport.optionalMetadata")}</small>
    </form>
  );
}
