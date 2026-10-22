import type { SaveDataSourceInput } from "../platform";
import type { ConnectionTestState } from "./connection-test-state";

type Tone = "success" | "error" | "warning" | "running" | "neutral";
interface Check { name: string; label: string; tone: Tone }
const phaseLabels = {
  configuration: "Checking settings and credentials…",
  ssh: "Establishing the SSH tunnel…",
  handshake: "Connecting to the database and negotiating TLS…",
  metadata: "Verifying database access…",
  tls: "Checking transport encryption…",
};
const stageLabels = { configuration: "Check connection settings", ssh: "SSH connection failed", tls: "TLS verification failed", database: "Database connection failed", timeout: "Connection test timed out", cancelled: "Connection test cancelled" };
function StatusIcon({ tone }: { tone: Tone }) {
  return <svg className={`connection-check-icon ${tone === "running" ? "is-spinning" : ""}`} aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    {tone === "running" ? <><circle cx="10" cy="10" r="7.5" opacity=".2" /><path d="M10 2.5a7.5 7.5 0 0 1 7.5 7.5" /></> : tone === "warning" ? <><path d="M9 3 2 15.5a1 1 0 0 0 1 1.5h14a1 1 0 0 0 1-1.5L11 3a1.2 1.2 0 0 0-2 0Z" /><path d="M10 7v4m0 3h.01" /></> : <><circle cx="10" cy="10" r="7.5" />{tone === "success" ? <path d="m6.5 10 2.3 2.3 4.7-5" /> : tone === "error" ? <path d="m7.5 7.5 5 5m0-5-5 5" /> : <path d="M7 10h6" />}</>}
  </svg>;
}
export function ConnectionTestStatus({ state, form, onCancel }: { state: ConnectionTestState; form: SaveDataSourceInput; onCancel?: () => void }) {
  if (state.status === "idle") return null;
  const running = state.status === "testing";
  const cancelled = state.status === "cancelled";
  const progress = running || cancelled || state.status === "error" ? state.progress : undefined;
  const phase = progress?.phase ?? "configuration";
  const result = state.status === "success" ? state.result : undefined;
  const failure = state.status === "error" ? state.failure : undefined;
  const sshConnected = Boolean(result || failure?.sshConnected || progress?.sshConnected);
  const databaseConnected = Boolean(result || phase === "tls" && (running || cancelled || state.status === "error"));
  const busy = running && (phase === "handshake" || phase === "metadata");
  const ssh: Check = { name: "SSH", label: "Waiting", tone: "neutral" };
  if (!form.security?.ssh) ssh.label = "Not enabled";
  else if (sshConnected) Object.assign(ssh, { label: "Connected", tone: "success" });
  else if (failure?.stage === "ssh") Object.assign(ssh, { label: "Failed", tone: "error" });
  else if (running && phase === "ssh") Object.assign(ssh, { label: "Connecting", tone: "running" });
  else if (!running) ssh.label = cancelled ? "Cancelled" : "Not tested";
  const tls: Check = { name: "TLS", label: running ? "Waiting" : "Not verified", tone: "neutral" };
  if (form.sslMode === "disable") tls.label = "Not enabled";
  else if (result?.sslActive === true) Object.assign(tls, { label: form.sslMode === "verifyFull" ? "Certificate & hostname verified" : form.sslMode === "verifyCa" ? "Certificate verified" : "Encrypted", tone: "success" });
  else if (result) Object.assign(tls, { label: result.sslActive === false ? "Not encrypted" : "Not verified", tone: "warning" });
  else if (failure?.stage === "tls") Object.assign(tls, { label: "Failed", tone: "error" });
  else if (busy || running && phase === "tls") Object.assign(tls, { label: phase === "handshake" ? "Negotiating" : "Checking", tone: "running" });
  const database: Check = { name: "Database", label: running ? "Waiting" : "Not tested", tone: "neutral" };
  if (databaseConnected) Object.assign(database, { label: "Connected", tone: "success" });
  else if (failure?.stage === "database") Object.assign(database, { label: "Failed", tone: "error" });
  else if (busy) Object.assign(database, { label: phase === "metadata" ? "Verifying access" : "Connecting", tone: "running" });
  else if (cancelled && phase !== "configuration" && phase !== "ssh") database.label = "Cancelled";
  const warning = tls.tone === "warning";
  const tone: Tone = running ? "running" : failure ? "error" : cancelled ? "neutral" : warning ? "warning" : "success";
  const title = running ? state.cancelling ? "Cancelling connection test…" : "Testing connection" : failure ? stageLabels[failure.stage] : cancelled ? "Connection test cancelled" : warning ? "Connected · review TLS" : "Connection successful";
  const detail = running ? state.cancelling ? "Stopping this test and closing its connection." : phaseLabels[phase] : failure?.message ?? (cancelled ? "Nothing was saved. You can change the settings or test again." : warning ? result?.sslActive === false ? "Connected without TLS. Choose Require or Verify full to require encryption." : "The server did not report TLS status. Encryption could not be confirmed." : "The connection is ready. Settings and passwords are saved only when you choose Save.");
  return <section className="connection-test-status" role={failure ? "alert" : "status"} aria-label="Connection test result" data-state={state.status}>
    <div className="connection-test-heading">
      <div data-tone={tone}><StatusIcon tone={tone} /><strong>{title}</strong></div>
      {running && onCancel ? <button type="button" className="connection-test-cancel" onClick={onCancel} disabled={state.cancelling} aria-label="Cancel connection test">{state.cancelling ? "Cancelling…" : "Cancel test"}</button> : null}
    </div>
    <div className="connection-test-checks">{[ssh, tls, database].map((check) => <div className="connection-test-check" role="group" aria-label={`${check.name} status`} data-tone={check.tone} key={check.name}>
      <StatusIcon tone={check.tone} /><div><span>{check.name}</span><strong>{check.label}</strong></div>
    </div>)}</div>
    {running ? <div className="connection-test-progress" role="progressbar" aria-label="Connection test progress" aria-valuetext={detail}><span /></div> : null}
    <p className="connection-test-detail">{detail}</p>
  </section>;
}
