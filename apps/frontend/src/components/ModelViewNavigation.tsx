import { useRef, useState } from "react";
import { useI18n } from "../i18n";
import type { SavedView } from "../platform";
import { ActionIcon } from "./ActionIcon";
import { DeleteSavedViewDialog } from "./SavedViewDialog";

export function ModelViewNavigation({ sourceId, views, activeView, disabled, onApply, onDelete }: {
  sourceId: string; views: SavedView[]; activeView?: SavedView; disabled?: boolean;
  onApply: (view: SavedView | undefined) => void;
  onDelete: (id: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [viewToDelete, setViewToDelete] = useState<SavedView>();
  const fullModelButton = useRef<HTMLButtonElement>(null);

  return <nav className="model-view-navigation" aria-label={t("navigation.modelViews")}>
    <h2 className="navigation-section-title">{t("navigation.modelViews")}</h2>
    <button ref={fullModelButton} type="button" disabled={disabled} aria-current={!activeView ? "page" : undefined} onClick={() => onApply(undefined)}><ActionIcon name="grid" /><span>{t("navigation.fullModel")}</span></button>
    {views.filter((view) => view.sourceId === sourceId).map((view) => {
      const deleteLabel = t("navigation.deleteModelView", { name: view.name });
      return <div className="model-view-row" key={view.id}>
        <button type="button" title={view.name} disabled={disabled} aria-current={view.id === activeView?.id ? "page" : undefined} onClick={() => onApply(view)}><ActionIcon name="table" /><span>{view.name}</span></button>
        <button type="button" className="model-view-delete" aria-label={deleteLabel} title={deleteLabel} disabled={disabled} onClick={(event) => {
          event.currentTarget.focus();
          setViewToDelete(view);
        }}><ActionIcon name="trash" /></button>
      </div>;
    })}
    {disabled ? <p>{t("navigation.availableInTheLatestModel")}</p> : null}
    {viewToDelete ? <DeleteSavedViewDialog view={viewToDelete} disabled={disabled} onDelete={onDelete} onClose={() => setViewToDelete(undefined)}
      returnFocus={() => fullModelButton.current?.focus()} /> : null}
  </nav>;
}
