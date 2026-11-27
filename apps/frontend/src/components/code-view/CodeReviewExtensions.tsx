import { useEffect, useId, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "../../design-system/Button";
import { ModalSurface } from "../../design-system/ModalSurface";
import { useI18n } from "../../i18n";
import type { CodeExtension, CodeExtensionAction, CodeExtensionPlatform, CodeOpenVsxUpdate } from "../../platform/code-review";
import { ActionIcon } from "../ActionIcon";
import { IconButton } from "../IconButton";
import type { SchemaObjectMenuAction } from "../SchemaObjectMenu";
import { CodeExtensionRow } from "./CodeExtensionRow";
import { CodeOpenVsxDetails, CodeOpenVsxResults } from "./CodeOpenVsxExtensions";
import { extensionErrorMessage } from "./code-extension-errors";
import { useCodeContextMenu } from "./use-code-context-menu";

export type ExtensionActivity = { id: string; state: "running" | "ran" | "failed"; detail?: string };

function ExtensionGroup({ label, count, expanded, toggle, children }: {
  label: string;
  count?: number;
  expanded: boolean;
  toggle: () => void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const id = useId();
  return <section className="code-extension-group" aria-label={label}>
    <h2 className="code-extension-group-heading">
      <button type="button" aria-expanded={expanded} aria-controls={id}
        aria-label={count === undefined ? undefined : t("codeReview.extensions.groupCountLabel", { label, count })} onClick={toggle}>
        <ActionIcon name={expanded ? "chevronDown" : "chevronRight"} />
        <span>{label}</span>
        {count !== undefined && <span className="code-extension-count" aria-hidden="true">{count}</span>}
      </button>
    </h2>
    <div id={id} className="code-extension-group-body" hidden={!expanded}>{children}</div>
  </section>;
}

export function CodeReviewExtensions({ api, projectId, items, loading, loadError, retry, activities, onUpdate, offline, syntaxOnly = false, active = true }: {
  api: CodeExtensionPlatform;
  projectId: string;
  items: CodeExtension[];
  loading: boolean;
  loadError: boolean;
  retry: () => void;
  activities: ExtensionActivity[];
  onUpdate: (id: string, item: CodeExtension | null) => void;
  offline: boolean;
  syntaxOnly?: boolean;
  active?: boolean;
}) {
  const { t } = useI18n();
  const [installedOpen, setInstalledOpen] = useState(true);
  const [featuredOpen, setFeaturedOpen] = useState(true);
  const [text, setText] = useState("");
  const [submitted, setSubmitted] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const [catalogSelection, selectCatalog] = useState<{ id: string; version?: string }>();
  const [packageId, setPackageId] = useState<string>();
  const [confirm, setConfirm] = useState<{ item: CodeExtension; action: "enable" | "uninstall" }>();
  const selectedPackage = items.find((item) => item.id === packageId);
  const menu = useCodeContextMenu();
  const market = syntaxOnly ? undefined : api.openVsx;
  const syntaxCatalog = syntaxOnly ? api.syntaxCatalog : undefined;
  const term = text.trim();
  const query = term ? submitted : "";
  const pendingQuery = term !== query;
  const searching = Boolean(market && !offline && term);
  useEffect(() => {
    if (!searching || !active || !pendingQuery) return;
    const timer = window.setTimeout(() => setSubmitted(term), 250);
    return () => window.clearTimeout(timer);
  }, [active, pendingQuery, searching, term]);
  function clearSearch() {
    setText("");
    setSubmitted("");
  }
  const availableSyntax = useQuery({
    queryKey: ["codeReview", "syntaxCatalog"],
    queryFn: () => syntaxCatalog?.list() ?? Promise.resolve([]),
    enabled: Boolean(syntaxCatalog) && active,
    staleTime: Infinity,
    retry: false,
  });
  const downloadSyntax = useMutation({
    mutationFn: (id: string) => syntaxCatalog!.import(projectId, id),
    onSuccess: (item) => onUpdate(item.id, item),
  });
  const updates = useMutation({ mutationFn: () => market!.updates(projectId) });
  const mutation = useMutation({
    mutationFn: async (request: { id: string; action: CodeExtensionAction } | null) => {
      if (request) return { id: request.id, item: await api.change(projectId, request.id, request.action) };
      if (syntaxOnly) return null;
      const item = await api.install(projectId);
      return item ? { id: item.id, item } : null;
    },
    onSuccess: (result) => { if (result) onUpdate(result.id, result.item); },
  });
  const installError = extensionErrorMessage(mutation.error);
  const unsupported = syntaxOnly ? "codeReview.extensions.syntaxOnly" : "codeReview.extensions.unsupported";

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

  const catalog = market && <CodeOpenVsxResults market={market} projectId={projectId} items={items}
    active={active && (searching || featuredOpen)} offline={offline} query={searching ? query : ""}
    pendingQuery={searching && pendingQuery} openDetails={(id, version) => selectCatalog({ id, version })} />;
  return <section className="code-extensions" aria-label={t("codeReview.extensions.title")}>
    {!syntaxOnly && <header className="code-extension-toolbar">
      {market && <form className="code-extension-search" role="search" onSubmit={(event) => {
        event.preventDefault();
        if (!offline) setSubmitted(term);
      }}>
        <ActionIcon name="search" />
        <input ref={input} type="search" aria-label={t("codeReview.extensions.marketSearch")}
          placeholder={t("codeReview.extensions.marketPlaceholder")} value={text} maxLength={160} disabled={offline}
          onChange={(event) => setText(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && text) {
              event.preventDefault();
              event.stopPropagation();
              clearSearch();
            }
          }} />
        {text && <IconButton icon="close" className="code-review-tool" label={t("codeReview.extensions.marketClear")}
          onClick={() => { clearSearch(); input.current?.focus(); }} />}
      </form>}
      <IconButton icon="more" className="code-review-tool" label={t("codeReview.extensions.actions")} aria-haspopup="menu"
        aria-expanded={Boolean(menu.trigger?.closest(".code-extension-toolbar"))} onClick={(event) => {
          const actions: SchemaObjectMenuAction[] = [{
            label: t("codeReview.extensions.install"), disabled: mutation.isPending, run: () => mutation.mutate(null),
          }];
          if (market && items.length > 0) actions.push({
            label: t("codeReview.extensions.marketCheckUpdates"), disabled: offline || mutation.isPending || updates.isPending,
            description: offline ? t("codeReview.extensions.marketOffline") : undefined, run: () => {
              clearSearch();
              setInstalledOpen(true);
              updates.mutate();
            },
          });
          menu.show(event, t("codeReview.extensions.title"), actions);
        }} />
    </header>}
    {mutation.isError && <p className="code-extension-feedback" role="alert">{t(
      installError === "codeReview.extensions.unsupported" ? unsupported : installError,
    )}</p>}
    {(mutation.isPending || updates.isPending) && <p className="code-extension-feedback" role="status">{t("navigation.loadingWorkspace")}</p>}
    <div className="code-extension-sections">
      {!searching && <ExtensionGroup label={t("codeReview.extensions.installedTab")} count={loading || loadError ? undefined : items.length}
        expanded={installedOpen} toggle={() => setInstalledOpen((value) => !value)}>
        {loading && <p role="status">{t("navigation.loadingWorkspace")}</p>}
        {loadError && <p role="alert">{t("codeReview.extensions.storage")}{" "}
          <Button size="small" onClick={retry}>{t("codeReview.refresh")}</Button></p>}
        {updates.isError && <p role="alert">{t(extensionErrorMessage(updates.error))}</p>}
        {updates.isSuccess && updates.data.failed > 0 && <p role="status">{t(
          updates.data.failed === 1 ? "codeReview.extensions.marketPartialOne" : "codeReview.extensions.marketPartial",
          { count: updates.data.failed },
        )}</p>}
        {updates.isSuccess && !updates.data.failed && !updates.data.updates.some((update) => items.some((item) =>
          item.id === update.id && item.sha256 === update.installedSha256)) && <p role="status">{t("codeReview.extensions.marketUpToDate")}</p>}
        {!loading && !loadError && !items.length && <p>{t(syntaxOnly ? "codeReview.extensions.noSyntaxImported" : "codeReview.extensions.empty")}</p>}
        {items.length > 0 && <ul className="code-extension-list code-extension-installed-list">
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
        </ul>}
      </ExtensionGroup>}
      {syntaxCatalog && <ExtensionGroup label={t("codeReview.extensions.syntaxCatalog")}
        expanded={featuredOpen} toggle={() => setFeaturedOpen((value) => !value)}>
        <p>{t("codeReview.extensions.syntaxOnly")}</p>
        {offline && <p role="status">{t("codeReview.extensions.marketOffline")}</p>}
        {availableSyntax.isPending && <p role="status">{t("navigation.loadingWorkspace")}</p>}
        {availableSyntax.isError && <p role="alert">{t("codeReview.extensions.storage")}{" "}
          <Button size="small" onClick={() => { void availableSyntax.refetch(); }}>{t("codeReview.refresh")}</Button></p>}
        {downloadSyntax.isError && <p role="alert">{t(extensionErrorMessage(downloadSyntax.error))}</p>}
        {availableSyntax.data && <ul className="code-extension-list">
          {availableSyntax.data.map((source) => {
            const imported = items.some((item) => item.id === source.id);
            return <li key={source.id} className="code-extension-row">
              <span className="code-extension-copy">
                <strong className="code-extension-line">{source.name}</strong>
                <span className="code-extension-meta">{source.version}</span>
              </span>
              <Button size="small" disabled={offline || loading || loadError || imported || downloadSyntax.isPending}
                aria-label={t(imported ? "codeReview.extensions.syntaxImported" : "codeReview.extensions.downloadSyntaxLabel", { name: source.name })}
                onClick={() => downloadSyntax.mutate(source.id)}>
                {t(imported ? "codeReview.extensions.importedSyntax" : "codeReview.extensions.downloadSyntax")}
              </Button>
            </li>;
          })}
        </ul>}
      </ExtensionGroup>}
      {market && (searching ? <section className="code-extension-group" aria-label={t("codeReview.extensions.marketResults")}>
        <h2 className="code-extension-group-heading">{t("codeReview.extensions.marketResults")}</h2>
        <div className="code-extension-group-body">{catalog}</div>
      </section> : <ExtensionGroup label={t("codeReview.extensions.marketFeatured")}
        expanded={featuredOpen} toggle={() => setFeaturedOpen((value) => !value)}>{catalog}</ExtensionGroup>)}
    </div>
    {menu.surface}
    {selectedPackage && <ModalSurface label={t(syntaxOnly ? "codeReview.extensions.syntaxDetails" : "codeReview.extensions.package")} onDismiss={() => setPackageId(undefined)}>
      <div className="code-definition-dialog code-extension-detail ds-surface">
        <h3>{selectedPackage.name}</h3>
        {selectedPackage.description && <p>{selectedPackage.description}</p>}
        {selectedPackage.capability === "unsupported" && <p>{t(unsupported)}</p>}
        <dl>
          <dt>{t("codeReview.extensions.marketPublisher")}</dt><dd>{selectedPackage.publisher}</dd>
          <dt>{t("codeReview.extensions.marketVersion")}</dt><dd>{selectedPackage.version}</dd>
          <dt>{t(syntaxOnly ? "codeReview.extensions.syntaxFile" : "codeReview.extensions.localPackage")}</dt><dd>{selectedPackage.fileName}</dd>
          <dt>{t("codeReview.extensions.marketSource")}</dt><dd>{selectedPackage.source === "local" ? t("codeReview.extensions.localPackage") : "Open VSX"}</dd>
          <dt>SHA-256</dt><dd>{selectedPackage.sha256}</dd>
          {!syntaxOnly && <><dt>{t("codeReview.extensions.vscodeEngine")}</dt><dd>{selectedPackage.engine}</dd></>}
        </dl>
        <div className="code-review-note-actions">
          <Button data-modal-focus onClick={() => setPackageId(undefined)}>{t("codeReview.extensions.marketClose")}</Button>
        </div>
      </div>
    </ModalSurface>}
    {market && catalogSelection && <CodeOpenVsxDetails key={`${catalogSelection.id}:${catalogSelection.version ?? ""}`} market={market} projectId={projectId} id={catalogSelection.id}
      initialVersion={catalogSelection.version} installed={items.find((item) => item.id === catalogSelection.id)}
      offline={offline} dismiss={() => selectCatalog(undefined)} onInstall={(item) => onUpdate(item.id, item)} />}
    {confirm && <ModalSurface label={t(`codeReview.extensions.${confirm.action}`)} onDismiss={() => setConfirm(undefined)}>
      <div className="code-definition-dialog ds-surface">
        <h2>{confirm.item.name} · {confirm.item.version}</h2>
        <p>{confirm.action === "enable"
          ? t("codeReview.extensions.enableAccess", { file: confirm.item.fileName })
          : t("codeReview.extensions.uninstallAccess")}</p>
        <div className="code-review-note-actions">
          <Button data-modal-focus onClick={() => setConfirm(undefined)}>{t("codeReview.cancel")}</Button>
          <Button variant={confirm.action === "uninstall" ? "danger" : "primary"} onClick={() => {
            mutation.mutate({ id: confirm.item.id, action: confirm.action });
            setConfirm(undefined);
          }}>{t(`codeReview.extensions.${confirm.action}`)}</Button>
        </div>
      </div>
    </ModalSurface>}
  </section>;
}
