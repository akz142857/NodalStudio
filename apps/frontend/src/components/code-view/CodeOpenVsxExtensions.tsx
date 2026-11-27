import { useState } from "react";
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "../../design-system/Button";
import { ModalSurface } from "../../design-system/ModalSurface";
import { useI18n } from "../../i18n";
import type { CodeExtension, CodeOpenVsxPlatform } from "../../platform/code-review";
import { extensionErrorMessage } from "./code-extension-errors";

const catalogKey = (projectId: string) => ["code-review", projectId, "open-vsx"] as const;

export function CodeOpenVsxSearch({ market, projectId, items, offline, openDetails }: {
  market: CodeOpenVsxPlatform;
  projectId: string;
  items: CodeExtension[];
  offline: boolean;
  openDetails: (id: string) => void;
}) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const search = useInfiniteQuery({
    queryKey: [...catalogKey(projectId), "search", query],
    queryFn: ({ pageParam }) => market.search(projectId, query, pageParam),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => lastPage.nextOffset ?? undefined,
    enabled: Boolean(query) && !offline,
    retry: false,
    staleTime: 60_000,
  });
  const results = [...new Map(search.data?.pages.flatMap((page) => page.items.map((item) => [item.id, item] as const))).values()];
  return <>
    <form className="code-extension-search" role="search" onSubmit={(event) => {
      event.preventDefault();
      const value = text.trim();
      if (!value || offline) return;
      if (value === query) void search.refetch();
      else setQuery(value);
    }}>
      <input type="search" aria-label={t("codeReview.extensions.marketSearch")} placeholder={t("codeReview.extensions.marketPlaceholder")}
        value={text} maxLength={160} onChange={(event) => setText(event.currentTarget.value)} disabled={offline} />
      <Button size="small" variant="primary" type="submit" disabled={offline || !text.trim() || search.isFetching}>
        {t("codeReview.extensions.marketSubmit")}
      </Button>
    </form>
    {offline && <p role="status">{t("codeReview.extensions.marketOffline")}</p>}
    {!offline && query && <>
      {search.isFetching && <p role="status">{t("codeReview.extensions.marketSearching")}</p>}
      {search.isError && <p role="alert">{t(extensionErrorMessage(search.error))}</p>}
      {search.isSuccess && !results.length && <p role="status">{t("codeReview.extensions.marketNoResults")}</p>}
      <ul>
        {results.map((item) => {
          const installed = items.find((entry) => entry.id === item.id);
          return <li key={item.id}>
            <h3><button type="button" className="code-extension-result" onClick={() => openDetails(item.id)}>{item.name}</button></h3>
            <p className="code-extension-byline">{item.publisher} · {item.version}</p>
            {item.description && <p>{item.description}</p>}
            {installed && <p>{t("codeReview.extensions.marketInstalledVersion", { version: installed.version })}</p>}
          </li>;
        })}
      </ul>
      {search.hasNextPage && <Button size="small" disabled={search.isFetching} onClick={() => { void search.fetchNextPage(); }}>
        {t("codeReview.extensions.marketMore")}
      </Button>}
    </>}
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
  const canInstall = !offline && !detail.isPlaceholderData && release?.downloadable
    && release.capability !== "unsupported" && (!installed || upgrade);
  return <ModalSurface label={t("codeReview.extensions.marketDetails")} onDismiss={dismiss}>
    <div className="code-definition-dialog code-extension-detail ds-surface">
      <h3>{release?.name ?? id}</h3>
      {offline && <p role="status">{t("codeReview.extensions.marketOffline")}</p>}
      {!offline && (detail.isPending || detail.isPlaceholderData) && <p role="status">{t("navigation.loadingWorkspace")}</p>}
      {!offline && detail.isError && <p role="alert">{t(extensionErrorMessage(detail.error))}{" "}
        <Button variant="ghost" size="small" onClick={() => { void detail.refetch(); }}>{t("codeReview.refresh")}</Button></p>}
      {installed && <p role="status">{t("codeReview.extensions.marketInstalledVersion", { version: installed.version })}</p>}
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
        {!release.downloadable && <p role="status">{t("codeReview.extensions.marketUnavailable")}</p>}
        <label className="code-extension-version">
          {t("codeReview.extensions.marketVersion")}
          <select value={version ?? release.version} disabled={offline || install.isPending} onChange={(event) => {
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
        {canInstall && release && <Button variant="primary" busy={install.isPending} onClick={() => install.mutate(release.version)}>
          {t(upgrade ? "codeReview.extensions.marketUpdateVersion" : "codeReview.extensions.marketInstallVersion", { version: release.version })}
        </Button>}
      </div>
    </div>
  </ModalSurface>;
}
