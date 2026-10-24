import { useEffect, useRef, useState } from "react";
import type { AppSettings, NodalStudioPlatform, UpdateCheckResult } from "../../platform";

// Independent of workspace restoration: changing data sources must not discard
// an in-flight startup check. Reuse the request across StrictMode effect replay.
export function useAvailableUpdate(platform: NodalStudioPlatform, enabled: boolean, updates: AppSettings["updates"]) {
  const key = JSON.stringify([updates.channel, updates.customFeedUrl]);
  const request = useRef<{ key: string; result: Promise<UpdateCheckResult> } | undefined>(undefined);
  const [completed, setCompleted] = useState<{ key: string; result: UpdateCheckResult }>();

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    if (request.current?.key !== key) {
      request.current = { key, result: platform.checkForUpdates() };
    }
    void request.current.result.then((result) => {
      if (active) setCompleted({ key, result });
    }).catch(() => {
      // The update page exposes the native error and offers a manual retry.
    });
    return () => { active = false; };
  }, [enabled, key, platform]);

  return enabled && completed?.key === key
    ? completed.result.availableVersion : null;
}
