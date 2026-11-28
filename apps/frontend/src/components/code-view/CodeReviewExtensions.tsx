import { useEffect, useId, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { useIsFetching, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "../../design-system/Button";
import { ModalSurface } from "../../design-system/ModalSurface";
import { useI18n } from "../../i18n";
import type { CodeExtension, CodeExtensionAction, CodeExtensionPlatform, CodeOpenVsxUpdate, CodeReviewPlatform, CodeSyntaxSource } from "../../platform/code-review";
import { ActionIcon } from "../ActionIcon";
import { IconButton } from "../IconButton";
import type { SchemaObjectMenuAction } from "../SchemaObjectMenu";
import { CodeExtensionRow } from "./CodeExtensionRow";
import { CodeOpenVsxDetails, CodeOpenVsxResults } from "./CodeOpenVsxExtensions";
import { extensionErrorMessage } from "./code-extension-errors";
import { recommendCodeExtensions } from "./code-extension-recommendations";
import { codeReviewKeys } from "./code-review-query-keys";
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

export function CodeReviewExtensions({ api, projectId, items, loading, loadError, refreshing = false, retry, activities, onUpdate,
  loadPaths, offline, syntaxOnly = false, active = true }: {
  api: CodeExtensionPlatform;
  projectId: string;
  items: CodeExtension[];
  loading: boolean;
  loadError: boolean;
  refreshing?: boolean;
  retry: () => void;
  activities: ExtensionActivity[];
  onUpdate: (id: string, item: CodeExtension | null) => void;
  loadPaths?: CodeReviewPlatform["paths"];
  offline: boolean;
  syntaxOnly?: boolean;
  active?: boolean;
}) {
  const { t } = useI18n();
  const client = useQueryClient();
  const [installedOpen, setInstalledOpen] = useState(true);
  const [recommendedOpen, setRecommendedOpen] = useState(true);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [text, setText] = useState("");
  const [submitted, setSubmitted] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const [catalogSelection, selectCatalog] = useState<{ id: string; version?: string }>();
  const [packageId, setPackageId] = useState<string>();
  const [confirm, setConfirm] = useState<{ item: CodeExtension; action: "enable" | "uninstall" }>();
  const selectedPackage = items.find((item) => item.id === packageId);
  const menu = useCodeContextMenu();
  const market = syntaxOnly ? undefined : api.openVsx;
  const syntaxCatalog = api.syntaxCatalog;
  const term = text.trim();
  const query = term ? submitted : "";
  const pendingQuery = term !== query;
  const searching = Boolean(market && !offline && term);
  const marketQueryKey = codeReviewKeys.openVsxSearch(projectId, query);
  const marketRefreshing = useIsFetching({ queryKey: marketQueryKey, exact: true }) > 0;
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
    queryKey: codeReviewKeys.syntaxCatalog,
    queryFn: () => syntaxCatalog?.list() ?? Promise.resolve([]),
    enabled: Boolean(syntaxCatalog) && active,
    staleTime: Infinity,
    networkMode: "always",
    retry: false,
  });
  const projectPaths = useQuery({
    queryKey: codeReviewKeys.paths(projectId),
    queryFn: () => loadPaths!(projectId),
    enabled: Boolean(loadPaths && (syntaxCatalog || market)) && active && !searching,
    staleTime: 30_000,
    networkMode: "always",
    retry: false,
  });
  const enableSyntax = useMutation({
    mutationFn: (id: string) => syntaxCatalog!.enable(projectId, id),
    networkMode: "always",
    onSuccess: (item) => onUpdate(item.id, item),
  });
  const updates = useMutation({ mutationFn: () => market!.updates(projectId) });
  const mutation = useMutation({
    networkMode: "always",
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
  const refreshingExtensions = refreshing || availableSyntax.isFetching || projectPaths.isFetching || marketRefreshing;
  const enableableSyntax = availableSyntax.data?.filter((source) => items.every((item) => item.id !== source.id || !item.enabled)) ?? [];
  const hasMarket = Boolean(market);
  const recommendations = useMemo(() =>
    recommendCodeExtensions(projectPaths.data?.paths ?? [], availableSyntax.data ?? [], items, hasMarket),
  [projectPaths.data, availableSyntax.data, items, hasMarket]);
  const title = t("codeReview.extensions.title");

  function refreshExtensions() {
    retry();
    if (syntaxCatalog) void availableSyntax.refetch();
    if (loadPaths && !searching) void projectPaths.refetch();
    if (searching) {
      if (pendingQuery) setSubmitted(term);
      else void client.invalidateQueries({ queryKey: marketQueryKey, exact: true });
    }
  }

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

  function syntaxRow(source: CodeSyntaxSource, reason?: string) {
    const enabled = items.some((item) => item.id === source.id && item.enabled);
    return <li key={source.id} className="code-extension-row">
      <span className="code-extension-copy">
        <strong className="code-extension-line">{source.name}</strong>
        <span className="code-extension-meta">{reason ?? source.version}</span>
      </span>
      <Button size="small" disabled={refreshingExtensions || loadError || enabled || enableSyntax.isPending}
        aria-label={t(enabled ? "codeReview.extensions.syntaxEnabled" : "codeReview.extensions.enableSyntaxLabel", { name: source.name })}
        onClick={() => enableSyntax.mutate(source.id)}>
        {t(enabled ? "codeReview.extensions.activeSyntax" : "codeReview.extensions.enable")}
      </Button>
    </li>;
  }

  return <section className="code-extensions" aria-label={title}>
    <header className="code-review-header">
      <h1>{title}</h1>
      <div className="code-review-header-actions" role="group" aria-label={t("codeReview.panelActions", { name: title })}>
        <IconButton icon="refresh" className="code-review-tool" label={t("codeReview.extensions.refresh")}
          disabled={refreshingExtensions || mutation.isPending || enableSyntax.isPending}
          aria-busy={refreshingExtensions || undefined} onClick={refreshExtensions} />
        {syntaxOnly && syntaxCatalog ? <IconButton icon="import" className="code-review-tool" label={t("codeReview.extensions.installSyntax")}
          data-code-syntax-install="" aria-haspopup="menu" aria-expanded={menu.trigger?.hasAttribute("data-code-syntax-install") ?? false}
          disabled={refreshingExtensions || loadError || enableSyntax.isPending || !enableableSyntax.length}
          onClick={(event) => menu.show(event, t("codeReview.extensions.syntaxCatalog"), enableableSyntax.map((source) => ({
            label: t("codeReview.extensions.enableSyntaxLabel", { name: source.name }),
            run: () => enableSyntax.mutate(source.id),
          })))} />
          : !syntaxOnly && <IconButton icon="import" className="code-review-tool" label={t("codeReview.extensions.install")}
            disabled={refreshing || mutation.isPending} onClick={() => mutation.mutate(null)} />}
      </div>
    </header>
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
      {market && items.length > 0 && <IconButton icon="more" className="code-review-tool" label={t("codeReview.extensions.actions")} aria-haspopup="menu"
        aria-expanded={Boolean(menu.trigger?.closest(".code-extension-toolbar"))} onClick={(event) => {
          menu.show(event, title, [{
            label: t("codeReview.extensions.marketCheckUpdates"), disabled: offline || mutation.isPending || updates.isPending,
            description: offline ? t("codeReview.extensions.marketOffline") : undefined, run: () => {
              clearSearch();
              setInstalledOpen(true);
              updates.mutate();
            },
          }]);
        }} />}
    </header>}
    {mutation.isError && <p className="code-extension-feedback" role="alert">{t(
      installError === "codeReview.extensions.unsupported" ? unsupported : installError,
    )}</p>}
    {(mutation.isPending || updates.isPending) && <p className="code-extension-feedback" role="status">{t("navigation.loadingWorkspace")}</p>}
    <div className="code-extension-sections">
      {!searching && (syntaxCatalog || market) && <ExtensionGroup label={t("codeReview.extensions.projectRecommended")}
        expanded={recommendedOpen} toggle={() => setRecommendedOpen((value) => !value)}>
        {(projectPaths.isFetching || availableSyntax.isFetching) && !recommendations.length
          ? <p role="status">{t("codeReview.extensions.marketLoadingFeatured")}</p>
          : projectPaths.isError ? <p role="alert">{t("codeReview.extensions.recommendationsUnavailable")}</p>
            : !recommendations.length && <p>{t("codeReview.extensions.noProjectRecommendations")}</p>}
        {offline && market && <p role="status">{t("codeReview.extensions.marketOffline")}</p>}
        {enableSyntax.isError && <p role="alert">{t(extensionErrorMessage(enableSyntax.error))}</p>}
        {recommendations.length > 0 && <ul className="code-extension-list">
          {recommendations.map((item) => {
            const reason = t(item.count === 1 ? "codeReview.extensions.recommendationFile" : "codeReview.extensions.recommendationFiles", { count: item.count });
            return item.kind === "syntax" ? syntaxRow(item, reason) : <li key={item.id} className="code-extension-row">
              <span className="code-extension-copy">
                <strong className="code-extension-line">{item.name}</strong>
                <span className="code-extension-meta">{reason}</span>
              </span>
              <Button size="small" disabled={offline} aria-haspopup="dialog"
                aria-label={t("codeReview.extensions.viewRecommendation", { name: item.name })}
                onClick={() => selectCatalog({ id: item.id })}>{t("codeReview.extensions.viewDetails")}</Button>
            </li>;
          })}
        </ul>}
      </ExtensionGroup>}
      {!searching && <ExtensionGroup label={t(syntaxOnly ? "codeReview.extensions.projectSyntax" : "codeReview.extensions.installedTab")} count={loading || loadError ? undefined : items.length}
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
      {!searching && syntaxCatalog && <ExtensionGroup label={t("codeReview.extensions.syntaxCatalog")}
        expanded={catalogOpen} toggle={() => setCatalogOpen((value) => !value)}>
        {catalogOpen && <>
          {availableSyntax.isPending && <p role="status">{t("navigation.loadingWorkspace")}</p>}
          {availableSyntax.isError && <p role="alert">{t("codeReview.extensions.storage")}{" "}
            <Button size="small" onClick={() => { void availableSyntax.refetch(); }}>{t("codeReview.refresh")}</Button></p>}
          {availableSyntax.data && <ul className="code-extension-list">
            {availableSyntax.data.map((source) => syntaxRow(source))}
          </ul>}
        </>}
      </ExtensionGroup>}
      {market && searching && <section className="code-extension-group" aria-label={t("codeReview.extensions.marketResults")}>
        <h2 className="code-extension-group-heading">{t("codeReview.extensions.marketResults")}</h2>
        <div className="code-extension-group-body">
          <CodeOpenVsxResults market={market} projectId={projectId} items={items} active={active} offline={offline}
            query={query} pendingQuery={pendingQuery} openDetails={(id, version) => selectCatalog({ id, version })} />
        </div>
      </section>}
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
          <dt>{t("codeReview.extensions.marketSource")}</dt><dd>{selectedPackage.source === "local" ? t("codeReview.extensions.localPackage")
            : selectedPackage.source === "bundledSyntax" ? t("codeReview.extensions.syntaxCatalog") : "Open VSX"}</dd>
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
