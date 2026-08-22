import type { DraftContent, MailAccount, MailDetail, MailItem, MailLabel, MailProvider, MessageActions } from "./data/mailData";
import { findCachedMessageById, readCachedResponse, writeCachedResponse } from "./client-cache";
import { deviceHeaders } from "./device-info";
import {
  applyPendingClientOperations,
  enqueueClientOperation,
  pendingClientOperationCount,
  pendingClientOperations,
  removeClientOperation,
  type PendingClientOperation
} from "./client-outbox";
import { getSyncRevision, setSyncRevision, type SyncEvent } from "./client-sync";
import {
  clearClientSessionToken,
  clearMobileDeviceToken,
  getClientSessionToken,
  getMobileDeviceToken,
  isNativeClient,
  resolveApiUrl,
  setClientSessionToken
} from "./mobile-backend";

const legacyApiKey = "mailCollectorApiKey";
const localApiKeyKey = "mailCollectorApiKey:local";
const localRememberedKey = "mailCollectorRememberedApiKey:local";

function loadLocalApiKey(): string {
  return sessionStorage.getItem(localApiKeyKey)
    ?? localStorage.getItem(localRememberedKey)
    ?? sessionStorage.getItem(legacyApiKey)
    ?? "";
}

let localApiKey = loadLocalApiKey();
export const unauthorizedEvent = "mail-collector:unauthorized";

function clearLocalApiKey(): void {
  localApiKey = "";
  sessionStorage.removeItem(legacyApiKey);
  sessionStorage.removeItem(localApiKeyKey);
  localStorage.removeItem(localRememberedKey);
}

function clearAllAuth(): void {
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

  return fetch(resolveApiUrl(path), {
    ...options,
    headers,
    credentials: isNativeClient() ? "omit" : "include"
  });
}

async function responseError(response: Response): Promise<Error> {
  const body = await response.json().catch(() => ({})) as { error?: string };
  return new Error(body.error ?? `请求失败 (${response.status})`);
}

async function request<T>(path: string, options: RequestInit = {}, notifyUnauthorized = true): Promise<T> {
  const method = (options.method ?? "GET").toUpperCase();
  let response: Response;
  try {
    response = await fetchLocal(path, options);
  } catch (error) {
    if (method === "GET") {
      const cached = await readCachedResponse<T>(path);
      if (cached !== null) return applyPendingClientOperations(path, cached);
    }
    throw error;
  }

  if (response.status === 401 && notifyUnauthorized) {
    clearAllAuth();
    window.dispatchEvent(new Event(unauthorizedEvent));
  }
  if (!response.ok) throw await responseError(response);
  if (response.status === 204) return undefined as T;

  const payload = await response.json() as T;
  if (method === "GET") {
    void writeCachedResponse(path, payload);
    return applyPendingClientOperations(path, payload);
  }
  return payload;
}

