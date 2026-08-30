import { type FormEvent, useState } from "react";
import type { NodalStudioPlatform } from "../platform";

interface ProvenancePanelProps {
  changeSetId: string;
  platform: NodalStudioPlatform;
}

export function ProvenancePanel({ changeSetId, platform }: ProvenancePanelProps) {
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
      <h3>Git & migration evidence</h3>
      <input aria-label="Git branch" value={branch} onChange={(event) => setBranch(event.target.value)} placeholder="Branch" />
      <input aria-label="Commit SHA" value={commitSha} onChange={(event) => setCommitSha(event.target.value)} placeholder="Commit SHA" />
      <input aria-label="Pull request URL" value={pullRequestUrl} onChange={(event) => setPullRequestUrl(event.target.value)} placeholder="Pull request URL" />
      <input aria-label="Migration files" value={migrations} onChange={(event) => setMigrations(event.target.value)} placeholder="001.sql, 002.sql" />
      <button type="submit" disabled={status === "saving"}>Save evidence</button>
      <small>{status === "saved" ? "Evidence saved" : status === "error" ? (error ?? "Save failed") : "Optional metadata"}</small>
    </form>
  );
}
