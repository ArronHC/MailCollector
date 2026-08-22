const DEVICE_ID_KEY = "mailCollectorDeviceId";
const REVISION_KEY = "mailCollectorSyncRevision";

export type SyncPullResult = {
  revision: number;
  events: Array<{
    revision: number;
    operationId: string;
    kind: string;
    method: string;
    path: string;
    resourceId: string | null;
  }>;
};

function createId(): string {
  return crypto.randomUUID();
}

export function getDeviceId(): string {
  let value = localStorage.getItem(DEVICE_ID_KEY);
  if (!value) {
    value = createId();
    localStorage.setItem(DEVICE_ID_KEY, value);
  }
  return value;
}

export function getSyncRevision(): number {
  return Number(localStorage.getItem(REVISION_KEY) ?? "0");
}

export function setSyncRevision(revision: number): void {
  localStorage.setItem(REVISION_KEY, String(Math.max(revision, getSyncRevision())));
}

export function createDevicePayload(name: string, platform: "windows" | "android" | "web") {
  return {
    id: getDeviceId(),
    name,
    platform
  };
}

export async function pullSync(fetcher: typeof fetch): Promise<SyncPullResult | null> {
  const result = await fetcher(`/api/sync/pull?after=${getSyncRevision()}`);
  if (!result.ok) return null;
  const payload = await result.json() as SyncPullResult;
  setSyncRevision(payload.revision);
  return payload;
}
