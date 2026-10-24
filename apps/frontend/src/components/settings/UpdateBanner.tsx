import { ActionIcon } from "../ActionIcon";
import "./update-banner.css";

export function UpdateBanner({ version, onOpen, onDismiss }: {
  version: string; onOpen: () => void; onDismiss: () => void;
}) {
  return <section className="app-update-banner" aria-label="Application update" role="status">
    <span className="app-update-icon" aria-hidden="true"><ActionIcon name="refresh" /></span>
    <div className="app-update-copy">
      <strong>Nodal Studio {version} is available</strong>
      <span>Review what’s new. You choose when to download and install.</span>
    </div>
    <div className="app-update-actions">
      <button type="button" className="app-update-open" onClick={onOpen}>View update</button>
      <button type="button" className="app-update-later" onClick={onDismiss}>Later</button>
    </div>
  </section>;
}
