import type { DraftContent, MailAccount, MailDetail, MailItem, MailLabel, MailProvider, MessageActions } from "./data/mailData";
import { defaultBackend, normalizeBackendSettings, type BackendSettings } from "./backend-settings";
import { invoke } from "@tauri-apps/api/core";
export type { BackendSettings } from "./backend-settings";

const backendSettingsKey = "mailCollectorBackend";
const legacyApiKey = "mailCollectorApiKey";
const cloudSyncKey = "mailCollectorCloudSyncKey";
function loadBackend(): BackendSettings {
  try {
    const stored = JSON.parse(localStorage.getItem(backendSettingsKey) ?? "null") as BackendSettings | null;
    return stored ? normalizeBackendSettings(stored) : defaultBackend;
  } catch {
    return defaultBackend;
  }
}

let activeBackend = loadBackend();
let rememberedApiKey = false;

type StoredDesktopBackend = BackendSettings & { apiKey?: string | null; syncKey?: string | null };

function isTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

async function loadDesktopBackend(): Promise<StoredDesktopBackend | null> {
  if (!isTauri()) return null;
  return invoke<StoredDesktopBackend | null>("load_client_backend_settings");
}

async function saveDesktopBackend(settings: BackendSettings, key: string | null, syncKey: string | null): Promise<void> {
  if (!isTauri()) return;
  await invoke("save_client_backend_settings", { settings: { ...settings, apiKey: key, syncKey } });
}

function targetId(settings = activeBackend): string {
  return settings.mode === "local" ? "local" : settings.serverUrl;
}

function sessionApiKeyName(settings = activeBackend): string {
  return `mailCollectorApiKey:${targetId(settings)}`;
}

function persistentApiKeyName(settings = activeBackend): string {
  return `mailCollectorRememberedApiKey:${targetId(settings)}`;
}

function loadCloudApiKey(settings = activeBackend): string {
  return sessionStorage.getItem(sessionApiKeyName(settings))
    ?? localStorage.getItem(persistentApiKeyName(settings))
    ?? "";
}

function loadSyncKey(): string {
  return sessionStorage.getItem(cloudSyncKey) ?? localStorage.getItem(cloudSyncKey) ?? "";
}

function loadLocalApiKey(): string {
  return sessionStorage.getItem(sessionApiKeyName(defaultBackend))
    ?? localStorage.getItem(persistentApiKeyName(defaultBackend))
    ?? sessionStorage.getItem(legacyApiKey)
    ?? "";
}

let localApiKey = loadLocalApiKey();
let apiKey = loadCloudApiKey();
let syncKey = loadSyncKey();
rememberedApiKey = Boolean(localStorage.getItem(persistentApiKeyName()));
export const unauthorizedEvent = "mail-collector:unauthorized";

function clearLocalApiKey() {
  localApiKey = "";
  sessionStorage.removeItem(legacyApiKey);
  sessionStorage.removeItem(sessionApiKeyName(defaultBackend));
  localStorage.removeItem(persistentApiKeyName(defaultBackend));
}

function removeStoredCloudCredentials(settings: BackendSettings): void {
  if (settings.mode !== "remote") return;
  sessionStorage.removeItem(sessionApiKeyName(settings));
  localStorage.removeItem(persistentApiKeyName(settings));
}

function storeApiKey(value: string, remember: boolean, settings = activeBackend): void {
  const trimmed = value.trim();
  sessionStorage.setItem(sessionApiKeyName(settings), trimmed);
  if (remember && !isTauri()) localStorage.setItem(persistentApiKeyName(settings), trimmed);
  else localStorage.removeItem(persistentApiKeyName(settings));
  if (settings === activeBackend) apiKey = trimmed;
  if (settings === activeBackend) rememberedApiKey = remember;
}

async function fetchLocal(path: string, options: RequestInit = {}, key = localApiKey): Promise<Response> {
  const headers = new Headers(options.headers);
  if (options.body) headers.set("Content-Type", "application/json");
  if (key) headers.set("X-API-Key", key);
  return fetch(path, {
    ...options,
    headers,
    credentials: "same-origin"
  });
}

