import type { DraftContent, MailAccount, MailDetail, MailItem, MailLabel, MailProvider, MessageActions } from "./data/mailData";
import { readCachedResponse, writeCachedResponse } from "./client-cache";
import { deviceHeaders } from "./device-info";
import { clearClientSessionToken, clearMobileDeviceToken, getClientSessionToken, getMobileDeviceToken, isNativeClient, resolveApiUrl, setClientSessionToken } from "./mobile-backend";
import { enqueueClientOperation, pendingClientOperations, removeClientOperation } from "./client-outbox";

const legacyApiKey = "mailCollectorApiKey";
const localApiKeyKey = "mailCollectorApiKey:local";
const localRememberedKey = "mailCollectorRememberedApiKey:local";

function loadLocalApiKey(): string {
  return sessionStorage.getItem(localApiKeyKey) ?? localStorage.getItem(localRememberedKey) ?? sessionStorage.getItem(legacyApiKey) ?? "";
}

let localApiKey = loadLocalApiKey();
export const unauthorizedEvent = "mail-collector:unauthorized";

function clearLocalApiKey() {
  localApiKey = "";
  sessionStorage.removeItem(legacyApiKey);
  sessionStorage.removeItem(localApiKeyKey);
  localStorage.removeItem(localRememberedKey);
}

function clearAllAuth() {
  clearLocalApiKey();
  clearClientSessionToken();
  clearMobileDeviceToken();
}

async function fetchLocal(path: string, options: RequestInit = {}, key = localApiKey): Promise<Response> {
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");
  if (options.body) headers.set("Content-Type", "application/json");
  if (isNativeClient()) {
    for (const [name, value] of Object.entries(deviceHeaders())) headers.set(name, value);
  }
  const nativeToken = getClientSessionToken();
  if (nativeToken) headers.set("Authorization", `Bearer ${nativeToken}`);
  else if (key) headers.set("X-API-Key", key);
  else {
    const deviceToken = getMobileDeviceToken();
    if (deviceToken) headers.set("X-Device-Token", deviceToken);
  }
  return fetch(resolveApiUrl(path), { ...options, headers, credentials: isNativeClient() ? "omit" : "include" });
}

async function request<T>(path: string, options: RequestInit = {}, notifyUnauthorized = true): Promise<T> {
  const method = (options.method ?? "GET").toUpperCase();
  try {
    const response = await fetchLocal(path, options);
    if (response.status === 401 && notifyUnauthorized) {
      clearAllAuth();
      window.dispatchEvent(new Event(unauthorizedEvent));
    }
    if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? `请求失败 (${response.status})`);
    const payload = response.status === 204 ? undefined as T : await response.json() as T;
    if (method === "GET") void writeCachedResponse(path, payload);
    return payload;
  } catch (error) {
    if (method === "GET") {
      const cached = await readCachedResponse<T>(path);
      if (cached !== null) return cached;
    }
    throw error;
  }
}

async function nativeAuthRequest<T>(path: string, body?: Record<string, unknown>): Promise<T> {
  const response = await fetchLocal(path, { method: body ? "POST" : "GET", body: body ? JSON.stringify(body) : undefined }, "");
  if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? "认证失败");
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

async function flushOutbox(): Promise<void> {
  for (const operation of pendingClientOperations()) {
    try {
      const response = await fetchLocal(operation.path, {
        method: operation.method,
        headers: { "X-Operation-ID": operation.id },
        body: operation.body ? JSON.stringify(operation.body) : undefined
      });
      if (response.ok) removeClientOperation(operation.id);
    } catch {
      return;
    }
  }
}

export const auth = {
  status: async () => request<{ registered: boolean }>("/api/auth/status", {}, false),
  restore: async () => {
    if (!isNativeClient() || !getClientSessionToken()) return false;
    try { return (await nativeAuthRequest<{ user: { email: string } }>("/api/client-auth/session")).user.email.length > 0; } catch { return true; }
  },
  signIn: async (email: string, password: string) => {
    clearAllAuth();
    if (isNativeClient()) {
      const result = await nativeAuthRequest<{ token: string }>("/api/client-auth/login", { email, password });
      setClientSessionToken(result.token);
      await flushOutbox();
      return;
    }
    await request("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }, false);
  },
  register: async (email: string, password: string, inviteCode: string) => {
    clearAllAuth();
    if (isNativeClient()) {
      const result = await nativeAuthRequest<{ token: string }>("/api/client-auth/register", { email, password, inviteCode });
      setClientSessionToken(result.token);
      return;
    }
    await request("/api/auth/register", { method: "POST", body: JSON.stringify({ email, password, inviteCode }) }, false);
  },
  signOut: async () => {
    try { if (isNativeClient()) await nativeAuthRequest<void>("/api/client-auth/logout", {}); else await request<void>("/api/auth/logout", { method: "POST" }, false); } finally { clearAllAuth(); }
  }
};

export const api = {
  accounts: () => request<{ accounts: MailAccount[] }>("/api/accounts"),
  providers: () => request<{ providers: MailProvider[] }>("/api/providers"),
  messages: (params: URLSearchParams) => request<{ messages: MailItem[]; total: number }>(`/api/messages?${params}`),
  message: (id: number) => request<{ message: MailDetail }>(`/api/messages/${id}`),
  updateMessage: (id: number, actions: MessageActions) => request<{ ok: true; message: MailDetail }>(`/api/messages/${id}`, { method: "PATCH", body: JSON.stringify(actions) }),
  bulkMessages: (ids: number[], actions: MessageActions) => request<{ ok: true; updated: number; missingIds: number[] }>("/api/messages/bulk", { method: "POST", body: JSON.stringify({ ids, ...actions }) }),
  deleteMessage: (id: number) => request<void>(`/api/messages/${id}`, { method: "DELETE" }),
  syncPull: () => request<unknown>("/api/sync/pull?after=0"),
  flushOutbox
};
