import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "../../design-system/Button";
import { ModalSurface } from "../../design-system/ModalSurface";
import { useI18n } from "../../i18n";
import type { CodeExtension, CodeExtensionAction, CodeExtensionPlatform } from "../../platform/code-review";
import { Segmented } from "../Segmented";
import { CodeOpenVsxDetails, CodeOpenVsxSearch } from "./CodeOpenVsxExtensions";
import { extensionErrorMessage } from "./code-extension-errors";

export type ExtensionActivity = { id: string; state: "running" | "ran" | "failed"; detail?: string };

export function CodeReviewExtensions({ api, projectId, items, loading, loadError, retry, activities, onUpdate, offline }: {
  api: CodeExtensionPlatform;
  projectId: string;
  items: CodeExtension[];
  loading: boolean;
  loadError: boolean;
  retry: () => void;
  activities: ExtensionActivity[];
  onUpdate: (id: string, item: CodeExtension | null) => void;
  offline: boolean;
}) {
  const { t } = useI18n();
  const [view, setView] = useState<"installed" | "market">("installed");
  const [catalogSelection, selectCatalog] = useState<{ id: string; version?: string }>();
  const [confirm, setConfirm] = useState<{ item: CodeExtension; action: "enable" | "uninstall" }>();
  const market = api.openVsx;
  const updates = useMutation({ mutationFn: () => market!.updates(projectId) });
  const mutation = useMutation({
    mutationFn: async (request: { id: string; action: CodeExtensionAction } | null) => {
      if (request) return { id: request.id, item: await api.change(projectId, request.id, request.action) };
      const item = await api.install(projectId);
      return item ? { id: item.id, item } : null;
    },
    onSuccess: (result) => { if (result) onUpdate(result.id, result.item); },
  });
  return <section className="code-extensions" aria-label={t("codeReview.extensions.title")}>
    {market && <Segmented className="code-review-segments code-extension-views"
      label={t("codeReview.extensions.title")} value={view} onChange={setView}
      options={[{ value: "installed", label: t("codeReview.extensions.installedTab") }, { value: "market", label: "Open VSX" }]} />}
    {market && <div hidden={view !== "market"}>
      <CodeOpenVsxSearch market={market} projectId={projectId} items={items} offline={offline} openDetails={(id) => selectCatalog({ id })} />
    </div>}
    <div hidden={view !== "installed"}>
    <div className="code-extensions-actions">
      <Button size="small" variant="primary" busy={mutation.isPending && mutation.variables === null} disabled={mutation.isPending}
        onClick={() => mutation.mutate(null)}>{t("codeReview.extensions.install")}</Button>
      {market && items.length > 0 && <Button size="small" busy={updates.isPending}
        disabled={offline || mutation.isPending} title={offline ? t("codeReview.extensions.marketOffline") : undefined}
        onClick={() => updates.mutate()}>{t("codeReview.extensions.marketCheckUpdates")}</Button>}
    </div>
    {loading && <p role="status">{t("navigation.loadingWorkspace")}</p>}
    {loadError && <p role="alert">{t("codeReview.extensions.storage")}{" "}
      <Button size="small" onClick={retry}>{t("codeReview.refresh")}</Button></p>}
    {mutation.isError && <p role="alert">{t(extensionErrorMessage(mutation.error))}</p>}
    {updates.isError && <p role="alert">{t(extensionErrorMessage(updates.error))}</p>}
    {updates.isSuccess && updates.data.failed > 0 && <p role="status">{t("codeReview.extensions.marketPartial", { count: updates.data.failed })}</p>}
    {updates.isSuccess && !updates.data.failed && !updates.data.updates.some((update) => items.some((item) =>
      item.id === update.id && item.sha256 === update.installedSha256)) && <p role="status">{t("codeReview.extensions.marketUpToDate")}</p>}
    {!loading && !loadError && !items.length && <p>{t("codeReview.extensions.empty")}</p>}
    <ul>
      {items.map((item) => {
        const activity = activities.find((candidate) => candidate.id === item.id);
        const update = updates.data?.updates.find((candidate) => candidate.id === item.id && candidate.installedSha256 === item.sha256);
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
            {update && <Button size="small" variant="primary" disabled={offline || mutation.isPending}
              onClick={() => selectCatalog({ id: item.id, version: update.version })}>
              {t("codeReview.extensions.marketUpdateAvailable", { version: update.version })}
            </Button>}
          </div>
          <details>
            <summary>{t("codeReview.extensions.package")}</summary>
            <dl>
              <dt>{t("codeReview.extensions.localPackage")}</dt><dd>{item.fileName}</dd>
              <dt>{t("codeReview.extensions.marketSource")}</dt><dd>{item.source === "openVsx" ? "Open VSX" : t("codeReview.extensions.localPackage")}</dd>
              <dt>SHA-256</dt><dd>{item.sha256}</dd>
              <dt>{t("codeReview.extensions.vscodeEngine")}</dt><dd>{item.engine}</dd>
            </dl>
          </details>
        </li>;
      })}
    </ul>
    </div>
    {market && catalogSelection && <CodeOpenVsxDetails market={market} projectId={projectId} id={catalogSelection.id}
      initialVersion={catalogSelection.version} installed={items.find((item) => item.id === catalogSelection.id)}
      offline={offline} dismiss={() => selectCatalog(undefined)} onInstall={(item) => onUpdate(item.id, item)} />}
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
