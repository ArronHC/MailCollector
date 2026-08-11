import { backend, configSyncApi, type AccountConfigTombstone, type PortableAccountConfiguration } from "./api";
import { decryptConfig, encryptConfig } from "./config-crypto";

type PlainConfigBundle = {
  schemaVersion: 1;
  accounts: PortableAccountConfiguration[];
  tombstones: AccountConfigTombstone[];
  updatedAt: string;
};

function pendingTombstonesKey(): string {
  return `mailCollectorPendingConfigTombstones:${backend.current().serverUrl || "unconfigured"}`;
}

function pendingTombstones(): AccountConfigTombstone[] {
  try { return JSON.parse(localStorage.getItem(pendingTombstonesKey()) ?? "[]") as AccountConfigTombstone[]; }
  catch { return []; }
}

function savePendingTombstones(items: AccountConfigTombstone[]): void {
  if (items.length) localStorage.setItem(pendingTombstonesKey(), JSON.stringify(items));
  else localStorage.removeItem(pendingTombstonesKey());
}

function newestById<T extends { syncId: string }>(items: T[], timestamp: (item: T) => string): Map<string, T> {
  const result = new Map<string, T>();
  for (const item of items) {
    const current = result.get(item.syncId);
    if (!current || Date.parse(timestamp(item)) > Date.parse(timestamp(current))) result.set(item.syncId, item);
  }
  return result;
}

function validateBundle(value: PlainConfigBundle): PlainConfigBundle {
  if (value?.schemaVersion !== 1 || !Array.isArray(value.accounts) || !Array.isArray(value.tombstones)) throw new Error("云端配置格式不正确");
  return value;
}

function mergeBundle(cloud: PlainConfigBundle | null, localAccounts: PortableAccountConfiguration[]): PlainConfigBundle {
  const accounts = newestById([...(cloud?.accounts ?? []), ...localAccounts], (account) => account.syncUpdatedAt);
  const tombstones = newestById([...(cloud?.tombstones ?? []), ...pendingTombstones()], (item) => item.deletedAt);
  for (const [syncId, tombstone] of tombstones) {
    const account = accounts.get(syncId);
    if (account && Date.parse(tombstone.deletedAt) >= Date.parse(account.syncUpdatedAt)) accounts.delete(syncId);
  }
  return { schemaVersion: 1, accounts: [...accounts.values()], tombstones: [...tombstones.values()], updatedAt: new Date().toISOString() };
}

function comparable(bundle: PlainConfigBundle): string {
  return JSON.stringify({
    accounts: [...bundle.accounts].sort((left, right) => left.syncId.localeCompare(right.syncId)),
    tombstones: [...bundle.tombstones].sort((left, right) => left.syncId.localeCompare(right.syncId))
  });
}

export function queueAccountConfigDeletion(syncId: string): void {
  const items = newestById([...pendingTombstones(), { syncId, deletedAt: new Date().toISOString() }], (item) => item.deletedAt);
  savePendingTombstones([...items.values()]);
}

export async function syncCloudConfiguration(retry = true): Promise<{ changed: number; revision: number }> {
  if (backend.current().mode !== "remote") return { changed: 0, revision: 0 };
  const key = backend.syncKey();
  if (!key) throw new Error("请输入管理员指定的同步密钥");
  const [{ accounts: localAccounts }, cloudState] = await Promise.all([configSyncApi.exportLocal(), configSyncApi.cloudBundle()]);
  const cloudBundle = cloudState.envelope ? validateBundle(await decryptConfig<PlainConfigBundle>(cloudState.envelope, key)) : null;
  const merged = mergeBundle(cloudBundle, localAccounts);
  const imported = await configSyncApi.importLocal(merged.accounts, merged.tombstones);
  const changed = imported.created + imported.updated + imported.disabled;
  const refreshedLocal = changed ? (await configSyncApi.exportLocal()).accounts : localAccounts;
  const finalBundle = mergeBundle(merged, refreshedLocal);
  if (cloudBundle && comparable(cloudBundle) === comparable(finalBundle) && !pendingTombstones().length) return { changed, revision: cloudState.revision };
  try {
    const envelope = await encryptConfig(finalBundle, key);
    const saved = await configSyncApi.saveCloudBundle(cloudState.revision, envelope);
    savePendingTombstones([]);
    return { changed, revision: saved.revision };
  } catch (error) {
    if (retry && error instanceof Error && (error as Error & { status?: number }).status === 409) return syncCloudConfiguration(false);
    throw error;
  }
}
