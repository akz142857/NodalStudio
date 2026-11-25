import { useEffect, useRef, useState } from "react";
import { Button } from "../design-system/Button";
import { useI18n } from "../i18n";
import type { DataSourceProfile, NodalStudioPlatform } from "../platform";
import type { ConnectionSyncPreview, PortableConnection } from "../platform/types";
import { isServerConnection } from "../platform/database-server";
import { connectionSyncError, isValidSyncPassphrase } from "./connection-sync-messages";

const tlsLabels = {
  disable: "business.disable",
  prefer: "business.prefer",
  require: "business.require",
  verifyCa: "business.verifyCA",
  verifyFull: "business.verifyFull",
} as const;

const sshLabels = {
  agent: "connectionSync.sshAgent",
  privateKey: "business.privateKey",
  password: "business.password",
} as const;

const actionLabels = {
  add: "connectionSync.add",
  update: "connectionFolder.updateName",
  unchanged: "connectionSync.unchanged",
  conflict: "connectionSync.keepBoth",
} as const;

function ConnectionDetails({ connection }: { connection: PortableConnection }) {
  const { t } = useI18n();
  const engine = { postgreSql: "PostgreSQL", mySql: "MySQL", sqlite: "SQLite" }[connection.databaseType];
  const host = connection.host.includes(":") && !connection.host.startsWith("[") ? "[" + connection.host + "]" : connection.host;
  return <div className="connection-sync-details">
    <strong>{connection.displayName}</strong>
    <span>{engine} · {isServerConnection(connection) ? t("serverConnection.serverConnection") : connection.database}</span>
    {connection.databaseType !== "sqlite" ? <>
      <span>{connection.username}@{host}:{connection.port}</span>
      <span>TLS · {t(tlsLabels[connection.sslMode])}</span>
      {connection.ssh ? <span>SSH · {connection.ssh.username}@{connection.ssh.host}:{connection.ssh.port} · {t(sshLabels[connection.ssh.authentication])}</span> : null}
    </> : null}
  </div>;
}

export function ConnectionMergeRows({ rows }: { rows: ConnectionSyncPreview["rows"] }) {
  const { t } = useI18n();
  return <ul className="connection-sync-preview">
    {rows.map(({ connection, action, existing }, index) => <li key={index}>
      <div className="connection-sync-preview-heading">{t(actionLabels[action])}</div>
      <div className={existing ? "connection-sync-versions" : undefined}>
        {existing ? <div><span className="connection-sync-version-label">{t("connectionSync.matchedVersion")}</span><ConnectionDetails connection={existing} /></div> : null}
        <div>{existing ? <span className="connection-sync-version-label">{t("connectionSync.incomingVersion")}</span> : null}<ConnectionDetails connection={connection} /></div>
      </div>
    </li>)}
  </ul>;
}

function fileName(path: string): string {
  return path.split(/[/\\]/).at(-1) ?? "";
}

