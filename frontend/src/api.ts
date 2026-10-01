import type { DraftContent, MailAccount, MailDetail, MailItem, MailLabel, MailProvider, MessageActions } from "./data/mailData";
import { timedFetch, isRequestAborted } from "./request-runtime";
import { cacheGeneration, clearClientCache, findCachedMessageById, readCachedResponse, writeCachedResponse } from "./client-cache";
import { clearClientIdentity, clientStorageScope, setClientIdentity } from "./client-identity";
import { deviceHeaders } from "./device-info";
import {
  applyPendingClientOperations,
  clearClientOperations,
  enqueueClientOperation,
  pendingClientOperationCount,
  pendingClientOperations,
  removeClientOperation,
  markClientOperationFailed,
  type PendingClientOperation
} from "./client-outbox";
import { getSyncRevision, resetSyncRevision, setSyncRevision, type SyncEvent } from "./client-sync";
import {
  assertSecureApiUrl,
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
const legacyRememberedKey = "mailCollectorRememberedApiKey:local";

function loadLocalApiKey(): string {
  // Older builds could persist the high-privilege API key in localStorage.
  // Remove that legacy copy and only allow session-scoped key authentication.
  localStorage.removeItem(legacyRememberedKey);
  return sessionStorage.getItem(localApiKeyKey)
    ?? sessionStorage.getItem(legacyApiKey)
    ?? "";
}

let localApiKey = loadLocalApiKey();
export const unauthorizedEvent = "mail-collector:unauthorized";

function clearLocalApiKey(): void {
  localApiKey = "";
  sessionStorage.removeItem(legacyApiKey);
  sessionStorage.removeItem(localApiKeyKey);
  localStorage.removeItem(legacyRememberedKey);
}

async function clearClientData(): Promise<void> {
  clearClientOperations();
  resetSyncRevision();
  await clearClientCache();
}

async function clearAllAuth(): Promise<void> {
  clearClientIdentity();
  clearLocalApiKey();
  clearClientSessionToken();
  clearMobileDeviceToken();
  await clearClientData();
}

async function completeSignIn(identity: string): Promise<void> {
  await clearClientData();
  await setClientIdentity(identity);
}

async function fetchLocal(path: string, options: RequestInit = {}, key = localApiKey): Promise<Response> {
  const url = resolveApiUrl(path);
  assertSecureApiUrl(url);
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

  return timedFetch(url, {
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
  assertSecureApiUrl(resolveApiUrl(path));
  const scope = clientStorageScope();
  const method = (options.method ?? "GET").toUpperCase();
  const generation = cacheGeneration();
  let response: Response;
  try {
    response = await fetchLocal(path, options);
  } catch (error) {
    if (!isRequestAborted(error) && method === "GET" && scope === clientStorageScope()) {
      const cached = await readCachedResponse<T>(path);
      if (cached !== null) return applyPendingClientOperations(path, cached);
    }
    throw error;
  }

  if (response.status === 401 && notifyUnauthorized) {
    await clearAllAuth();
    window.dispatchEvent(new Event(unauthorizedEvent));
  }
  if (!response.ok) throw await responseError(response);
  if (method !== "GET") await clearClientCache();
  if (response.status === 204) return undefined as T;

  const payload = await response.json() as T;
  if (method === "GET" && scope === clientStorageScope()) {
    void writeCachedResponse(path, payload, generation);
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
  const scope = clientStorageScope();
  const operationId = crypto.randomUUID();
  try {
    const response = await fetchLocal(path, operationOptions(operationId, method, body));
    if (response.status === 401) {
      await clearAllAuth();
      window.dispatchEvent(new Event(unauthorizedEvent));
    }
    if (!response.ok) throw await responseError(response);
    await clearClientCache();
    return response.status === 204 ? undefined as T : response.json() as Promise<T>;
  } catch (error) {
    if (!(error instanceof TypeError) || !isNativeClient() || scope !== clientStorageScope() || !getClientSessionToken()) throw error;
    enqueueClientOperation({ id: operationId, method, path, body });
    return offlineResult();
  }
}

async function flushOutbox(signal?: AbortSignal): Promise<{ flushed: number; pending: number }> {
  if (!isNativeClient() || !getClientSessionToken()) return { flushed: 0, pending: pendingClientOperationCount() };
  const scope = clientStorageScope();
  let flushed = 0;
  for (const operation of pendingClientOperations()) {
    if (scope !== clientStorageScope() || signal?.aborted) break;
    if (operation.failure) continue;
    let response: Response;
    try {
      response = await fetchLocal(operation.path, { ...operationOptions(operation.id, operation.method, operation.body), signal });
    } catch {
      break;
    }
    if (scope !== clientStorageScope()) break;
    if (response.ok) {
      const result = response.status === 204 ? null : await response.json().catch(() => null) as { missingIds?: number[] } | null;
      if (result?.missingIds?.length) {
        markClientOperationFailed(operation.id, 404, `批量操作部分失败，未找到邮件：${result.missingIds.join(", ")}。重试前请核对这些邮件。`);
        await clearClientCache();
        continue;
      }
      await clearClientCache();
      removeClientOperation(operation.id);
      flushed += 1;
      continue;
    }
    if ([400, 404, 409, 422].includes(response.status)) {
      const error = await responseError(response);
      markClientOperationFailed(operation.id, response.status, response.status === 409 ? `离线操作冲突：${error.message}。请核对服务器状态后再重试。` : `离线操作失败：${error.message}`);
      continue;
    }
    if (response.status === 401) {
      await clearAllAuth();
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
  status: () => request<{ registered: boolean }>("/api/auth/status", {}, false),
  restore: async () => {
    if (isNativeClient()) {
      const token = getClientSessionToken();
      if (!token) { await clearAllAuth(); return false; }
      // The existing native session token binds both user and server instance.
      assertSecureApiUrl(resolveApiUrl("/api/client-auth/session"));
      await setClientIdentity(token);
      try {
        const response = await fetchLocal("/api/client-auth/session", {}, "");
        if (response.status === 401) {
          await clearAllAuth();
          return false;
        }
        return true;
      } catch {
        return Boolean(getClientSessionToken());
      }
    }

    const response = await fetchLocal("/api/auth/session");
    if (response.status === 401) {
      await clearAllAuth();
      return false;
    }
    if (!response.ok) throw await responseError(response);
    const result = await response.json() as { user: { email: string } };
    // Cookie sessions expose no instance identifier, so never reuse old data on restore.
    await completeSignIn(JSON.stringify([result.user.email, localApiKey]));
    return true;
  },
  signIn: async (email: string, password: string) => {
    await clearAllAuth();
    if (isNativeClient()) {
      const result = await nativeAuthRequest<{ token: string; user: { email: string } }>("/api/client-auth/login", { email, password });
      setClientSessionToken(result.token);
      await completeSignIn(result.token);
      return;
    }
    const result = await request<{ user: { email: string } }>("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }, false);
    await completeSignIn(result.user.email);
  },
  register: async (email: string, password: string, inviteCode: string) => {
    await clearAllAuth();
    if (isNativeClient()) {
      const result = await nativeAuthRequest<{ token: string; user: { email: string } }>("/api/client-auth/register", { email, password, inviteCode });
      setClientSessionToken(result.token);
      await completeSignIn(result.token);
      return;
    }
    const result = await request<{ user: { email: string } }>("/api/auth/register", { method: "POST", body: JSON.stringify({ email, password, inviteCode }) }, false);
    await completeSignIn(result.user.email);
  },
  signInWithKey: async (key: string) => {
    const trimmed = key.trim();
    if (!trimmed) throw new Error("请输入访问密钥");
    await clearAllAuth();
    try {
      const response = await fetchLocal("/api/health", {}, trimmed);
      if (!response.ok) throw new Error("未授权");
      localApiKey = trimmed;
      sessionStorage.setItem(legacyApiKey, trimmed);
      sessionStorage.setItem(localApiKeyKey, trimmed);
      await completeSignIn(trimmed);
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
      await clearAllAuth();
    }
  }
};

export type OAuthMailProvider = "google" | "microsoft";
export type OAuthFlowStatus = { status: "pending" | "authorized" | "success" | "error"; error: string; accountId: number | null };
export type DesktopOAuthCredential = {
  version: 1;
  provider: OAuthMailProvider;
  email: string;
  displayName: string;
  clientId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
};
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
  accounts: (signal?: AbortSignal) => request<{ accounts: MailAccount[] }>("/api/accounts", { signal }),
  providers: () => request<{ providers: MailProvider[] }>("/api/providers"),
  startOAuth: (provider: OAuthMailProvider) => request<{ flowId: string; authorizationUrl: string }>(`/api/oauth/${provider}/start`, { method: "POST" }),
  oauthFlow: (flowId: string) => request<OAuthFlowStatus>(`/api/oauth/flows/${encodeURIComponent(flowId)}`),
  importOAuth: (credential: DesktopOAuthCredential) => request<{ account: MailAccount }>("/api/oauth/import", { method: "POST", body: JSON.stringify(credential) }),
  messages: (params: URLSearchParams, signal?: AbortSignal) => request<{ messages: MailItem[]; total: number }>(`/api/messages?${params}`, { signal }),
  message: (id: number, signal?: AbortSignal) => request<{ message: MailDetail }>(`/api/messages/${id}`, { signal }),
  updateMessage: (id: number, actions: MessageActions) => actions.labels !== undefined
    ? onlineMessageMutation<{ ok: true; message: MailDetail }>(`/api/messages/${id}`, "PATCH", actions)
    : queueableMutation<{ ok: true; message: MailDetail }>(
      `/api/messages/${id}`,
      "PATCH",
      actions,
      async () => {
        const cached = await findCachedMessageById(id);
        if (!cached) throw new Error("操作已离线保存；此邮件尚无本地详情缓存");
        return { ok: true, message: { ...cached, ...actions, labels: cached.labels } };
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
  labels: (signal?: AbortSignal) => request<{ labels: MailLabel[] }>("/api/labels", { signal }),
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
  syncPull: async (signal?: AbortSignal) => {
    const flushed = await flushOutbox(signal);
    const scope = clientStorageScope();
    const after = getSyncRevision();
    const response = await fetchLocal(`/api/sync/pull?after=${after}`, { signal });
    if (!response.ok) throw await responseError(response);
    const result = await response.json() as { revision: number; events: SyncEvent[] };
    if (scope === clientStorageScope()) {
      setSyncRevision(result.revision);
      if (result.events.length) await clearClientCache();
    }
    return { ...result, ...flushed };
  }
};