async function fetchCloud(path: string, options: RequestInit = {}, settings = activeBackend, key = apiKey): Promise<Response> {
  if (settings.mode !== "remote") throw new Error("云配置同步未启用");
  const headers = new Headers(options.headers);
  if (options.body) headers.set("Content-Type", "application/json");
  if (key) headers.set("X-API-Key", key);
  return fetch(`${settings.serverUrl}${path}`, { ...options, headers, credentials: "omit" });
}

async function request<T>(path: string, options: RequestInit = {}, notifyUnauthorized = true): Promise<T> {
  const response = await fetchLocal(path, options);
  if (response.status === 401 && notifyUnauthorized) {
    clearLocalApiKey();
    window.dispatchEvent(new Event(unauthorizedEvent));
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `请求失败 (${response.status})`);
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

export const backend = {
  async initialize(): Promise<void> {
    const desktop = await loadDesktopBackend();
    if (!desktop) return;
    activeBackend = normalizeBackendSettings(desktop);
    if (activeBackend.mode === "local") {
      localApiKey = desktop.apiKey?.trim() || loadLocalApiKey();
      if (localApiKey) sessionStorage.setItem(legacyApiKey, localApiKey);
      apiKey = "";
      syncKey = "";
      rememberedApiKey = false;
      return;
    }
    apiKey = desktop.apiKey?.trim() || loadCloudApiKey(activeBackend);
    syncKey = desktop.syncKey?.trim() || loadSyncKey();
    rememberedApiKey = Boolean(desktop.apiKey?.trim());
    if (apiKey) sessionStorage.setItem(sessionApiKeyName(activeBackend), apiKey);
    if (syncKey) sessionStorage.setItem(cloudSyncKey, syncKey);
  },
  current: (): BackendSettings => ({ ...activeBackend }),
  apiKey: (): string => apiKey,
  syncKey: (): string => syncKey,
  remembered: (): boolean => rememberedApiKey,
  normalize: normalizeBackendSettings,
  async test(settings: BackendSettings, key: string, encryptionKey = ""): Promise<{ version?: string }> {
    const normalized = normalizeBackendSettings(settings);
    if (normalized.mode === "local") return {};
    if (!key.trim()) throw new Error("请输入服务器 API Key");
    if (!/^[a-fA-F0-9]{64}$/.test(encryptionKey.trim())) throw new Error("同步密钥必须是 64 位十六进制字符");
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetchCloud("/api/health", { signal: controller.signal }, normalized, key.trim());
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `连接失败 (${response.status})`);
      }
      const result = await response.json() as { ok?: boolean; service?: string; version?: string };
      if (!result.ok || result.service !== "mail-collector") throw new Error("目标不是兼容的 Mail Collector 服务");
      return { version: result.version };
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw new Error("连接服务器超时");
      throw error;
    } finally {
      window.clearTimeout(timer);
    }
  },
  async cloudBundle(settings: BackendSettings, key: string): Promise<{ revision: number; envelope: CloudConfigEnvelope | null }> {
    const normalized = normalizeBackendSettings(settings);
    const response = await fetchCloud("/api/config-bundle", {}, normalized, key.trim());
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? `无法读取云配置 (${response.status})`);
    }
    return response.json() as Promise<{ revision: number; envelope: CloudConfigEnvelope | null }>;
  },
  async save(settings: BackendSettings, key: string, encryptionKey: string, remember: boolean): Promise<void> {
    const normalized = normalizeBackendSettings(settings);
    const previous = activeBackend;
    const remote = normalized.mode === "remote";
    const nextRemembered = remote && remember && Boolean(key.trim()) && Boolean(encryptionKey.trim());
    if (isTauri()) await saveDesktopBackend(normalized, remote ? nextRemembered ? key.trim() : null : localApiKey || null, nextRemembered ? encryptionKey.trim() : null);
    else localStorage.setItem(backendSettingsKey, JSON.stringify(normalized));
    if (previous.mode === "remote" && (normalized.mode !== "remote" || previous.serverUrl !== normalized.serverUrl)) removeStoredCloudCredentials(previous);
    activeBackend = normalized;
    apiKey = remote ? key.trim() : "";
    syncKey = remote ? encryptionKey.trim() : "";
    if (remote) {
      storeApiKey(apiKey, remember, normalized);
      sessionStorage.setItem(cloudSyncKey, syncKey);
      if (remember && !isTauri()) localStorage.setItem(cloudSyncKey, syncKey);
      else localStorage.removeItem(cloudSyncKey);
    } else {
      sessionStorage.removeItem(cloudSyncKey);
      localStorage.removeItem(cloudSyncKey);
      apiKey = "";
      removeStoredCloudCredentials(previous);
    }
    rememberedApiKey = nextRemembered;
  }
};

