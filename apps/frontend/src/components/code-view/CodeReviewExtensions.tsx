import { useState, type MouseEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "../../design-system/Button";
import { ModalSurface } from "../../design-system/ModalSurface";
import { useI18n } from "../../i18n";
import type { CodeExtension, CodeExtensionAction, CodeExtensionPlatform, CodeOpenVsxUpdate } from "../../platform/code-review";
import { IconButton } from "../IconButton";
import type { SchemaObjectMenuAction } from "../SchemaObjectMenu";
import { Segmented } from "../Segmented";
import { CodeExtensionRow } from "./CodeExtensionRow";
import { CodeOpenVsxDetails, CodeOpenVsxSearch } from "./CodeOpenVsxExtensions";
import { extensionErrorMessage } from "./code-extension-errors";
import { useCodeContextMenu } from "./use-code-context-menu";

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
  const [packageId, setPackageId] = useState<string>();
  const [confirm, setConfirm] = useState<{ item: CodeExtension; action: "enable" | "uninstall" }>();
  const selectedPackage = items.find((item) => item.id === packageId);
  const menu = useCodeContextMenu();
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

  function manageExtension(event: MouseEvent<HTMLButtonElement>, item: CodeExtension, update?: CodeOpenVsxUpdate) {
    const actions: SchemaObjectMenuAction[] = [];
    if (item.capability !== "unsupported") actions.push({
      label: t(item.enabled ? "codeReview.extensions.disable" : "codeReview.extensions.enable"),
      disabled: mutation.isPending,
      run: () => {
        if (item.enabled) mutation.mutate({ id: item.id, action: "disable" });
        else if (item.capability === "diagnostics") setConfirm({ item, action: "enable" });
        else mutation.mutate({ id: item.id, action: "enable" });
      },
    });
    if (update) actions.push({
      label: t("codeReview.extensions.marketUpdateVersion", { version: update.version }),
      disabled: offline || mutation.isPending,
      run: () => selectCatalog({ id: item.id, version: update.version }),
    });
    actions.push({
      label: t("codeReview.extensions.uninstall"), disabled: mutation.isPending,
      separatorBefore: actions.length > 0, run: () => setConfirm({ item, action: "uninstall" }),
    });
    menu.show(event, item.name, actions);
  }

  return <section className="code-extensions" aria-label={t("codeReview.extensions.title")}>
    <header className="code-extension-toolbar">
      {market ? <Segmented className="code-extension-views"
        label={t("codeReview.extensions.title")} value={view} onChange={setView}
        options={[{ value: "installed", label: t("codeReview.extensions.installedTab") }, { value: "market", label: "Open VSX" }]} />
        : <strong>{t("codeReview.extensions.installedTab")}</strong>}
      <IconButton icon="more" className="code-review-tool" label={t("codeReview.extensions.actions")} aria-haspopup="menu"
        aria-expanded={Boolean(menu.trigger?.closest(".code-extension-toolbar"))} onClick={(event) => {
          const actions: SchemaObjectMenuAction[] = [{
            label: t("codeReview.extensions.install"), disabled: mutation.isPending, run: () => mutation.mutate(null),
          }];
          if (market && items.length > 0) actions.push({
            label: t("codeReview.extensions.marketCheckUpdates"), disabled: offline || mutation.isPending || updates.isPending,
            description: offline ? t("codeReview.extensions.marketOffline") : undefined, run: () => { setView("installed"); updates.mutate(); },
          });
          menu.show(event, t("codeReview.extensions.title"), actions);
        }} />
    </header>
    {mutation.isError && <p className="code-extension-feedback" role="alert">{t(extensionErrorMessage(mutation.error))}</p>}
    {(mutation.isPending || updates.isPending) && <p className="code-extension-feedback" role="status">{t("navigation.loadingWorkspace")}</p>}
    {market && <div className="code-extension-view" hidden={view !== "market"}>
      <CodeOpenVsxSearch market={market} projectId={projectId} items={items} offline={offline} openDetails={(id) => selectCatalog({ id })} />
    </div>}
    <div className="code-extension-view" hidden={view !== "installed"}>
      {loading && <p role="status">{t("navigation.loadingWorkspace")}</p>}
      {loadError && <p role="alert">{t("codeReview.extensions.storage")}{" "}
        <Button size="small" onClick={retry}>{t("codeReview.refresh")}</Button></p>}
      {updates.isError && <p role="alert">{t(extensionErrorMessage(updates.error))}</p>}
      {updates.isSuccess && updates.data.failed > 0 && <p role="status">{t("codeReview.extensions.marketPartial", { count: updates.data.failed })}</p>}
      {updates.isSuccess && !updates.data.failed && !updates.data.updates.some((update) => items.some((item) =>
        item.id === update.id && item.sha256 === update.installedSha256)) && <p role="status">{t("codeReview.extensions.marketUpToDate")}</p>}
      {!loading && !loadError && !items.length && <div className="code-extension-empty">
        <p>{t("codeReview.extensions.empty")}</p>
        <Button size="small" disabled={mutation.isPending} onClick={() => mutation.mutate(null)}>{t("codeReview.extensions.install")}</Button>
      </div>}
      <ul className="code-extension-list">
        {items.map((item) => {
          const activity = activities.find((candidate) => candidate.id === item.id);
          const update = updates.data?.updates.find((candidate) => candidate.id === item.id && candidate.installedSha256 === item.sha256);
          const status = item.capability === "unsupported" ? "unsupportedStatus"
            : !item.enabled ? "disabled" : activity?.state ?? "enabled";
          const statusText = t(`codeReview.extensions.${status}`);
          return <CodeExtensionRow key={item.id} item={item} onOpen={() => setPackageId(item.id)}
            status={update ? `${statusText} · ${t("codeReview.extensions.marketUpdateAvailable", { version: update.version })}` : statusText}
            warning={status === "failed" || status === "unsupportedStatus"} actions={<IconButton icon="settings"
              className="code-review-tool" label={t("codeReview.extensions.manage", { name: item.name })} aria-haspopup="menu"
              aria-expanded={menu.trigger?.dataset.extensionId === item.id} data-extension-id={item.id}
              onClick={(event) => manageExtension(event, item, update)} />}>
            {activity?.detail && item.enabled && <p className="code-extension-row-alert" role="alert">{activity.detail}</p>}
          </CodeExtensionRow>;
        })}
      </ul>
    </div>
    {menu.surface}
    {selectedPackage && <ModalSurface label={t("codeReview.extensions.package")} onDismiss={() => setPackageId(undefined)}>
      <div className="code-definition-dialog code-extension-detail ds-surface">
        <h3>{selectedPackage.name}</h3>
        {selectedPackage.description && <p>{selectedPackage.description}</p>}
        {selectedPackage.capability === "unsupported" && <p>{t("codeReview.extensions.unsupported")}</p>}
        <dl>
          <dt>{t("codeReview.extensions.marketPublisher")}</dt><dd>{selectedPackage.publisher}</dd>
          <dt>{t("codeReview.extensions.marketVersion")}</dt><dd>{selectedPackage.version}</dd>
          <dt>{t("codeReview.extensions.localPackage")}</dt><dd>{selectedPackage.fileName}</dd>
          <dt>{t("codeReview.extensions.marketSource")}</dt><dd>{selectedPackage.source === "openVsx" ? "Open VSX" : t("codeReview.extensions.localPackage")}</dd>
          <dt>SHA-256</dt><dd>{selectedPackage.sha256}</dd>
          <dt>{t("codeReview.extensions.vscodeEngine")}</dt><dd>{selectedPackage.engine}</dd>
        </dl>
        <div className="code-review-note-actions">
          <Button data-modal-focus onClick={() => setPackageId(undefined)}>{t("codeReview.extensions.marketClose")}</Button>
        </div>
      </div>
    </ModalSurface>}
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
