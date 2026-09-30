import { useEffect, useEffectEvent } from "react";

const REMOTE_REFRESH_MS = 15_000;

/** Refresh periodically and when the window regains focus. */
export function useRemoteRefresh(refreshRemoteState: () => Promise<void>) {
  const refresh = useEffectEvent(() => {
    void refreshRemoteState().catch(() => undefined);
  });

  useEffect(() => {
    const timer = window.setInterval(refresh, REMOTE_REFRESH_MS);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, []);
}
