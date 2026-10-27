import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n";
import type { NodalStudioPlatform } from "../../platform";
import type { PurchaseStatus } from "../../platform/purchase-types";
import { SettingsGroup } from "./SettingsControls";

export function PurchasePanel({ platform, version }: { platform: NodalStudioPlatform; version: string }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<PurchaseStatus>();
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState(false);
  const generation = useRef(0);
  const pending = useRef(false);
  const request = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    let reading = false;
    const read = async () => {
      if (reading || pending.current) return;
      reading = true;
      const revision = ++request.current;
      try {
        const next = await platform.getPurchaseStatus();
        if (generation.current === current && revision === request.current && !pending.current) { setStatus(next); setError(false); }
      } catch { if (generation.current === current && revision === request.current && !pending.current) setError(true); }
      finally { reading = false; }
    };
    void read();
    const timer = window.setInterval(() => void read(), 1000);
    return () => { generation.current += 1; window.clearInterval(timer); };
  }, [platform]);
  async function restore() {
    if (pending.current) return;
    pending.current = true;
    request.current += 1;
    const current = generation.current;
    setRestoring(true); setError(false);
    try {
      const next = await platform.restoreAppPurchase();
      if (generation.current === current) setStatus(next);
    } catch { if (generation.current === current) setError(true); }
    finally { pending.current = false; if (generation.current === current) setRestoring(false); }
  }
  const phase = status?.state ?? "checking";
  return <SettingsGroup title={t("purchase.title")}>
    <div className="update-summary" aria-live="polite" aria-atomic="true">
      <span className="update-symbol" aria-hidden="true">{phase === "verified" ? "✓" : "↻"}</span>
      <div><h3>{t(`purchase.${phase}`)}</h3><p>{t("purchase.store")} · {version}</p></div>
    </div>
    {status?.environment === "Sandbox" ? <p className="update-help">{t("purchase.test")}</p> : null}
    <p className="update-help">{phase === "verified" ? t("purchase.offline") : t("purchase.recoveryHelp")}</p>
    {error || status?.reason ? <p role="status" className="update-error">{status?.reason === "cancelled" ? t("purchase.cancelled") : phase === "unverified" ? t("purchase.invalid") : t("purchase.retry")}</p> : null}
    <div className="setting-action-row update-actions">
      <button type="button" disabled={restoring || status?.busy} onClick={() => void restore()}>{restoring || status?.busy ? t("purchase.restoring") : t("purchase.restore")}</button>
      <button type="button" onClick={() => void platform.openAppStore().catch(() => setError(true))}>{t("purchase.openStore")}</button>
    </div>
    <p className="update-help">{t("purchase.restoreHelp")}</p>
    <p className="update-help">{t("purchase.updates")}</p>
  </SettingsGroup>;
}
