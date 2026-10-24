import { translateConnectionFailure } from "../i18n/connection-errors";
import { useI18n } from "../i18n";
import type { SaveDataSourceInput } from "../platform";
import type { ConnectionTestState } from "./connection-test-state";

type Tone = "success" | "error" | "warning" | "running" | "neutral";
interface Check { name: string; label: string; tone: Tone }


function StatusIcon({ tone }: { tone: Tone }) {
  return <svg className={`connection-check-icon ${tone === "running" ? "is-spinning" : ""}`} aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    {tone === "running" ? <><circle cx="10" cy="10" r="7.5" opacity=".2" /><path d="M10 2.5a7.5 7.5 0 0 1 7.5 7.5" /></> : tone === "warning" ? <><path d="M9 3 2 15.5a1 1 0 0 0 1 1.5h14a1 1 0 0 0 1-1.5L11 3a1.2 1.2 0 0 0-2 0Z" /><path d="M10 7v4m0 3h.01" /></> : <><circle cx="10" cy="10" r="7.5" />{tone === "success" ? <path d="m6.5 10 2.3 2.3 4.7-5" /> : tone === "error" ? <path d="m7.5 7.5 5 5m0-5-5 5" /> : <path d="M7 10h6" />}</>}
  </svg>;
}
export function ConnectionTestStatus({ state, form, onCancel }: { state: ConnectionTestState; form: SaveDataSourceInput; onCancel?: () => void }) {
  const { t: bt } = useI18n();
  const stageLabels = { configuration: bt("business.checkConnectionSettings"), ssh: bt("business.sSHConnectionFailed"), tls: bt("business.tLSVerificationFailed"), database: bt("business.databaseConnectionFailed"), timeout: bt("business.connectionTestTimedOut"), cancelled: bt("business.connectionTestCancelled") };
  const phaseLabels = {
  configuration: bt("business.checkingSettingsAndCredentials"),
  ssh: bt("business.establishingTheSSHTunnel"),
  handshake: bt("business.connectingToTheDatabaseAndNegotiatingTLS"),
  metadata: bt("business.verifyingDatabaseAccess"),
  tls: bt("business.checkingTransportEncryption"),
};
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
  const ssh: Check = { name: "SSH", label: bt("business.waiting"), tone: "neutral" };
  if (!form.security?.ssh) ssh.label = bt("business.notEnabled");
  else if (sshConnected) Object.assign(ssh, { label: bt("business.connected"), tone: "success" });
  else if (failure?.stage === "ssh") Object.assign(ssh, { label: bt("business.failed"), tone: "error" });
  else if (running && phase === "ssh") Object.assign(ssh, { label: bt("business.connecting"), tone: "running" });
  else if (!running) ssh.label = cancelled ? bt("business.cancelled") : bt("business.notTested");
  const tls: Check = { name: "TLS", label: running ? bt("business.waiting") : bt("business.notVerified"), tone: "neutral" };
  if (form.sslMode === "disable") tls.label = bt("business.notEnabled");
  else if (result?.sslActive === true) Object.assign(tls, { label: form.sslMode === "verifyFull" ? bt("business.certificateHostnameVerified") : form.sslMode === "verifyCa" ? bt("business.certificateVerified") : bt("business.encrypted"), tone: "success" });
  else if (result) Object.assign(tls, { label: result.sslActive === false ? bt("business.notEncrypted") : bt("business.notVerified"), tone: "warning" });
  else if (failure?.stage === "tls") Object.assign(tls, { label: bt("business.failed"), tone: "error" });
  else if (busy || running && phase === "tls") Object.assign(tls, { label: phase === "handshake" ? bt("business.negotiating") : bt("business.checking"), tone: "running" });
  const database: Check = { name: bt("business.database"), label: running ? bt("business.waiting") : bt("business.notTested"), tone: "neutral" };
  if (databaseConnected) Object.assign(database, { label: bt("business.connected"), tone: "success" });
  else if (failure?.stage === "database") Object.assign(database, { label: bt("business.failed"), tone: "error" });
  else if (busy) Object.assign(database, { label: phase === "metadata" ? bt("business.verifyingAccess") : bt("business.connecting"), tone: "running" });
  else if (cancelled && phase !== "configuration" && phase !== "ssh") database.label = bt("business.cancelled");
  const warning = tls.tone === "warning";
  const tone: Tone = running ? "running" : failure ? "error" : cancelled ? "neutral" : warning ? "warning" : "success";
  const title = running ? state.cancelling ? bt("business.cancellingConnectionTest") : bt("business.testingConnection") : failure ? stageLabels[failure.stage] : cancelled ? bt("business.connectionTestCancelled") : warning ? bt("business.connectedReviewTLS") : bt("business.connectionSuccessful");
  const detail = running ? state.cancelling ? bt("business.stoppingThisTestAndClosingItsConnection") : phaseLabels[phase] : (failure ? translateConnectionFailure(failure, bt) : undefined) ?? (cancelled ? bt("business.nothingWasSavedYouCanChangeTheSettingsOr") : warning ? result?.sslActive === false ? bt("business.connectedWithoutTLSChooseRequireOrVerifyFullTo") : bt("business.theServerDidNotReportTLSStatusEncryptionCould") : bt("business.theConnectionIsReadySettingsAndPasswordsAreSaved"));
  return <section className="connection-test-status" role={failure ? "alert" : "status"} aria-label={bt("business.connectionTestResult")} data-state={state.status}>
    <div className="connection-test-heading">
      <div data-tone={tone}><StatusIcon tone={tone} /><strong>{title}</strong></div>
      {running && onCancel ? <button type="button" className="connection-test-cancel" onClick={onCancel} disabled={state.cancelling} aria-label={bt("business.cancelConnectionTest")}>{state.cancelling ? bt("business.cancelling") : bt("business.cancelTest")}</button> : null}
    </div>
    <div className="connection-test-checks">{[ssh, tls, database].map((check) => <div className="connection-test-check" role="group" aria-label={bt("business.status", { value0: check.name })} data-tone={check.tone} key={check.name}>
      <StatusIcon tone={check.tone} /><div><span>{check.name}</span><strong>{check.label}</strong></div>
    </div>)}</div>
    {running ? <div className="connection-test-progress" role="progressbar" aria-label={bt("business.connectionTestProgress")} aria-valuetext={detail}><span /></div> : null}
    <p className="connection-test-detail">{detail}</p>
  </section>;
}
