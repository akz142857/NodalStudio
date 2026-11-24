import { useI18n } from "../i18n";
import type { ConnectionFolderStatus } from "../platform/types";
import { IconButton } from "./IconButton";

type ConnectionFolderToolbarButtonProps = {
  status?: ConnectionFolderStatus;
  statusFailed: boolean;
  mergeFailed: boolean;
  offline: boolean;
  onOpen: () => void;
};

const badges = {
  mergeFailed: { message: "connectionFolder.mergeFailed", symbol: "!", tone: "danger" },
  syncFailed: { message: "connectionFolder.syncFailed", symbol: "!", tone: "danger" },
  disabled: { message: "connectionFolder.disabled", symbol: "−", tone: "neutral" },
  paused: { message: "connectionFolder.paused", symbol: "Ⅱ", tone: "neutral" },
  offline: { message: "connectionFolder.offline", symbol: "Ⅱ", tone: "neutral" },
  waiting: { message: "connectionFolder.waiting", symbol: "…", tone: "neutral" },
  pending: { message: "connectionFolder.updatesAvailable", symbol: "↓", tone: "accent" },
} as const;

function getBadge({ status, statusFailed, mergeFailed, offline }: Omit<ConnectionFolderToolbarButtonProps, "onOpen">) {
  if (status?.paused) return badges.paused;
  if (status?.folder && (offline || status.problem === "offline")) return badges.offline;
  if (mergeFailed) return badges.mergeFailed;
  if (statusFailed) return badges.syncFailed;
  if (!status) return undefined;
  if (!status.folder) return badges.disabled;
  if (status.problem === "folderWaiting") return badges.waiting;
  if (status.problem) return badges.syncFailed;
  if (status.pending > 0) return badges.pending;
  return undefined;
}

export function ConnectionFolderToolbarButton({ onOpen, ...state }: ConnectionFolderToolbarButtonProps) {
  const { t } = useI18n();
  const badge = getBadge(state);
  const description = badge ? t(badge.message) : undefined;

  return <IconButton
    icon="cloud"
    label={t("navigation.openCloudSync")}
    description={description}
    aria-description={description}
    onClick={(event) => {
      event.currentTarget.focus({ preventScroll: true });
      onOpen();
    }}
  >
    {badge ? <span aria-hidden="true" className="connection-folder-badge" data-tone={badge.tone}>{badge.symbol}</span> : null}
  </IconButton>;
}
