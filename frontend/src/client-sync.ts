const REVISION_KEY = "mailCollectorSyncRevision";

export type SyncEvent = {
  revision: number;
  operationId: string;
  deviceId: string;
  kind: string;
  method: string;
  path: string;
  resourceId: string | null;
  createdAt: string;
};

export type SyncPullResult = {
  revision: number;
  events: SyncEvent[];
};

export function getSyncRevision(): number {
  const revision = Number(localStorage.getItem(REVISION_KEY) ?? "0");
  return Number.isFinite(revision) && revision >= 0 ? Math.floor(revision) : 0;
}

export function setSyncRevision(revision: number): void {
  if (!Number.isFinite(revision) || revision < 0) return;
  localStorage.setItem(REVISION_KEY, String(Math.max(Math.floor(revision), getSyncRevision())));
}

export function resetSyncRevision(): void {
  localStorage.removeItem(REVISION_KEY);
}
