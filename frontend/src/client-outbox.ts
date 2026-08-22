const OUTBOX_KEY = "mailCollectorSyncOutbox";

export type PendingClientOperation = {
  id: string;
  method: "PATCH" | "POST";
  path: string;
  body?: unknown;
  createdAt: string;
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
