import type { DraftContent, MailAccount, MailDetail, MailItem, MailLabel, MailProvider, MessageActions } from "./data/mailData";

let apiKey = sessionStorage.getItem("mailCollectorApiKey") ?? "";
export const unauthorizedEvent = "mail-collector:unauthorized";

function clearLegacyKey() {
  apiKey = "";
  sessionStorage.removeItem("mailCollectorApiKey");
}

async function request<T>(path: string, options: RequestInit = {}, notifyUnauthorized = true): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body) headers.set("Content-Type", "application/json");
  if (apiKey) headers.set("X-API-Key", apiKey);
  const response = await fetch(path, { ...options, headers, credentials: "same-origin" });
  if (response.status === 401 && notifyUnauthorized) {
    clearLegacyKey();
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
    const headers = new Headers();
    if (apiKey) headers.set("X-API-Key", apiKey);
    const response = await fetch("/api/auth/session", { headers, credentials: "same-origin" });
    if (response.status === 401) {
      clearLegacyKey();
      return false;
    }
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? `请求失败 (${response.status})`);
    }
    return true;
  },
  signIn: async (email: string, password: string) => {
    clearLegacyKey();
    await request<{ user: { email: string } }>("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }, false);
  },
  register: async (email: string, password: string, inviteCode: string) => {
    clearLegacyKey();
    await request<{ user: { email: string } }>("/api/auth/register", { method: "POST", body: JSON.stringify({ email, password, inviteCode }) }, false);
  },
  signInWithKey: async (key: string) => {
    apiKey = key.trim();
    if (!apiKey) throw new Error("请输入访问密钥");
    try {
      await request<{ ok: true }>("/api/health", {}, false);
      sessionStorage.setItem("mailCollectorApiKey", apiKey);
    } catch (error) {
      clearLegacyKey();
      throw error;
    }
  },
  signOut: async () => {
    try {
      await request<void>("/api/auth/logout", { method: "POST" }, false);
    } finally {
      clearLegacyKey();
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
