import type { DraftContent, MailAccount, MailDetail, MailItem, MailLabel, MailProvider, MessageActions } from "./data/mailData";

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

function clearLocalApiKey() {
  localApiKey = "";
  sessionStorage.removeItem(legacyApiKey);
  sessionStorage.removeItem(localApiKeyKey);
  localStorage.removeItem(localRememberedKey);
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
      sessionStorage.setItem(localApiKeyKey, trimmed);
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

export type OAuthMailProvider = "google" | "microsoft";
export type OAuthFlowStatus = { status: "pending" | "authorized" | "success" | "error"; error: string; accountId: number | null };

export type AccountSyncStatus = {
  enabled: boolean;
  relayUrl: string;
  hasRelayToken: boolean;
  hasSyncKey: boolean;
  recoveryKey: string;
  configured: boolean;
  lastCursor: number;
  lastSyncAt: string | null;
  lastError: string | null;
  syncing: boolean;
};

export type AccountSyncResult = {
  pulled: number;
  pushed: number;
  deleted: number;
  conflicts: number;
  cursor: number;
};

export const api = {
  accounts: () => request<{ accounts: MailAccount[] }>("/api/accounts"),
  providers: () => request<{ providers: MailProvider[] }>("/api/providers"),
  startOAuth: (provider: OAuthMailProvider) => request<{ flowId: string; authorizationUrl: string }>(`/api/oauth/${provider}/start`, { method: "POST" }),
  oauthFlow: (flowId: string) => request<OAuthFlowStatus>(`/api/oauth/flows/${encodeURIComponent(flowId)}`),
  accountSyncStatus: () => request<AccountSyncStatus>("/api/account-sync/status"),
  ensureAccountSyncRecoveryKey: () => request<{ recoveryKey: string; status: AccountSyncStatus }>("/api/account-sync/recovery-key", { method: "POST" }),
  configureAccountSync: (body: { enabled: boolean; relayUrl?: string; relayToken?: string; syncKey?: string }) => request<AccountSyncStatus>("/api/account-sync/config", { method: "PUT", body: JSON.stringify(body) }),
  syncAccounts: () => request<AccountSyncResult>("/api/account-sync/sync", { method: "POST" }),
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
