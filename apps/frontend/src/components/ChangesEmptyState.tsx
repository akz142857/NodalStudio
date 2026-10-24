import { useI18n } from "../i18n";
import type { DatabaseSnapshot } from "../platform";
import { ActionIcon } from "./ActionIcon";

export function ChangesEmptyState({ snapshot, desktop, snapshotCount, loading, error, refreshing, onHistory, onRefresh, onRetry }: {
  snapshot?: DatabaseSnapshot;
  desktop: boolean;
  snapshotCount: number;
  loading: boolean;
  error: boolean;
  refreshing: boolean;
  onHistory: () => void;
  onRefresh?: () => void;
  onRetry: () => void;
}) {
  const { t: bt } = useI18n();
  const title = !snapshot ? bt("business.selectADatabaseToReviewChanges")
    : !desktop ? bt("business.noComparisonIncludedInThisShare")
    : error ? bt("business.snapshotHistoryCouldNotBeLoaded")
    : loading ? bt("business.checkingSnapshotHistory")
    : snapshotCount < 2 ? bt("business.yourFirstSnapshotIsTheStartingPoint")
    : bt("business.chooseTwoSnapshotsToCompare");
  const message = !snapshot ? bt("business.openASavedDatabaseFromTheSidebarChangesCompares")
    : !desktop ? bt("business.openThisDatabaseInTheDesktopAppToBrowse")
    : error ? bt("business.yourCurrentModelIsStillAvailableRetryLoadingHistory")
    : loading ? bt("business.lookingForSavedVersionsOfThisDatabase")
    : snapshotCount < 2 ? bt("business.thereIsNoEarlierVersionToCompareYetRefresh")
    : bt("business.openHistoryAndSelectABeforeAndAfterVersion");
  return <section className="changes-empty-state" aria-label={bt("business.schemaChanges")}>
    <span className="changes-empty-icon"><ActionIcon name="history" /></span>
    <p className="eyebrow">{snapshot ? bt("business.schemaChangesDetail", { value0: snapshot.database.name }) : bt("business.schemaChanges")}</p>
    <h2>{title}</h2><p role={error ? "alert" : "status"}>{message}</p>
    {snapshot && desktop ? <div className="changes-empty-actions">
      {error ? <button type="button" onClick={onRetry}>{bt("business.retryLoadingHistory")}</button> : <button type="button" onClick={onHistory}>{bt("business.openHistory")}</button>}
      {onRefresh ? <button type="button" onClick={onRefresh} disabled={refreshing}>{refreshing ? bt("business.refreshing") : bt("business.refreshSchema")}</button> : null}
    </div> : null}
    <p className="changes-empty-note">{bt("business.tracksSchemaStructureNotChangesToIndividualDataRows")}</p>
  </section>;
}
