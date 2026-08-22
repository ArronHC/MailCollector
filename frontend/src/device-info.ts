import { isNativeMobile } from "./mobile-backend";

const DEVICE_ID_KEY = "mailCollectorDeviceId";
const DEVICE_NAME_KEY = "mailCollectorDeviceName";

export function getDeviceId(): string {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

export function getDevicePlatform(): "windows" | "android" | "web" {
  if (isNativeMobile()) return "android";
  if (Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)) return "windows";
  return "web";
}

export function getDeviceName(): string {
  let name = localStorage.getItem(DEVICE_NAME_KEY);
  if (!name) {
    name = `${getDevicePlatform()} device`;
    localStorage.setItem(DEVICE_NAME_KEY, name);
  }
  return name;
}

export function deviceHeaders(): Record<string, string> {
  return {
    "X-Device-ID": getDeviceId(),
    "X-Device-Name": getDeviceName(),
    "X-Device-Platform": getDevicePlatform()
  };
}
