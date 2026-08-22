import { useEffect } from "react";
import { api } from "../api";
import { getClientSessionToken, isNativeClient } from "../mobile-backend";

const SYNC_INTERVAL_MS = 7_000;

export function SyncRuntime() {
  useEffect(() => {
    let cancelled = false;
    let running = false;

    const pulse = async () => {
      if (cancelled || running || !isNativeClient() || !getClientSessionToken()) return;
      running = true;
      try {
        const result = await api.syncPull();
        if (!cancelled && (result.events.length > 0 || result.flushed > 0)) {
          // MailboxApp already treats focus as a request to refresh its visible state.
          // Reusing that path keeps the sync runtime decoupled from mailbox UI state.
          window.dispatchEvent(new Event("focus"));
        }
      } catch {
        // Offline is expected. Cached reads and the outbox keep the client usable.
      } finally {
        running = false;
      }
    };

    const online = () => { void pulse(); };
    const visibility = () => {
      if (document.visibilityState === "visible") void pulse();
    };

    void pulse();
    const timer = window.setInterval(() => { void pulse(); }, SYNC_INTERVAL_MS);
    window.addEventListener("online", online);
    document.addEventListener("visibilitychange", visibility);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("online", online);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);

  return null;
}