async function nativeAuthRequest<T>(path: string, body?: Record<string, unknown>): Promise<T> {
  const response = await fetchLocal(path, {
    method: body ? "POST" : "GET",
    body: body ? JSON.stringify(body) : undefined
  }, "");
  if (!response.ok) throw await responseError(response);
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

function operationOptions(operationId: string, method: PendingClientOperation["method"], body?: unknown): RequestInit {
  return {
    method,
    headers: { "X-Operation-ID": operationId },
    body: body === undefined ? undefined : JSON.stringify(body)
  };
}

async function queueableMutation<T>(
  path: string,
  method: PendingClientOperation["method"],
  body: unknown,
  offlineResult: () => Promise<T>
): Promise<T> {
  const operationId = crypto.randomUUID();
  try {
    const response = await fetchLocal(path, operationOptions(operationId, method, body));
    if (response.status === 401) {
      clearAllAuth();
      window.dispatchEvent(new Event(unauthorizedEvent));
    }
    if (!response.ok) throw await responseError(response);
    return response.status === 204 ? undefined as T : response.json() as Promise<T>;
  } catch (error) {
    if (!(error instanceof TypeError) || !isNativeClient()) throw error;
    enqueueClientOperation({ id: operationId, method, path, body });
    return offlineResult();
  }
}

async function flushOutbox(): Promise<{ flushed: number; pending: number }> {
  if (!isNativeClient() || !getClientSessionToken()) return { flushed: 0, pending: pendingClientOperationCount() };
  let flushed = 0;
  for (const operation of pendingClientOperations()) {
    let response: Response;
    try {
      response = await fetchLocal(operation.path, operationOptions(operation.id, operation.method, operation.body));
    } catch {
      break;
    }
    if (response.ok || response.status === 400 || response.status === 404 || response.status === 409 || response.status === 422) {
      removeClientOperation(operation.id);
      flushed += 1;
      continue;
    }
    if (response.status === 401) {
      clearAllAuth();
      window.dispatchEvent(new Event(unauthorizedEvent));
    }
    break;
  }
  return { flushed, pending: pendingClientOperationCount() };
}

function onlineMessageMutation<T>(path: string, method: "PATCH" | "POST", body: unknown): Promise<T> {
  return request<T>(path, { method, body: JSON.stringify(body) });
}

export const auth = {
  status: async () => {
    try {
      return await request<{ registered: boolean }>("/api/auth/status", {}, false);
    } catch (error) {
      if (isNativeClient() && getClientSessionToken()) return { registered: true };
      throw error;
    }
  },
  restore: async () => {
    if (isNativeClient()) {
      if (!getClientSessionToken()) return false;
      try {
        const response = await fetchLocal("/api/client-auth/session", {}, "");
        if (response.status === 401) {
          clearClientSessionToken();
          return false;
        }
        if (!response.ok) return true;
        return true;
      } catch {
        return Boolean(getClientSessionToken());
      }
    }

    const response = await fetchLocal("/api/auth/session");
    if (response.status === 401) {
      clearLocalApiKey();
      return false;
    }
    if (!response.ok) throw await responseError(response);
    return true;
  },
  signIn: async (email: string, password: string) => {
    clearAllAuth();
    if (isNativeClient()) {
      const result = await nativeAuthRequest<{ token: string; user: { email: string } }>("/api/client-auth/login", { email, password });
      setClientSessionToken(result.token);
      return;
    }
    await request<{ user: { email: string } }>("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }, false);
  },
  register: async (email: string, password: string, inviteCode: string) => {
    clearAllAuth();
    if (isNativeClient()) {
      const result = await nativeAuthRequest<{ token: string; user: { email: string } }>("/api/client-auth/register", { email, password, inviteCode });
      setClientSessionToken(result.token);
      return;
    }
    await request<{ user: { email: string } }>("/api/auth/register", { method: "POST", body: JSON.stringify({ email, password, inviteCode }) }, false);
  },
  signInWithKey: async (key: string) => {
    const trimmed = key.trim();
    if (!trimmed) throw new Error("请输入访问密钥");
    try {
      const response = await fetchLocal("/api/health", {}, trimmed);
      if (!response.ok) throw new Error("未授权");
      localApiKey = trimmed;
      sessionStorage.setItem(legacyApiKey, trimmed);
      sessionStorage.setItem(localApiKeyKey, trimmed);
    } catch (error) {
      clearLocalApiKey();
      throw error;
    }
  },
  signOut: async () => {
    try {
      if (isNativeClient() && getClientSessionToken()) {
        await nativeAuthRequest<void>("/api/client-auth/logout", {});
      } else {
        await request<void>("/api/auth/logout", { method: "POST" }, false);
      }
    } finally {
      clearAllAuth();
    }
  }
};

export type OAuthMailProvider = "google" | "microsoft";
export type OAuthFlowStatus = { status: "pending" | "authorized" | "success" | "error"; error: string; accountId: number | null };
export type ClientDevice = {
  id: string;
  name: string;
  platform: "windows" | "android" | "web";
  lastSeenAt: string;
  lastSyncRevision: number;
  createdAt?: string;
  revokedAt?: string | null;
};

export const api = {
  accounts: () => request<{ accounts: MailAccount[] }>("/api/accounts"),
  providers: () => request<{ providers: MailProvider[] }>("/api/providers"),
  startOAuth: (provider: OAuthMailProvider) => request<{ flowId: string; authorizationUrl: string }>(`/api/oauth/${provider}/start`, { method: "POST" }),
  oauthFlow: (flowId: string) => request<OAuthFlowStatus>(`/api/oauth/flows/${encodeURIComponent(flowId)}`),
  messages: (params: URLSearchParams) => request<{ messages: MailItem[]; total: number }>(`/api/messages?${params}`),
  message: (id: number) => request<{ message: MailDetail }>(`/api/messages/${id}`),
  updateMessage: (id: number, actions: MessageActions) => actions.labels !== undefined
    ? onlineMessageMutation<{ ok: true; message: MailDetail }>(`/api/messages/${id}`, "PATCH", actions)
    : queueableMutation<{ ok: true; message: MailDetail }>(
      `/api/messages/${id}`,
      "PATCH",
      actions,
      async () => {
        const cached = await findCachedMessageById<MailDetail>(id);
        if (!cached) throw new Error("操作已离线保存；此邮件尚无本地详情缓存");
        return { ok: true, message: { ...cached, ...actions } as MailDetail };
      }
    ),
  bulkMessages: (ids: number[], actions: MessageActions) => actions.labels !== undefined
    ? onlineMessageMutation<{ ok: true; updated: number; missingIds: number[] }>("/api/messages/bulk", "POST", { ids, ...actions })
    : queueableMutation<{ ok: true; updated: number; missingIds: number[] }>(
      "/api/messages/bulk",
      "POST",
      { ids, ...actions },
      async () => ({ ok: true, updated: ids.length, missingIds: [] })
    ),
  deleteMessage: (id: number) => queueableMutation<void>(`/api/messages/${id}`, "DELETE", undefined, async () => undefined),
  syncAll: () => request<{ ok: boolean; succeeded: unknown[]; failed: unknown[] }>("/api/sync", { method: "POST" }),
  syncAccount: (id: number) => request<unknown>(`/api/accounts/${id}/sync`, { method: "POST" }),
  classify: (accountId?: number) => request<{ ok: true; classified: number; changed: number; unchanged: number; unclassified: number; byLabel: Record<string, number> }>("/api/classify", { method: "POST", body: JSON.stringify(accountId ? { accountId } : {}) }),
  addAccount: (body: Record<string, unknown>) => request<{ account: MailAccount }>("/api/accounts", { method: "POST", body: JSON.stringify(body) }),
  setAccountEnabled: (id: number, enabled: boolean) => request<{ ok: true }>(`/api/accounts/${id}`, { method: "PATCH", body: JSON.stringify({ enabled }) }),
  deleteAccount: (id: number) => request<void>(`/api/accounts/${id}`, { method: "DELETE" }),
  labels: () => request<{ labels: MailLabel[] }>("/api/labels"),
  createLabel: (name: string) => request<{ label: MailLabel }>("/api/labels", { method: "POST", body: JSON.stringify({ name }) }),
  deleteLabel: (id: number) => request<void>(`/api/labels/${id}`, { method: "DELETE" }),
  createDraft: (content: DraftContent) => request<{ draft: MailDetail }>("/api/drafts", { method: "POST", body: JSON.stringify(content) }),
  updateDraft: (id: number, content: Omit<DraftContent, "accountId">) => request<{ draft: MailDetail }>(`/api/drafts/${id}`, { method: "PATCH", body: JSON.stringify(content) }),
  send: (content: DraftContent) => request<{ message: MailDetail }>("/api/send", { method: "POST", body: JSON.stringify(content) }),
  sendDraft: (id: number) => request<{ message: MailDetail }>(`/api/drafts/${id}/send`, { method: "POST" }),
  devices: () => request<{ devices: ClientDevice[] }>("/api/devices"),
  renameDevice: (id: string, name: string) => request<{ device: ClientDevice }>(`/api/devices/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  removeDevice: (id: string) => request<{ revoked: boolean }>(`/api/devices/${id}`, { method: "DELETE" }),
  flushOutbox,
  syncPull: async () => {
    const flushed = await flushOutbox();
    const after = getSyncRevision();
    const response = await fetchLocal(`/api/sync/pull?after=${after}`);
    if (!response.ok) throw await responseError(response);
    const result = await response.json() as { revision: number; events: SyncEvent[] };
    setSyncRevision(result.revision);
    return { ...result, ...flushed };
  }
};