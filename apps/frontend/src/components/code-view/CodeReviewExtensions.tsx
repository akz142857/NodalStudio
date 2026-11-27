import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "../../design-system/Button";
import { ModalSurface } from "../../design-system/ModalSurface";
import { useI18n } from "../../i18n";
import type { CodeExtension, CodeExtensionAction, CodeExtensionPlatform } from "../../platform/code-review";

export type ExtensionActivity = { id: string; state: "running" | "ran" | "failed"; detail?: string };

export function CodeReviewExtensions({ api, projectId, items, loading, loadError, retry, activities, onUpdate }: {
  api: CodeExtensionPlatform;
  projectId: string;
  items: CodeExtension[];
  loading: boolean;
  loadError: boolean;
  retry: () => void;
  activities: ExtensionActivity[];
  onUpdate: (id: string, item: CodeExtension | null) => void;
}) {
  const { t } = useI18n();
  const [confirm, setConfirm] = useState<{ item: CodeExtension; action: "enable" | "uninstall" }>();
  const mutation = useMutation({
    mutationFn: async (request: { id: string; action: CodeExtensionAction } | null) => {
      if (request) return { id: request.id, item: await api.change(projectId, request.id, request.action) };
      const item = await api.install(projectId);
      return item ? { id: item.id, item } : null;
    },
    onSuccess: (result) => { if (result) onUpdate(result.id, result.item); },
  });
  const error = String(mutation.error);
  const errorMessage = error === "extensionInvalid" ? "invalid" : error === "extensionLimit" ? "limit"
    : error === "extensionAlreadyInstalled" ? "duplicate" : error === "extensionUnsupported" ? "unsupported" : "storage";
  return <section className="code-extensions" aria-label={t("codeReview.extensions.title")}>
    <div className="code-extensions-actions">
      <Button size="small" variant="primary" busy={mutation.isPending && mutation.variables === null} disabled={mutation.isPending}
        onClick={() => mutation.mutate(null)}>{t("codeReview.extensions.install")}</Button>
    </div>
    {loading && <p role="status">{t("navigation.loadingWorkspace")}</p>}
    {loadError && <p role="alert">{t("codeReview.extensions.storage")}{" "}
      <Button size="small" onClick={retry}>{t("codeReview.refresh")}</Button></p>}
    {mutation.isError && <p role="alert">{t(`codeReview.extensions.${errorMessage}`)}</p>}
    {!loading && !loadError && !items.length && <p>{t("codeReview.extensions.empty")}</p>}
    <ul>
      {items.map((item) => {
        const activity = activities.find((candidate) => candidate.id === item.id);
        const status = item.capability === "unsupported" ? "unsupportedStatus"
          : !item.enabled ? "disabled" : activity?.state ?? "enabled";
        return <li key={item.id} aria-label={item.name}>
          <h3>{item.name}</h3>
          <p className="code-extension-byline">{item.publisher} · {item.version}</p>
          {item.description && <p>{item.description}</p>}
          <p className="code-extension-state" role="status">{t(`codeReview.extensions.${status}`)}</p>
          {activity?.detail && item.enabled && <p role="alert">{activity.detail}</p>}
          {item.capability === "unsupported" && <p>{t("codeReview.extensions.unsupported")}</p>}
          <div className="code-extensions-actions">
            {item.capability !== "unsupported" && <Button size="small" disabled={mutation.isPending}
              onClick={() => {
                if (item.enabled) mutation.mutate({ id: item.id, action: "disable" });
                else if (item.capability === "diagnostics") setConfirm({ item, action: "enable" });
                else mutation.mutate({ id: item.id, action: "enable" });
              }}>{t(item.enabled ? "codeReview.extensions.disable" : "codeReview.extensions.enable")}</Button>}
            <Button size="small" variant="ghost" disabled={mutation.isPending}
              onClick={() => setConfirm({ item, action: "uninstall" })}>{t("codeReview.extensions.uninstall")}</Button>
          </div>
          <details>
            <summary>{t("codeReview.extensions.package")}</summary>
            <dl>
              <dt>{t("codeReview.extensions.localPackage")}</dt><dd>{item.fileName}</dd>
              <dt>SHA-256</dt><dd>{item.sha256}</dd>
              <dt>{t("codeReview.extensions.vscodeEngine")}</dt><dd>{item.engine}</dd>
            </dl>
          </details>
        </li>;
      })}
    </ul>
    {confirm && <ModalSurface label={t(`codeReview.extensions.${confirm.action}`)} onDismiss={() => setConfirm(undefined)}>
      <div className="code-definition-dialog ds-surface">
        <strong>{confirm.item.name} · {confirm.item.version}</strong>
        <p>{confirm.action === "enable"
          ? t("codeReview.extensions.enableAccess", { file: confirm.item.fileName })
          : t("codeReview.extensions.uninstallAccess")}</p>
        <div className="code-review-note-actions">
          <Button data-modal-focus onClick={() => setConfirm(undefined)}>{t("codeReview.definitionCancel")}</Button>
          <Button variant="primary" onClick={() => {
            mutation.mutate({ id: confirm.item.id, action: confirm.action });
            setConfirm(undefined);
          }}>{t(`codeReview.extensions.${confirm.action}`)}</Button>
        </div>
      </div>
    </ModalSurface>}
  </section>;
}
