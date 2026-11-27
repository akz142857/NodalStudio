import { Button } from "../../design-system/Button";
import { useI18n } from "../../i18n";
import type { CodeLanguageStatus, CodeLanguageWorkspace } from "../../platform/code-review";

const languageNames = {
  Java: "Java",
  TypeScript: "JS / TS",
  Go: "Go",
  Php: "PHP",
  Python: "Python",
  Rust: "Rust",
  Clang: "C / C++",
  CSharp: "C#",
  Swift: "Swift",
} satisfies Record<CodeLanguageWorkspace["language"], string>;

export function CodeReviewLanguageServices({ status, projectName, enable, enabling, error }: {
  status: CodeLanguageStatus | undefined;
  projectName: string;
  enable: () => void;
  enabling: boolean;
  error: boolean;
}) {
  const { t } = useI18n();
  return <div className="code-language-services">
    {error && <p role="alert">{t("codeReview.languages.failed")}</p>}
    {status?.state === "offline" && <p>{t("codeReview.languages.offline")}</p>}
    {status?.state === "disabled" && <div className="code-language-authorization">
      <p>{t("codeReview.definitionTrust")}</p>
      <Button variant="primary" busy={enabling} onClick={enable}>{t("codeReview.languages.enable")}</Button>
    </div>}
    {(!status && !error || status?.state === "discovering") && <p>{t("codeReview.languages.discovering")}</p>}
    {status?.state === "failed" && !error && <p role="alert">{t("codeReview.languages.failed")}</p>}
    {status?.state === "workspaces" && (status.workspaces.length ? <ul>
      {status.workspaces.map((workspace) => {
        const { language, root, command, state, progress, lastTask } = workspace;
        const name = languageNames[language];
        const stage = progress?.message ?? progress?.title ?? t(`codeReview.languages.${state}`, { command });
        return <li key={language} className="code-language-workspace">
          <div className="code-language-workspace-heading">
            <strong>{name}</strong>
            <span className="code-language-root" title={root || projectName}>{root || projectName}</span>
            <span className="code-language-stage" data-state={state}>{stage}</span>
          </div>
          {progress && <progress aria-label={`${name} · ${progress.title}`} max={100} value={progress.percentage ?? undefined} />}
          {!progress && state === "connected" && lastTask && <span className="code-language-root">{t("codeReview.languages.completed", { task: lastTask })}</span>}
        </li>;
      })}
    </ul> : <p>{t("codeReview.languages.noWorkspaces")}</p>)}
  </div>;
}
