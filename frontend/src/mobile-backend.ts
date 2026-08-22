const CLIENT_BACKEND_KEY = "mailCollectorClientBackendUrl";
const LEGACY_MOBILE_BACKEND_KEY = "mailCollectorMobileBackendUrl";
const MOBILE_DEVICE_TOKEN_KEY = "mailCollectorMobileDeviceToken";
const CLIENT_SESSION_KEY = "mailCollectorClientSessionToken";

type CapacitorBridge = { isNativePlatform?: () => boolean; getPlatform?: () => string };

function capacitorBridge(): CapacitorBridge | undefined {
  return (window as Window & { Capacitor?: CapacitorBridge }).Capacitor;
}

export function isNativeDesktop(): boolean {
  return Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

export function isNativeMobile(): boolean {
  const bridge = capacitorBridge();
  if (bridge?.isNativePlatform?.()) return true;
  return bridge?.getPlatform?.() === "android" || bridge?.getPlatform?.() === "ios";
}

export function isNativeClient(): boolean {
  return isNativeDesktop() || isNativeMobile();
}

export function normalizeMobileBackendUrl(value: string): string {
  let input = value.trim();
  if (!input) throw new Error("请输入 Mail Collector VPS 地址");
  if (!/^https?:\/\//i.test(input)) input = `https://${input}`;
  const url = new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("VPS 地址必须使用 http:// 或 https://");
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/+$/, "");
}

export function getMobileBackendUrl(): string {
  if (!isNativeClient()) return "";
  return localStorage.getItem(CLIENT_BACKEND_KEY) ?? localStorage.getItem(LEGACY_MOBILE_BACKEND_KEY) ?? "";
}

export function setMobileBackendUrl(value: string): string {
  const normalized = normalizeMobileBackendUrl(value);
  localStorage.setItem(CLIENT_BACKEND_KEY, normalized);
  localStorage.removeItem(LEGACY_MOBILE_BACKEND_KEY);
  return normalized;
}

export function clearClientBackend(): void {
  localStorage.removeItem(CLIENT_BACKEND_KEY);
  localStorage.removeItem(LEGACY_MOBILE_BACKEND_KEY);
  clearClientSessionToken();
  clearMobileDeviceToken();
}

export function getClientSessionToken(): string {
  return localStorage.getItem(CLIENT_SESSION_KEY) ?? "";
}

export function setClientSessionToken(value: string): string {
  const token = value.trim();
  if (token.length < 24) throw new Error("登录凭证无效");
  localStorage.setItem(CLIENT_SESSION_KEY, token);
  return token;
}

export function clearClientSessionToken(): void {
  localStorage.removeItem(CLIENT_SESSION_KEY);
}

export function getMobileDeviceToken(): string {
  return localStorage.getItem(MOBILE_DEVICE_TOKEN_KEY) ?? "";
}

export function setMobileDeviceToken(value: string): string {
  const token = value.trim();
  if (token.length < 24) throw new Error("设备凭证无效");
  localStorage.setItem(MOBILE_DEVICE_TOKEN_KEY, token);
  return token;
}

export function clearMobileDeviceToken(): void {
  localStorage.removeItem(MOBILE_DEVICE_TOKEN_KEY);
}

export function resolveApiUrl(path: string): string {
  const backend = getMobileBackendUrl();
  return backend && path.startsWith("/") ? `${backend}${path}` : path;
}

export function isUsingMobileBackend(): boolean {
  return Boolean(getMobileBackendUrl());
}

export async function testMobileBackend(value: string): Promise<string> {
  const backend = normalizeMobileBackendUrl(value);
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${backend}/api/service`, {
      headers: { Accept: "application/json" },
      credentials: "omit",
      signal: controller.signal
    });
    if (!response.ok) throw new Error(response.status === 404 ? "该地址没有找到 Mail Collector VPS API" : `服务器返回 ${response.status}`);
    const payload = await response.json().catch(() => null) as { service?: string } | null;
    if (payload?.service !== "mail-collector") throw new Error("该地址不是 Mail Collector 服务");
    return backend;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw new Error("连接 VPS 超时，请检查地址和网络");
    throw error instanceof Error ? error : new Error("无法连接 Mail Collector VPS");
  } finally {
    window.clearTimeout(timer);
  }
}