export function ConnectionSync({ platform, hasProfiles, startWithImport, busy, onBusyChange, onBack, onImported }: {
  platform: NodalStudioPlatform;
  hasProfiles: boolean;
  startWithImport: boolean;
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
  onBack: () => void;
  onImported: (profiles: DataSourceProfile[]) => void;
}) {
  const { t } = useI18n();
  const [mode, setMode] = useState<"export" | "import">(startWithImport || !hasProfiles ? "import" : "export");
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [path, setPath] = useState("");
  const [preview, setPreview] = useState<ConnectionSyncPreview>();
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState("");
  const title = useRef<HTMLHeadingElement>(null);
  const validPassphrase = isValidSyncPassphrase(passphrase);
  const addCount = preview?.rows.filter(({ action }) => action === "add").length ?? 0;
  const conflictCount = preview?.rows.filter(({ action }) => action === "conflict").length ?? 0;
  const unchangedCount = preview?.rows.filter(({ action }) => action === "unchanged").length ?? 0;

  useEffect(() => { title.current?.focus(); }, [preview]);

  function reset(nextMode: typeof mode) {
    setMode(nextMode);
    setPassphrase("");
    setConfirmation("");
    setPath("");
    setError("");
    setReceipt("");
  }

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setError("");
    setReceipt("");
    onBusyChange(true);
    try {
      await action();
    } catch (reason) {
      if (reason === "stalePreview") setPreview(undefined);
      setError(t(connectionSyncError(reason)));
    } finally {
      onBusyChange(false);
    }
  }

  function exportConnections() {
    void run(async () => {
      const folder = await platform.pickWorkspacePath("connectionSyncFolder");
      if (!folder) return;
      const result = await platform.exportConnectionSync(folder, passphrase);
      setPassphrase("");
      setConfirmation("");
      const summary = result.count === 1
        ? t("connectionSync.exportedOne", { fileName: result.fileName })
        : t("connectionSync.exported", { count: result.count, fileName: result.fileName });
      setReceipt(result.skipped > 0 ? summary + " " + t("connectionSync.exportSkipped", { count: result.skipped }) : summary);
    });
  }

  function chooseImportFile() {
    void run(async () => {
      const file = await platform.pickWorkspacePath("openConnectionSync");
      if (file) setPath(file);
    });
  }

  function previewImport() {
    void run(async () => setPreview(await platform.previewConnectionSync(path, passphrase)));
  }

  function importConnections() {
    if (!preview) return;
    void run(async () => {
      const profiles = await platform.importConnectionSync(path, passphrase, preview.token);
      setPassphrase("");
      setPath("");
      setPreview(undefined);
      onImported(profiles);
      setReceipt(profiles.length === 1 ? t("connectionSync.importedOne") : t("connectionSync.imported", { count: profiles.length }));
    });
  }

  return <>
    <h2 ref={title} id="connection-manager-title" tabIndex={-1}>{t(preview ? "connectionSync.previewTitle" : "connectionSync.title")}</h2>
    {preview ? <>
      <p className="connection-sync-summary">{t("connectionSync.previewSummary", { addCount, conflictCount, unchangedCount })}</p>
      {conflictCount ? <p className="connection-sync-note">{t("connectionSync.conflictNote")}</p> : null}
      <ConnectionMergeRows rows={preview.rows} />
      {error ? <p className="connection-manager-error" role="alert">{error}</p> : null}
      <footer>
        <Button disabled={busy} onClick={() => setPreview(undefined)}>{t("connectionSync.back")}</Button>
        {addCount + conflictCount > 0
          ? <Button disabled={busy} onClick={importConnections}>{t("connectionSync.confirmImport")}</Button>
          : <Button disabled={busy} onClick={onBack}>{t("business.done")}</Button>}
      </footer>
    </> : <>
      <div className="connection-sync-modes" role="group" aria-label={t("connectionSync.title")}>
        <Button aria-pressed={mode === "export"} disabled={busy || !hasProfiles} onClick={() => reset("export")}>{t("connectionSync.export")}</Button>
        <Button aria-pressed={mode === "import"} disabled={busy} onClick={() => reset("import")}>{t("connectionSync.import")}</Button>
      </div>
      <p className="connection-sync-note">{t(mode === "export" ? "connectionSync.exportHint" : "connectionSync.importHint")}</p>
      <p className="connection-sync-note">{t("connectionSync.localSecrets")}</p>
      <form className="connection-sync-form" autoComplete="off" onSubmit={(event) => {
        event.preventDefault();
        if (!validPassphrase) return;
        if (mode === "export" && passphrase === confirmation) exportConnections();
        if (mode === "import" && path) previewImport();
      }}>
        {mode === "import" ? <div className="connection-sync-file">
          <Button type="button" disabled={busy} onClick={chooseImportFile}>{t("connectionSync.chooseFile")}</Button>
          {path ? <span title={fileName(path)}>{fileName(path)}</span> : null}
        </div> : null}
        <label>{t("connectionSync.passphrase")}
          <input type="password" autoComplete={mode === "export" ? "new-password" : "off"} disabled={busy} value={passphrase} onChange={(event) => { setPassphrase(event.target.value); setError(""); }} />
        </label>
        {mode === "export" ? <>
          <label>{t("connectionSync.confirmPassphrase")}
            <input type="password" autoComplete="new-password" disabled={busy} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} />
          </label>
          <p className="connection-sync-note">{t("connectionSync.passphraseHint")}</p>
          {confirmation && passphrase !== confirmation ? <p className="connection-manager-error">{t("connectionSync.passphraseMismatch")}</p> : null}
        </> : null}
        {error ? <p className="connection-manager-error" role="alert">{error}</p> : null}
        {receipt ? <p className="connection-sync-receipt" role="status">{receipt}</p> : null}
        <footer>
          <Button type="button" disabled={busy} onClick={onBack}>{t("connectionSync.back")}</Button>
          <Button type="submit" disabled={busy || !validPassphrase || (mode === "export" ? passphrase !== confirmation : !path)}>
            {t(mode === "export" ? "connectionSync.chooseFolder" : "connectionSync.previewImport")}
          </Button>
        </footer>
      </form>
    </>}
  </>;
}
