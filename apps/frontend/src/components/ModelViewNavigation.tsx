import { useI18n } from "../i18n";
import type { SavedView } from "../platform";
import { ActionIcon } from "./ActionIcon";

/** Navigation reuses the canvas view callback; it never writes a layout. */
export function ModelViewNavigation({ sourceId, views, activeView, disabled, onApply }: {
  sourceId: string; views: SavedView[]; activeView?: SavedView; disabled?: boolean;
  onApply: (view: SavedView | undefined) => void;
}) {
  const { t } = useI18n();

  return <nav className="model-view-navigation" aria-label={t("navigation.modelViews")}>
    <h2 className="navigation-section-title">{t("navigation.modelViews")}</h2>
    <button type="button" disabled={disabled} aria-current={!activeView ? "page" : undefined} onClick={() => onApply(undefined)}><ActionIcon name="grid" /><span>{t("navigation.fullModel")}</span></button>
    {views.filter((view) => view.sourceId === sourceId).map((view) => <button key={view.id} type="button" title={view.name} disabled={disabled} aria-current={view.id === activeView?.id ? "page" : undefined} onClick={() => onApply(view)}><ActionIcon name="table" /><span>{view.name}</span></button>)}
    {disabled ? <p>{t("navigation.availableInTheLatestModel")}</p> : null}
  </nav>;
}
