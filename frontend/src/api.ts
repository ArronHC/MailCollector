import type { DraftContent, MailAccount, MailDetail, MailItem, MailLabel, MailProvider, MessageActions } from "./data/mailData";
import { readCachedResponse, writeCachedResponse } from "./client-cache";
import { deviceHeaders } from "./device-info";
import { applyPendingClientOperations } from "./client-outbox";
import { getSyncRevision, setSyncRevision } from "./client-sync";
import { clearClientSessionToken, clearMobileDeviceToken, getClientSessionToken, getMobileDeviceToken, isNativeClient, resolveApiUrl, setClientSessionToken } from "./mobile-backend";

const legacyApiKey = "mailCollectorApiKey";
const localApiKeyKey = "mailCollectorApiKey:local";
const localRememberedKey = "mailCollectorRememberedApiKey:local";

function loadLocalApiKey() {
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
  if (isNativeClient()) Object.entries(deviceHeaders()).forEach(([name, value]) => headers.set(name, value));
  const token = getClientSessionToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  else if (key) headers.set("X-API-Key", key);
  else if (getMobileDeviceToken()) headers.set("X-Device-Token", getMobileDeviceToken());
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
    return method === "GET" ? applyPendingClientOperations(path, payload) : payload;
  } catch (error) {
    const cached = method === "GET" ? await readCachedResponse<T>(path) : null;
    if (cached !== null) return applyPendingClientOperations(path, cached);
    throw error;
  }
}

export const api = {
  devices: () => request<{ devices: Array<{ id: string; name: string; platform: "windows" | "android" | "web"; lastSeenAt: string; lastSyncRevision: number }> }>("/api/devices"),
  removeDevice: (id: string) => request<{ revoked: boolean }>(`/api/devices/${id}`, { method: "DELETE" }),
  syncPull: async () => {
    const result = await request<{ revision: number; events: unknown[] }>(`/api/sync/pull?after=${getSyncRevision()}`);
    setSyncRevision(result.revision);
    return result;
  },
  accounts: () => request<{ accounts: MailAccount[] }>("/api/accounts"),
  providers: () => request<{ providers: MailProvider[] }>("/api/providers"),
  messages: (params: URLSearchParams) => request<{ messages: MailItem[]; total: number }>(`/api/messages?${params}`),
  message: (id: number) => request<{ message: MailDetail }>(`/api/messages/${id}`),
  updateMessage: (id: number, actions: MessageActions) => request<{ ok: true; message: MailDetail }>(`/api/messages/${id}`, { method: "PATCH", body: JSON.stringify(actions) }),
  bulkMessages: (ids: number[], actions: MessageActions) => request<{ ok: true; updated: number; missingIds: number[] }>("/api/messages/bulk", { method: "POST", body: JSON.stringify({ ids, ...actions }) }),
  deleteMessage: (id: number) => request<void>(`/api/messages/${id}`, { method: "DELETE" }),
  syncAll: () => request<{ ok: boolean; succeeded: unknown[]; failed: unknown[] }>("/api/sync", { method: "POST" }),
  syncAccount: (id: number) => request<unknown>(`/api/accounts/${id}/sync`, { method: "POST" }),
  labels: () => request<{ labels: MailLabel[] }>("/api/labels"),
  createLabel: (name: string) => request<{ label: MailLabel }>("/api/labels", { method: "POST", body: JSON.stringify({ name }) }),
  createDraft: (content: DraftContent) => request<{ draft: MailDetail }>("/api/drafts", { method: "POST", body: JSON.stringify(content) }),
  updateDraft: (id: number, content: Omit<DraftContent, "accountId">) => request<{ draft: MailDetail }>(`/api/drafts/${id}`, { method: "PATCH", body: JSON.stringify(content) }),
  send: (content: DraftContent) => request<{ message: MailDetail }>("/api/send", { method: "POST", body: JSON.stringify(content) })
};
