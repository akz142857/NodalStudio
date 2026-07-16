import { type FormEvent, useState } from "react";
import type { NodalStudioPlatform } from "../platform";

interface GitWorkspacePanelProps {
  sourceId: string;
  platform: NodalStudioPlatform;
  onImported: () => Promise<void>;
  defaultRepositoryPath: string;
  onOpenSettings: () => void;
}

export function GitWorkspacePanel({
  sourceId,
  platform,
  onImported,
  defaultRepositoryPath,
  onOpenSettings,
}: GitWorkspacePanelProps) {
  const [repositoryPath, setRepositoryPath] = useState(defaultRepositoryPath);
  const [status, setStatus] = useState<
    "idle" | "exporting" | "exported" | "importing" | "imported" | "mismatch" | "error"
  >("idle");
  const [summary, setSummary] = useState("");

  async function exportWorkspace(event: FormEvent) {
    event.preventDefault();
    setStatus("exporting");
    try {
      const result = await platform.exportGitWorkspace(sourceId, repositoryPath.trim());
      setSummary(
        `${result.writtenFiles} files · ${result.schemaFingerprint.slice(0, 8)}`,
      );
      setStatus("exported");
    } catch {
      setSummary("");
      setStatus("error");
    }
  }

  async function importWorkspace() {
    setStatus("importing");
    try {
      const preview = await platform.previewGitImport(sourceId, repositoryPath.trim());
      const conflictSummary = preview.relationshipConflicts.length
        ? `\n\n${preview.relationshipConflicts.length} local relationship conflict(s) will be overwritten:\n${preview.relationshipConflicts.join("\n")}`
        : "";
      if (!window.confirm(`Import ${preview.annotations} annotations and ${preview.logicalRelationships} logical relationships?${conflictSummary}\n\nNodal Studio will not modify the database.`)) {
        setStatus("idle");
        return;
      }
      const result = await platform.importGitWorkspace(sourceId, repositoryPath.trim());
      await onImported();
      setSummary(`${result.importedAnnotations} annotations · ${result.importedLogicalRelationships} relationships`);
      setStatus(result.fingerprintMatches ? "imported" : "mismatch");
    } catch {
      setSummary("");
      setStatus("error");
    }
  }

  return (
    <section className="git-workspace-panel">
      <div className="section-heading">
        <h3>Git workspace</h3>
        <span>Split files</span>
      </div>
      <p>
        Exports reviewable semantics only. Snapshots, layouts, credentials, and row data
        stay out of Git.
      </p>
      <button type="button" className="panel-settings-link" onClick={onOpenSettings}>Configure Git defaults</button>
      <form onSubmit={(event) => void exportWorkspace(event)}>
        <input
          aria-label="Repository directory"
          value={repositoryPath}
          onChange={(event) => setRepositoryPath(event.target.value)}
          placeholder="/absolute/path/to/repository"
          required
        />
        <div className="git-workspace-actions">
          <button
            type="submit"
            disabled={status === "exporting" || status === "importing"}
          >
            {status === "exporting" ? "Exporting…" : "Export .nodalstudio"}
          </button>
          <button
            type="button"
            disabled={
              !repositoryPath.trim() || status === "exporting" || status === "importing"
            }
            onClick={() => void importWorkspace()}
          >
            {status === "importing" ? "Importing…" : "Import semantics"}
          </button>
        </div>
        <small data-status={status}>
          {status === "exported"
            ? `Exported · ${summary}`
            : status === "imported"
              ? `Imported · ${summary}`
              : status === "mismatch"
                ? `Imported · ${summary} · schema fingerprint differs`
            : status === "error"
              ? "Choose an existing absolute directory"
              : "Migration/DDL remains the schema source of truth"}
        </small>
      </form>
    </section>
  );
}
