import { useI18n } from "../../i18n";
import { ActionIcon } from "../ActionIcon";
import "./update-banner.css";

export function UpdateBanner({ version, onOpen, onDismiss }: {
  version: string; onOpen: () => void; onDismiss: () => void;
}) {
  const { t } = useI18n();

  return <section className="app-update-banner" aria-label={t("updates.applicationUpdate")} role="status">
    <span className="app-update-icon" aria-hidden="true"><ActionIcon name="refresh" /></span>
    <div className="app-update-copy">
      <strong>{t("updates.banner.title", { version })}</strong>
      <span>{t("updates.reviewWhatSNewYouChooseWhenTo")}</span>
    </div>
    <div className="app-update-actions">
      <button type="button" className="app-update-open" onClick={onOpen}>{t("navigation.viewUpdate")}</button>
      <button type="button" className="app-update-later" onClick={onDismiss}>{t("updates.later")}</button>
    </div>
  </section>;
}
