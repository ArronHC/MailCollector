import type { DraftContent, MailAccount, MailDetail, MailItem, MailLabel, MailProvider, MessageActions } from "./data/mailData";
import { defaultBackend, normalizeBackendSettings, type BackendSettings } from "./backend-settings";
import { invoke } from "@tauri-apps/api/core";
export type { BackendSettings } from "./backend-settings";

const backendSettingsKey = "mailCollectorBackend";
const legacyApiKey = "mailCollectorApiKey";
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

type StoredDesktopBackend = BackendSettings & { apiKey?: string | null };

function isTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

async function loadDesktopBackend(): Promise<StoredDesktopBackend | null> {
  if (!isTauri()) return null;
  return invoke<StoredDesktopBackend | null>("load_client_backend_settings");
}

async function saveDesktopBackend(settings: BackendSettings, key: string | null): Promise<void> {
  if (!isTauri()) return;
  await invoke("save_client_backend_settings", { settings: { ...settings, apiKey: key } });
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

function loadApiKey(settings = activeBackend): string {
  return sessionStorage.getItem(sessionApiKeyName(settings))
    ?? localStorage.getItem(persistentApiKeyName(settings))
    ?? (settings.mode === "local" ? sessionStorage.getItem(legacyApiKey) : null)
    ?? "";
}

let apiKey = loadApiKey();
rememberedApiKey = Boolean(localStorage.getItem(persistentApiKeyName()));
export const unauthorizedEvent = "mail-collector:unauthorized";

function apiUrl(path: string, settings = activeBackend): string {
  return settings.mode === "remote" ? `${settings.serverUrl}${path}` : path;
}

function clearApiKey() {
  apiKey = "";
  sessionStorage.removeItem(sessionApiKeyName());
  localStorage.removeItem(persistentApiKeyName());
  if (activeBackend.mode === "local") sessionStorage.removeItem(legacyApiKey);
  rememberedApiKey = false;
  if (isTauri()) void saveDesktopBackend(activeBackend, null).catch(() => undefined);
}

function storeApiKey(value: string, remember: boolean, settings = activeBackend): void {
  const trimmed = value.trim();
  sessionStorage.setItem(sessionApiKeyName(settings), trimmed);
  if (remember && !isTauri()) localStorage.setItem(persistentApiKeyName(settings), trimmed);
  else localStorage.removeItem(persistentApiKeyName(settings));
  if (settings === activeBackend) apiKey = trimmed;
  if (settings === activeBackend) rememberedApiKey = remember;
}

async function fetchApi(path: string, options: RequestInit = {}, settings = activeBackend, key = apiKey): Promise<Response> {
  const headers = new Headers(options.headers);
  if (options.body) headers.set("Content-Type", "application/json");
  if (key) headers.set("X-API-Key", key);
  return fetch(apiUrl(path, settings), {
    ...options,
    headers,
    credentials: settings.mode === "local" ? "same-origin" : "omit"
  });
}

async function request<T>(path: string, options: RequestInit = {}, notifyUnauthorized = true): Promise<T> {
  const response = await fetchApi(path, options);
  if (response.status === 401 && notifyUnauthorized) {
    clearApiKey();
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
    apiKey = desktop.apiKey?.trim() || loadApiKey(activeBackend);
    rememberedApiKey = Boolean(desktop.apiKey?.trim());
    if (apiKey) sessionStorage.setItem(sessionApiKeyName(activeBackend), apiKey);
  },
  current: (): BackendSettings => ({ ...activeBackend }),
  apiKey: (): string => apiKey,
  remembered: (): boolean => rememberedApiKey,
  normalize: normalizeBackendSettings,
  async test(settings: BackendSettings, key: string): Promise<{ version?: string }> {
    const normalized = normalizeBackendSettings(settings);
    if (normalized.mode === "remote" && !key.trim()) throw new Error("请输入服务器 API Key");
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 10_000);
    try {
      let response = await fetchApi("/api/health", { signal: controller.signal }, normalized, key.trim());
      if (normalized.mode === "local" && response.status === 401) {
        response = await fetchApi("/api/service", { signal: controller.signal }, normalized, "");
      }
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
  async save(settings: BackendSettings, key: string, remember: boolean): Promise<void> {
    const normalized = normalizeBackendSettings(settings);
    const nextRemembered = remember && Boolean(key.trim());
    if (isTauri()) await saveDesktopBackend(normalized, nextRemembered ? key.trim() : null);
    else localStorage.setItem(backendSettingsKey, JSON.stringify(normalized));
    activeBackend = normalized;
    if (key.trim()) storeApiKey(key, remember, normalized);
    else {
      apiKey = loadApiKey(normalized);
      if (!remember) localStorage.removeItem(persistentApiKeyName(normalized));
    }
    rememberedApiKey = nextRemembered;
  }
};

export const auth = {
  status: () => request<{ registered: boolean }>("/api/auth/status", {}, false),
  restore: async () => {
    const response = await fetchApi("/api/auth/session");
    if (response.status === 401) {
      clearApiKey();
      return false;
    }
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? `请求失败 (${response.status})`);
    }
    return true;
  },
  signIn: async (email: string, password: string) => {
    clearApiKey();
    await request<{ user: { email: string } }>("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }, false);
  },
  register: async (email: string, password: string, inviteCode: string) => {
    clearApiKey();
    await request<{ user: { email: string } }>("/api/auth/register", { method: "POST", body: JSON.stringify({ email, password, inviteCode }) }, false);
  },
  signInWithKey: async (key: string) => {
    const trimmed = key.trim();
    if (!trimmed) throw new Error("请输入访问密钥");
    try {
      const response = await fetchApi("/api/health", {}, activeBackend, trimmed);
      if (!response.ok) throw new Error("未授权");
      storeApiKey(trimmed, false);
    } catch (error) {
      clearApiKey();
      throw error;
    }
  },
  signOut: async () => {
    try {
      await request<void>("/api/auth/logout", { method: "POST" }, false);
    } finally {
      clearApiKey();
    }
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
