import { useState } from "react";
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "../../design-system/Button";
import { ModalSurface } from "../../design-system/ModalSurface";
import { useI18n } from "../../i18n";
import type { CodeExtension, CodeOpenVsxPlatform } from "../../platform/code-review";
import { CodeExtensionRow } from "./CodeExtensionRow";
import { extensionErrorMessage } from "./code-extension-errors";

const catalogKey = (projectId: string) => ["code-review", projectId, "open-vsx"] as const;

export function CodeOpenVsxResults({ market, projectId, items, offline, active, query, pendingQuery, openDetails }: {
  market: CodeOpenVsxPlatform;
  projectId: string;
  items: CodeExtension[];
  offline: boolean;
  active: boolean;
  query: string;
  pendingQuery: boolean;
  openDetails: (id: string, version: string) => void;
}) {
  const { t } = useI18n();
  const search = useInfiniteQuery({
    queryKey: [...catalogKey(projectId), "search", query],
    queryFn: ({ pageParam }) => market.search(projectId, query, pageParam),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => lastPage.nextOffset ?? undefined,
    enabled: active && !offline && !pendingQuery,
    retry: false,
    staleTime: 60_000,
  });
  const results = [...new Map(search.data?.pages.flatMap((page) => page.items.map((item) => [item.id, item] as const))).values()];
  if (offline) return <p role="status">{t("codeReview.extensions.marketOffline")}</p>;
  if (pendingQuery || search.isPending) return <p role="status">
    {t(query || pendingQuery ? "codeReview.extensions.marketSearching" : "codeReview.extensions.marketLoadingFeatured")}
  </p>;
  return <>
    {search.isError && <p role="alert">{t(extensionErrorMessage(search.error))}{" "}
      <Button size="small" variant="ghost" onClick={() => { void search.refetch(); }}>{t("codeReview.refresh")}</Button></p>}
    {search.isSuccess && !results.length && <p role="status">
      {t(search.hasNextPage ? "codeReview.extensions.marketNoResultsYet"
        : query ? "codeReview.extensions.marketNoResults" : "codeReview.extensions.marketNoFeatured")}
    </p>}
    {results.length > 0 && <ul className="code-extension-list">
      {results.map((item) => {
        const installed = items.find((entry) => entry.id === item.id);
        return <CodeExtensionRow key={item.id} item={item} verified={item.verified} onOpen={() => openDetails(item.id, item.version)}
          status={installed && (installed.version === item.version ? t("codeReview.extensions.installedTab")
            : t("codeReview.extensions.marketInstalledVersion", { version: installed.version }))} />;
      })}
    </ul>}
    {search.hasNextPage && <Button size="small" disabled={search.isFetching} onClick={() => { void search.fetchNextPage(); }}>
      {t("codeReview.extensions.marketMore")}
    </Button>}
  </>;
}

export function CodeOpenVsxDetails({ market, projectId, id, initialVersion, installed, offline, dismiss, onInstall }: {
  market: CodeOpenVsxPlatform;
  projectId: string;
  id: string;
  initialVersion?: string;
  installed?: CodeExtension;
  offline: boolean;
  dismiss: () => void;
  onInstall: (item: CodeExtension) => void;
}) {
  const { t } = useI18n();
  const [version, setVersion] = useState(initialVersion);
  const detail = useQuery({
    queryKey: [...catalogKey(projectId), "detail", id, version, installed?.sha256],
    queryFn: () => market.detail(projectId, id, version),
    enabled: !offline,
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 60_000,
  });
  const install = useMutation({
    mutationFn: (release: string) => market.install(projectId, { id, version: release, installedSha256: installed?.sha256 }),
    onSuccess: onInstall,
  });
  const release = detail.data;
  const compatibility = release?.capability === "diagnostics" ? "marketDiagnostics"
    : release?.capability === "eslint" ? "marketEslint"
      : release?.capability === "syntax" ? "marketSyntax"
        : release?.capability === "unsupported" ? "unsupportedStatus" : "marketUnknown";
  const upgrade = Boolean(installed && release?.canUpdate && installed.version !== release.version);
  const showInstall = !installed || upgrade;
  const canInstall = !offline && !detail.isPlaceholderData && release?.downloadable && release.capability != null && release.capability !== "unsupported";
  const incompatibility = release?.incompatibility === "debugger" ? "marketRequiresDebugger"
    : release?.incompatibility === "extensionDependencies" ? "marketRequiresExtensions" : "unsupported";
  return <ModalSurface label={t("codeReview.extensions.marketDetails")} onDismiss={dismiss}>
    <div className="code-definition-dialog code-extension-detail ds-surface">
      <h3>{release?.name ?? id}</h3>
      {offline && <p role="status">{t("codeReview.extensions.marketOffline")}</p>}
      {!offline && (detail.isPending || detail.isPlaceholderData) && <p role="status">{t("navigation.loadingWorkspace")}</p>}
      {!offline && detail.isError && <p role="alert">{t(extensionErrorMessage(detail.error))}{" "}
        <Button variant="ghost" size="small" onClick={() => { void detail.refetch(); }}>{t("codeReview.refresh")}</Button></p>}
      {installed && <p role="status">
        {t("codeReview.extensions.marketInstalledVersion", { version: installed.version })}
        {installed.enabled && ` · ${t("codeReview.extensions.enabled")}`}
      </p>}
      {release && <>
        <p className="code-extension-byline">Open VSX · {release.id}</p>
        {release.description && <p>{release.description}</p>}
        <dl>
          <dt>{t("codeReview.extensions.marketPublisher")}</dt><dd>{release.publisher}{release.verified ? ` · ${t("codeReview.extensions.marketVerified")}` : ""}</dd>
          <dt>{t("codeReview.extensions.marketCompatibility")}</dt><dd>{t(`codeReview.extensions.${compatibility}`)}</dd>
          {release.engine && <><dt>{t("codeReview.extensions.vscodeEngine")}</dt><dd>{release.engine}</dd></>}
          {release.license && <><dt>{t("codeReview.extensions.marketLicense")}</dt><dd>{release.license}</dd></>}
        </dl>
        {release.deprecated && <p role="status">{t("codeReview.extensions.marketDeprecated")}</p>}
        {!detail.isPlaceholderData && release.capability === "unsupported" && <p role="status">{t(`codeReview.extensions.${incompatibility}`)}</p>}
        {!detail.isPlaceholderData && !release.downloadable && <p role="status">{t("codeReview.extensions.marketUnavailable")}</p>}
        <label className="code-extension-version">
          {t("codeReview.extensions.marketVersion")}
          <select className="ds-select" value={version ?? release.version} disabled={offline || install.isPending} onChange={(event) => {
            install.reset();
            setVersion(event.currentTarget.value);
          }}>
            {release.versions.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
      </>}
      {install.isError && <p role="alert">{t(extensionErrorMessage(install.error))}</p>}
      <div className="code-review-note-actions">
        <Button data-modal-focus onClick={dismiss}>{t("codeReview.extensions.marketClose")}</Button>
        {showInstall && release && <Button variant="primary" disabled={!canInstall} busy={install.isPending} onClick={() => install.mutate(release.version)}>
          {t(upgrade ? "codeReview.extensions.marketUpdateVersion" : "codeReview.extensions.marketInstallVersion", { version: release.version })}
        </Button>}
      </div>
    </div>
  </ModalSurface>;
}
