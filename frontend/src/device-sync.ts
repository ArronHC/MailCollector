import { getDeviceId } from "./device-info";
import { getClientSessionToken } from "./mobile-backend";

const OPERATION_ID = "mailCollectorOperationId";
const PLATFORM = "mailCollectorPlatform";

export function getPlatform(): "windows" | "android" | "web" {
  const current = localStorage.getItem(PLATFORM);
  if (current === "windows" || current === "android" || current === "web") return current;
  const value = window.__TAURI_INTERNALS__ ? "windows" : "web";
  localStorage.setItem(PLATFORM, value);
  return value;
}

export function getDeviceHeaders(): Record<string, string> {
  const id = getDeviceId();
  return {
    "X-Device-ID": id,
    "X-Device-Name": navigator.userAgent.slice(0, 70),
    "X-Device-Platform": getPlatform()
  };
}

export function getOperationId(): string {
  const value = crypto.randomUUID();
  localStorage.setItem(OPERATION_ID, value);
  return value;
}

export async function syncNow(): Promise<void> {
  if (!getClientSessionToken()) return;
  await fetch("/api/sync/pull", {
    headers: getDeviceHeaders()
  });
}
