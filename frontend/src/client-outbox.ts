const OUTBOX_KEY = "mailCollectorSyncOutbox";

export type PendingClientOperation = {
  id: string;
  method: string;
  path: string;
  body?: unknown;
  createdAt: string;
};

function load(): PendingClientOperation[] {
  try {
    return JSON.parse(localStorage.getItem(OUTBOX_KEY) ?? "[]") as PendingClientOperation[];
  } catch {
    return [];
  }
}

function save(items: PendingClientOperation[]): void {
  localStorage.setItem(OUTBOX_KEY, JSON.stringify(items.slice(-500)));
}

export function enqueueClientOperation(operation: Omit<PendingClientOperation, "id" | "createdAt">): PendingClientOperation {
  const item: PendingClientOperation = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    ...operation
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
