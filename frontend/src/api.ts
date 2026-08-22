import type { DraftContent, MailAccount, MailDetail, MailItem, MailLabel, MailProvider, MessageActions } from "./data/mailData";
import { readCachedResponse, writeCachedResponse } from "./client-cache";
import { deviceHeaders } from "./device-info";
import { applyPendingClientOperations } from "./client-outbox";
import { getSyncRevision, setSyncRevision } from "./client-sync";
import { clearClientSessionToken, clearMobileDeviceToken, getClientSessionToken, getMobileDeviceToken, isNativeClient, resolveApiUrl, setClientSessionToken } from "./mobile-backend";

const legacyApiKey = "mailCollectorApiKey";
const localApiKeyKey = "mailCollectorApiKey:local";
const localRememberedKey = "mailCollectorRememberedApiKey:local";

function loadLocalApiKey(): string { return sessionStorage.getItem(localApiKeyKey) ?? localStorage.getItem(localRememberedKey) ?? sessionStorage.getItem(legacyApiKey) ?? ""; }
let localApiKey = loadLocalApiKey();
export const unauthorizedEvent = "mail-collector:unauthorized";

function clearLocalApiKey() {
  localApiKey = "";
  sessionStorage.removeItem(legacyApiKey);
  sessionStorage.removeItem(localApiKeyKey);
  localStorage.removeItem(localRememberedKey);
}
function clearAllAuth() { clearLocalApiKey(); clearClientSessionToken(); clearMobileDeviceToken(); }

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
      window.dispatchEvent(new Event(authorizedEvent));
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

async function nativeAuthRequest<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetchLocal(path, { method: body ? "POST" : "GET", body: body ? JSON.stringify(body) : undefined }, "");
  if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? "认证失败");
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

export const auth = {
  status: () => request<{ registered: boolean }>("/api/auth/status", {}, false),
  restore: async () => {
    if (!isNativeClient() || !getClientSessionToken()) return false;
    try { await nativeAuthRequest("/api/client-auth/session"); return true; } catch { return true; }
  },
  signIn: async (email: string, password: string) => {
    clearAllAuth();
    if (isNativeClient()) { const result = await nativeAuthRequest<{ token: string }>("/api/client-auth/login", { email, password }); setClientSessionToken(result.token); return; }
    await request("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }, false);
  },
  register: async (email: string, password: string, inviteCode: string) => {
    clearAllAuth();
    if (isNativeClient()) { const result = await nativeAuthRequest<{ token: string }>("/api/client-auth/register", { email, password, inviteCode }); setClientSessionToken(result.token); return; }
    await request("/api/auth/register", { method: "POST", body: JSON.stringify({ email, password, inviteCode }) }, false);
  },
  signInWithKey: async (key: string) => { localApiKey = key.trim(); sessionStorage.setItem(localApiKeyKey, localApiKey); },
  signOut: async () => { try { await nativeAuthRequest("/api/client-auth/logout", {}); } finally { clearAllAuth(); } }
};

export const api = {
  devices: () => request<{ devices: Array<{ id:string; name:string; platform:"windows"|"android"|"web"; lastSeenAt:string; lastSyncRevision:number }> }>("/api/devices"),
  removeDevice: (id:string) => request<{revoked:boolean}>(`/api/devices/${id}`, {method:"DELETE"}),
  syncPull: async () => { const result = await request<{revision:number;events:unknown[]}>(`/api/sync/pull?after=${getSyncRevision()}`); setSyncRevision(result.revision); return result; },
  accounts: () => request<{accounts:MailAccount[]}>("/api/accounts"),
  providers: () => request<{providers:MailProvider[]}>("/api/providers"),
  messages: (params:URLSearchParams) => request<{messages:MailItem[];total:number}>(`/api/messages?${params}`),
  message: (id:number) => request<{message:MailDetail}>(`/api/messages/${id}`),
  updateMessage: (id:number, actions:MessageActions) => request<{ok:true;message:MailDetail}>(`/api/messages/${id}`, {method:"PATCH",body:JSON.stringify(actions)}),
  bulkMessages: (ids:number[], actions:MessageActions) => request<{ok:true;updated:number;missingIds:number[]}>("/api/messages/bulk", {method:"POST",body:JSON.stringify({ids,...actions})}),
  deleteMessage: (id:number) => request<void>(`/api/messages/${id}`, {method:"DELETE"}),
  syncAll: () => request("/api/sync", {method:"POST"}),
  syncAccount: (id:number) => request(`/api/accounts/${id}/sync`, {method:"POST"}),
  labels: () => request<{labels:MailLabel[]}>("/api/labels"),
  createLabel: (name:string) => request<{label:MailLabel}>("/api/labels", {method:"POST",body:JSON.stringify({name})}),
  deleteLabel: (id:number) => request<void>(`/api/labels/${id}`, {method:"DELETE"}),
  createDraft: (content:DraftContent) => request<{draft:MailDetail}>("/api/drafts", {method:"POST",body:JSON.stringify(content)}),
  updateDraft: (id:number, content:DraftContent) => request<{draft:MailDetail}>(`/api/drafts/${id}`, {method:"PATCH",body:JSON.stringify(content)}),
  send: (content:DraftContent) => request<{message:MailDetail}>("/api/send", {method:"POST",body:JSON.stringify(content)})
};
