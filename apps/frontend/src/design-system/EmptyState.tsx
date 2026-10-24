import type { ReactNode } from "react";
import "./surfaces.css";

/** Presentational only: the owner supplies localized copy, icons and actions. */
export function EmptyState({ title, description, icon, actions, compact = false, className = "" }: {
  title: ReactNode; description?: ReactNode; icon?: ReactNode; actions?: ReactNode; compact?: boolean; className?: string;
}) {
  return <div className={`ds-empty-state ${className}`} data-compact={compact || undefined}>
    {icon}<strong>{title}</strong>{description ? <p>{description}</p> : null}{actions ? <div className="ds-empty-actions">{actions}</div> : null}
  </div>;
}
