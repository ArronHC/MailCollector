const MOBILE_BACKEND_KEY = "mailCollectorMobileBackendUrl";
const MOBILE_DEVICE_TOKEN_KEY = "mailCollectorMobileDeviceToken";

type CapacitorBridge = {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
};

function capacitorBridge(): CapacitorBridge | undefined {
  return (window as Window & { Capacitor?: CapacitorBridge }).Capacitor;
}

export function isNativeMobile(): boolean {
  const bridge = capacitorBridge();
  if (bridge?.isNativePlatform?.()) return true;
  const platform = bridge?.getPlatform?.();
  return platform === "android" || platform === "ios";
}

export function normalizeMobileBackendUrl(value: string): string {
  let input = value.trim();
  if (!input) throw new Error("请输入 Mail Collector 服务地址");
  if (!/^https?:\/\//i.test(input)) input = `https://${input}`;
  const url = new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("服务地址必须使用 http:// 或 https://");
  }
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/+$/, "");
}

export function getMobileBackendUrl(): string {
  if (!isNativeMobile()) return "";
  return localStorage.getItem(MOBILE_BACKEND_KEY) ?? "";
}

export function setMobileBackendUrl(value: string): string {
  const normalized = normalizeMobileBackendUrl(value);
  localStorage.setItem(MOBILE_BACKEND_KEY, normalized);
  return normalized;
}

export function getMobileDeviceToken(): string {
  if (!isNativeMobile()) return "";
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
  if (!backend || !path.startsWith("/")) return path;
  return `${backend}${path}`;
}

export function isUsingMobileBackend(): boolean {
  return Boolean(getMobileBackendUrl());
}

export async function testMobileBackend(value: string): Promise<string> {
  const backend = normalizeMobileBackendUrl(value);
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${backend}/api/auth/status`, {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" },
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(response.status === 404 ? "该地址没有找到 Mail Collector API" : `服务器返回 ${response.status}`);
    }
    return backend;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("连接服务器超时，请检查地址和网络");
    }
    throw error instanceof Error ? error : new Error("无法连接 Mail Collector 服务");
  } finally {
    window.clearTimeout(timer);
  }
}
