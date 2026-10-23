import type { SavedView } from "../platform";
import { ActionIcon } from "./ActionIcon";

/** Navigation reuses the canvas view callback; it never writes a layout. */
export function ModelViewNavigation({ sourceId, views, activeView, disabled, onApply }: {
  sourceId: string; views: SavedView[]; activeView?: SavedView; disabled?: boolean;
  onApply: (view: SavedView | undefined) => void;
}) {
  return <nav className="model-view-navigation" aria-label="Model views">
    <h2 className="navigation-section-title">Model views</h2>
    <button type="button" disabled={disabled} aria-current={!activeView ? "page" : undefined} onClick={() => onApply(undefined)}><ActionIcon name="grid" /><span>Full model</span></button>
    {views.filter((view) => view.sourceId === sourceId).map((view) => <button key={view.id} type="button" title={view.name} disabled={disabled} aria-current={view.id === activeView?.id ? "page" : undefined} onClick={() => onApply(view)}><ActionIcon name="table" /><span>{view.name}</span></button>)}
    {disabled ? <p>Available in the latest model.</p> : null}
  </nav>;
}