export const auth = {
  status: () => request<{ registered: boolean }>("/api/auth/status", {}, false),
  restore: async () => {
    const response = await fetchLocal("/api/auth/session");
    if (response.status === 401) {
      clearLocalApiKey();
      return false;
    }
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? `请求失败 (${response.status})`);
    }
    return true;
  },
  signIn: async (email: string, password: string) => {
    clearLocalApiKey();
    await request<{ user: { email: string } }>("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }, false);
  },
  register: async (email: string, password: string, inviteCode: string) => {
    clearLocalApiKey();
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
      sessionStorage.setItem(sessionApiKeyName(defaultBackend), trimmed);
    } catch (error) {
      clearLocalApiKey();
      throw error;
    }
  },
  signOut: async () => {
    try {
      await request<void>("/api/auth/logout", { method: "POST" }, false);
    } finally {
      clearLocalApiKey();
    }
  }
};

export type PortableAccountConfiguration = {
  syncId: string;
  name: string;
  email: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  mailbox: string;
  enabled: boolean;
  syncUpdatedAt: string;
};

export type CloudConfigEnvelope = { version: string; iv: string; ciphertext: string };
export type AccountConfigTombstone = { syncId: string; deletedAt: string };

async function cloudRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetchCloud(path, options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string; currentRevision?: number };
    const error = new Error(body.error ?? `云配置请求失败 (${response.status})`) as Error & { status?: number; currentRevision?: number };
    error.status = response.status;
    error.currentRevision = body.currentRevision;
    throw error;
  }
  return response.json() as Promise<T>;
}

export const configSyncApi = {
  cloudBundle: () => cloudRequest<{ revision: number; envelope: CloudConfigEnvelope | null }>("/api/config-bundle"),
  saveCloudBundle: (baseRevision: number, envelope: CloudConfigEnvelope) => cloudRequest<{ revision: number }>("/api/config-bundle", { method: "PUT", body: JSON.stringify({ baseRevision, envelope }) }),
  exportLocal: () => request<{ accounts: PortableAccountConfiguration[] }>("/api/config-local/export"),
  importLocal: (accounts: PortableAccountConfiguration[], tombstones: AccountConfigTombstone[]) => request<{ created: number; updated: number; unchanged: number; stale: number; disabled: number; queued: number }>("/api/config-local/import", { method: "POST", body: JSON.stringify({ accounts, tombstones }) })
};

export const api = {
  accounts: () => request<{ accounts: MailAccount[] }>("/api/accounts"),
  providers: () => request<{ providers: MailProvider[] }>("/api/providers"),
  messages: (params: URLSearchParams) => request<{ messages: MailItem[]; total: number }>(`/api/messages?${params}`),
  message: (id: number) => request<{ message: MailDetail }>(`/api/messages/${id}`),
  updateMessage: (id: number, actions: MessageActions) => request<{ ok: true; message: MailDetail }>(`/api/messages/${id}`, { method: "PATCH", body: JSON.stringify(actions) }),
  bulkMessages: (ids: number[], actions: MessageActions) => request<{ ok: true; updated: number; missingIds: number[] }>("/api/messages/bulk", { method: "POST", body: JSON.stringify({ ids, ...actions }) }),
  deleteMessage: (id: number) => request<void>(`/api/messages/${id}`, { method: "DELETE" }),
  setRead: (id: number, isRead: boolean) => request<{ ok: true; message: MailDetail }>(`/api/messages/${id}`, { method: "PATCH", body: JSON.stringify({ isRead }) }),
  setStarred: (id: number, isStarred: boolean) => request<{ ok: true; message: MailDetail }>(`/api/messages/${id}`, { method: "PATCH", body: JSON.stringify({ isStarred }) }),
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
  sendDraft: (id: number) => request<{ message: MailDetail }>(`/api/drafts/${id}/send`, { method: "POST" })
};
