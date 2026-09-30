import { clientStorageScope } from "./client-identity";

const REVISION_KEY_PREFIX = "mailCollectorSyncRevision";
const LEGACY_REVISION_KEY = REVISION_KEY_PREFIX;

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

function revisionKey(): string {
  return `${REVISION_KEY_PREFIX}:${encodeURIComponent(clientStorageScope())}`;
}

export function getSyncRevision(): number {
  // Never migrate the legacy global cursor automatically: it may belong to a
  // different VPS. Replaying from revision 0 is safe; skipping revisions is not.
  localStorage.removeItem(LEGACY_REVISION_KEY);
  const revision = Number(localStorage.getItem(revisionKey()) ?? "0");
  return Number.isFinite(revision) && revision >= 0 ? Math.floor(revision) : 0;
}

export function setSyncRevision(revision: number): void {
  if (!Number.isFinite(revision) || revision < 0) return;
  localStorage.setItem(revisionKey(), String(Math.max(Math.floor(revision), getSyncRevision())));
}

export function resetSyncRevision(): void {
  for (const key of Object.keys(localStorage)) {
    if (key === LEGACY_REVISION_KEY || key.startsWith(`${REVISION_KEY_PREFIX}:`)) localStorage.removeItem(key);
  }
}
