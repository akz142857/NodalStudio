import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "../../design-system/Button";
import { useI18n } from "../../i18n";
import type { PythonDebugFrame, PythonDebugPlatform } from "../../platform/code-review";

import type { PythonDebugState } from "./use-python-debug";

type Launch = Parameters<PythonDebugPlatform["start"]>[2];
type LaunchDetails = Awaited<ReturnType<PythonDebugPlatform["prepare"]>>;

const errors = {
  pythonDebugInput: "inputError",
  pythonDebugOffline: "offline",
  pythonDebugBusy: "busy",
  pythonDebugProtocol: "failed",
  pythonDebugTimeout: "timeout",
  extensionChanged: "changed",
  extensionDisabled: "install",
} as const;

export function PythonDebugPanel({ api, projectId, path, ready, offline, debug, onExtensions, onFrame }: {
  api: PythonDebugPlatform;
  projectId: string;
  path?: string;
  ready: boolean;
  offline: boolean;
  debug: PythonDebugState;
  onExtensions: () => void;
  onFrame: (frame: PythonDebugFrame) => void;
}) {
  const { t } = useI18n();
  const status = debug.mode === "idle" || debug.mode === "finished" ? undefined : debug.mode;
  const details = useQuery({
    queryKey: ["python-debug-launch", projectId, path],
    queryFn: () => api.prepare(projectId, path!),
    enabled: Boolean(path && ready && !offline && !status),
    retry: false,
  });
  const error = debug.error ? errors[debug.error as keyof typeof errors] : undefined;
  return <div className="python-debug-body">
    {debug.error && <p role="alert">{t(`codeReview.debug.${error ?? "failed"}`)}{!error && ` ${debug.error}`}</p>}
    {status ? <div className="python-debug-session" role="group" aria-label={t("codeReview.debug.actions")}>
      <span role="status">{t(`codeReview.debug.${status}`)}</span>
      {(["continue", "stepOver", "stepIn", "stepOut"] as const).map((kind) =>
        <Button key={kind} size="small" disabled={debug.mode !== "paused" || debug.busy} onClick={() => debug.control({ kind })}>{t(`codeReview.debug.${kind}`)}</Button>)}
      <Button size="small" variant="danger" disabled={debug.mode === "stopping"} onClick={debug.stop}>{t("codeReview.debug.stop")}</Button>
    </div> : <>
      {debug.mode === "finished" && !debug.error && <p role="status">{t("codeReview.debug.finished")}</p>}
      {offline ? <p role="status">{t("codeReview.debug.offline")}</p>
        : !ready ? <div className="python-debug-session"><p>{t("codeReview.debug.install")}</p><Button size="small" onClick={onExtensions}>{t("codeReview.extensions.title")}</Button></div>
        : !path ? <p>{t("codeReview.debug.chooseFile")}</p>
        : details.isError ? <p role="alert">{t("codeReview.debug.inputError")}</p>
        : !details.data ? <p role="status">{t("navigation.loadingWorkspace")}</p>
        : <PythonLaunchForm key={path} path={path} details={details.data} onStart={debug.start} />}
    </>}
    {debug.paused && <div className="python-debug-inspect">
      <section>
        <h4>{t("codeReview.debug.callStack")}</h4>
        <ul>{debug.paused.frames.map((frame) => <li key={frame.id}>
          <Button variant="ghost" size="small" aria-current={frame.id === debug.paused?.selected}
            disabled={debug.busy} onClick={() => { onFrame(frame); debug.control({ kind: "frame", id: frame.id }); }}>
            <strong>{frame.name}</strong><span>{frame.path ?? frame.source}:{frame.line}</span>
          </Button>
        </li>)}</ul>
      </section>
      <section>
        <h4>{t("codeReview.debug.variables")}</h4>
        {debug.paused.scopes.map((scope) => <details key={scope.name} open={scope.name.toLowerCase() === "locals" || undefined}>
          <summary>{scope.name}</summary>
          <dl>{scope.variables.map((item, index) => <div key={`${item.name}-${index}`}>
            <dt title={item.type}>{item.name}</dt><dd>{item.value}</dd>
          </div>)}</dl>
        </details>)}
      </section>
    </div>}
    {debug.output && <section className="python-debug-output">
      <h4>{t("codeReview.debug.output")}</h4><pre>{debug.output}</pre>
    </section>}
  </div>;
}

function PythonLaunchForm({ path, details, onStart }: { path: string; details: LaunchDetails; onStart: (input: Omit<Launch, "breakpoints">) => void }) {
  const { t } = useI18n();
  const [interpreter, setInterpreter] = useState(details.interpreters[0] ?? "");
  const [cwd, setCwd] = useState("");
  const [args, setArgs] = useState("");
  return <form className="python-debug-launch" data-python-launch="" onSubmit={(event) => {
    event.preventDefault();
    onStart({ path, interpreter: interpreter.trim(), cwd: cwd.trim(), args: args ? args.split(/\r?\n/) : [] });
  }}>
    <p>{t("codeReview.debug.execute")}</p>
    <div className="python-debug-program"><strong>{t("codeReview.debug.program")}</strong><code>{details.program}</code></div>
    <label>{t("codeReview.debug.interpreter")}
      <input required value={interpreter} placeholder="/usr/bin/python3" autoComplete="off" spellCheck={false}
        onChange={(event) => setInterpreter(event.target.value)} />
    </label>
    <label>{t("codeReview.debug.cwd")}
      <div className="python-debug-cwd"><code>{details.root}/</code>
        <input value={cwd} placeholder="." autoComplete="off" spellCheck={false} onChange={(event) => setCwd(event.target.value)} /></div>
    </label>
    <label>{t("codeReview.debug.args")}<textarea rows={2} value={args} spellCheck={false} onChange={(event) => setArgs(event.target.value)} /></label>
    <Button variant="primary" type="submit" size="small" disabled={!interpreter.trim().startsWith("/")}>{t("codeReview.debug.start")}</Button>
  </form>;
}
