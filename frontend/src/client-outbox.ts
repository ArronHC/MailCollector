import { clientStorageScope, hasClientIdentity } from "./client-identity";

const OUTBOX_KEY_PREFIX = "mailCollectorSyncOutbox";

export type PendingClientOperation = {
  id: string;
  method: "PATCH" | "POST" | "DELETE";
  path: string;
  body?: unknown;
  createdAt: string;
  failure?: { status: number; reason: string; failedAt: string };
};

type MessageStatePatch = {
  isRead?: boolean;
  isStarred?: boolean;
  folder?: string;
  snoozedUntil?: string | null;
};

function outboxKey(): string {
  return `${OUTBOX_KEY_PREFIX}:${encodeURIComponent(clientStorageScope())}`;
}

function load(): PendingClientOperation[] {
  if (!hasClientIdentity()) return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(outboxKey()) ?? "[]") as PendingClientOperation[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function save(items: PendingClientOperation[]): void {
  localStorage.setItem(outboxKey(), JSON.stringify(items));
}

export function enqueueClientOperation(operation: Omit<PendingClientOperation, "createdAt"> & { createdAt?: string }): PendingClientOperation {
  const existing = load().find((item) => item.id === operation.id);
  if (existing) return existing;
  const item: PendingClientOperation = { ...operation, createdAt: operation.createdAt ?? new Date().toISOString() };
  if (load().length >= 500) throw new Error("离线操作队列已满（500 条），本次操作未保存；请联网同步后重试");
  save([...load(), item]);
  return item;
}

export const outboxFailureEvent = "mail-collector:outbox-failure";
export function markClientOperationFailed(id: string, status: number, reason: string): void {
  save(load().map((item) => item.id === id ? { ...item, failure: { status, reason, failedAt: new Date().toISOString() } } : item));
  window.dispatchEvent(new CustomEvent(outboxFailureEvent, { detail: { id, reason } }));
}
export function retryFailedClientOperations(): void {
  save(load().map(({ failure: _failure, ...item }) => item));
}
export function pendingClientOperations(): PendingClientOperation[] { return load(); }
export function removeClientOperation(id: string): void { save(load().filter((item) => item.id !== id)); }
export function clearClientOperations(): void {
  for (const key of Object.keys(localStorage)) {
    if (key === OUTBOX_KEY_PREFIX || key.startsWith(`${OUTBOX_KEY_PREFIX}:`)) localStorage.removeItem(key);
  }
}
export function pendingClientOperationCount(): number { return load().length; }

function statePatch(body: unknown): MessageStatePatch {
  if (!body || typeof body !== "object") return {};
  const source = body as Record<string, unknown>;
  return {
    ...(typeof source.isRead === "boolean" ? { isRead: source.isRead } : {}),
    ...(typeof source.isStarred === "boolean" ? { isStarred: source.isStarred } : {}),
    ...(typeof source.folder === "string" ? { folder: source.folder } : {}),
    ...(source.snoozedUntil === null || typeof source.snoozedUntil === "string" ? { snoozedUntil: source.snoozedUntil as string | null } : {})
  };
}

function pendingState(): { patches: Map<number, MessageStatePatch>; deletedIds: Set<number> } {
  const patches = new Map<number, MessageStatePatch>();
  const deletedIds = new Set<number>();
  for (const operation of load()) {
    if (operation.failure) continue;
    const single = operation.path.match(/^\/api\/messages\/(\d+)$/);
    if (single && operation.method === "DELETE") {
      deletedIds.add(Number(single[1]));
      continue;
    }
    if (single && operation.method === "PATCH") {
      const id = Number(single[1]);
      patches.set(id, { ...patches.get(id), ...statePatch(operation.body) });
      continue;
    }
    if (operation.method === "POST" && operation.path === "/api/messages/bulk" && operation.body && typeof operation.body === "object") {
      const body = operation.body as Record<string, unknown>;
      const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is number => typeof id === "number") : [];
      const patch = statePatch(body);
      for (const id of ids) patches.set(id, { ...patches.get(id), ...patch });
    }
  }
  return { patches, deletedIds };
}

function applyPatch<T extends Record<string, unknown>>(message: T, patches: Map<number, MessageStatePatch>): T {
  const id = typeof message.id === "number" ? message.id : 0;
  const patch = patches.get(id);
  return patch ? { ...message, ...patch } : message;
}

export function applyPendingClientOperations<T>(path: string, value: T): T {
  const { patches, deletedIds } = pendingState();
  if ((!patches.size && !deletedIds.size) || !value || typeof value !== "object") return value;
  const result = value as Record<string, unknown>;

  if (Array.isArray(result.messages)) {
    const query = new URLSearchParams(path.split("?")[1] ?? "");
    const view = query.get("view");
    const matches = (message: Record<string, unknown>) => {
      if (deletedIds.has(Number(message.id))) return false;
      const snoozed = typeof message.snoozedUntil === "string" && Date.parse(message.snoozedUntil) > Date.now();
      if (["inbox", "archive", "trash", "spam"].includes(view ?? "") && (message.kind !== "received" || message.folder !== view || (view === "inbox" && snoozed))) return false;
      if (view === "snoozed" && (message.kind !== "received" || !snoozed)) return false;
      if (view === "sent" && message.kind !== "sent") return false;
      if (view === "drafts" && message.kind !== "draft") return false;
      if (query.get("readState") === "unread" && message.isRead) return false;
      if (query.get("readState") === "read" && !message.isRead) return false;
      if (query.has("starred") && Boolean(message.isStarred) !== (query.get("starred") === "true")) return false;
      return true;
    };
    const messages = result.messages.map((message) => message && typeof message === "object" ? applyPatch(message as Record<string, unknown>, patches) : message)
      .filter((message) => message && typeof message === "object" && matches(message as Record<string, unknown>));
    // Adjust the server total for rows removed from this cached page. Uncached
    // pages cannot be reconstructed offline; never invent missing rows.
    const removed = result.messages.length - messages.length;
    return { ...result, messages, total: Math.max(0, Number(result.total ?? result.messages.length) - removed) } as T;
  }

  if (result.message && typeof result.message === "object") {
    const id = Number((result.message as Record<string, unknown>).id);
    if (deletedIds.has(id)) throw new Error("此邮件已在离线操作中永久删除");
    return { ...result, message: applyPatch(result.message as Record<string, unknown>, patches) } as T;
  }
  return value;
}
