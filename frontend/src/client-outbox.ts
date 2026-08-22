const OUTBOX_KEY = "mailCollectorSyncOutbox";

export type PendingClientOperation = {
  id: string;
  method: "PATCH" | "POST" | "DELETE";
  path: string;
  body?: unknown;
  createdAt: string;
};

type MessageStatePatch = {
  isRead?: boolean;
  isStarred?: boolean;
  folder?: string;
  snoozedUntil?: string | null;
};

function load(): PendingClientOperation[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(OUTBOX_KEY) ?? "[]") as PendingClientOperation[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function save(items: PendingClientOperation[]): void {
  localStorage.setItem(OUTBOX_KEY, JSON.stringify(items.slice(-500)));
}

export function enqueueClientOperation(
  operation: Omit<PendingClientOperation, "createdAt"> & { createdAt?: string }
): PendingClientOperation {
  const existing = load().find((item) => item.id === operation.id);
  if (existing) return existing;
  const item: PendingClientOperation = {
    ...operation,
    createdAt: operation.createdAt ?? new Date().toISOString()
  };
  save([...load(), item]);
  return item;
}

export function pendingClientOperations(): PendingClientOperation[] {
  return load();
}

export function removeClientOperation(id: string): void {
  save(load().filter((item) => item.id !== id));
}

export function clearClientOperations(): void {
  localStorage.removeItem(OUTBOX_KEY);
}

export function pendingClientOperationCount(): number {
  return load().length;
}

function statePatch(body: unknown): MessageStatePatch {
  if (!body || typeof body !== "object") return {};
  const source = body as Record<string, unknown>;
  return {
    ...(typeof source.isRead === "boolean" ? { isRead: source.isRead } : {}),
    ...(typeof source.isStarred === "boolean" ? { isStarred: source.isStarred } : {}),
    ...(typeof source.folder === "string" ? { folder: source.folder } : {}),
    ...(source.snoozedUntil === null || typeof source.snoozedUntil === "string"
      ? { snoozedUntil: source.snoozedUntil as string | null }
      : {})
  };
}

function pendingState(): { patches: Map<number, MessageStatePatch>; deletedIds: Set<number> } {
  const patches = new Map<number, MessageStatePatch>();
  const deletedIds = new Set<number>();
  for (const operation of load()) {
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
    let messages = result.messages
      .filter((message) => !message || typeof message !== "object" || !deletedIds.has(Number((message as Record<string, unknown>).id)))
      .map((message) => message && typeof message === "object"
        ? applyPatch(message as Record<string, unknown>, patches)
        : message);
    const query = path.includes("?") ? new URLSearchParams(path.slice(path.indexOf("?") + 1)) : null;
    const view = query?.get("view");
    if (view === "inbox" || view === "archive" || view === "trash" || view === "spam") {
      messages = messages.filter((message) => !message || typeof message !== "object" || (message as Record<string, unknown>).folder === view);
    }
    return { ...result, messages } as T;
  }

  if (result.message && typeof result.message === "object") {
    const id = Number((result.message as Record<string, unknown>).id);
    if (deletedIds.has(id)) return value;
    return { ...result, message: applyPatch(result.message as Record<string, unknown>, patches) } as T;
  }

  return value;
}
