import { clientStorageScope, hasClientIdentity } from "./client-identity";

const DATABASE_NAME = "mail-collector-client-cache";
const DATABASE_VERSION = 1;
const STORE_NAME = "responses";

type CacheRecord<T> = {
  key: string;
  value: T;
  savedAt: number;
};

function cacheKey(path: string): string {
  return `${clientStorageScope()}|${path}`;
}

function cachePrefix(): string {
  return `${clientStorageScope()}|`;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("无法打开本地邮件缓存"));
  });
}

export async function readCachedResponse<T>(path: string): Promise<T | null> {
  if (!("indexedDB" in window) || !hasClientIdentity()) return null;
  const key = cacheKey(path);
  try {
    const database = await openDatabase();
    if (!hasClientIdentity() || key !== cacheKey(path)) { database.close(); return null; }
    return await new Promise<T | null>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readonly");
      const request = transaction.objectStore(STORE_NAME).get(key);
      request.onsuccess = () => resolve(hasClientIdentity() && key === cacheKey(path) ? (request.result as CacheRecord<T> | undefined)?.value ?? null : null);
      request.onerror = () => reject(request.error ?? new Error("读取本地邮件缓存失败"));
      transaction.oncomplete = () => database.close();
      transaction.onabort = () => database.close();
    });
  } catch {
    return null;
  }
}

export async function findCachedMessageById<T extends { id: number }>(id: number): Promise<T | null> {
  if (!("indexedDB" in window) || !hasClientIdentity()) return null;
  const prefix = cachePrefix();
  try {
    const database = await openDatabase();
    if (!hasClientIdentity() || prefix !== cachePrefix()) { database.close(); return null; }
    return await new Promise<T | null>((resolve) => {
      const transaction = database.transaction(STORE_NAME, "readonly");
      const request = transaction.objectStore(STORE_NAME).openCursor();
      let found: T | null = null;
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || found) return;
        const record = cursor.value as CacheRecord<unknown>;
        if (!record.key.startsWith(prefix)) {
          cursor.continue();
          return;
        }
        const value = record.value as { message?: unknown; messages?: unknown[] } | null;
        if (value?.message && typeof value.message === "object" && (value.message as { id?: unknown }).id === id) {
          found = value.message as T;
          return;
        }
        if (Array.isArray(value?.messages)) {
          const match = value.messages.find((item) => item && typeof item === "object" && (item as { id?: unknown }).id === id);
          if (match) {
            found = match as T;
            return;
          }
        }
        cursor.continue();
      };
      transaction.oncomplete = () => {
        database.close();
        resolve(hasClientIdentity() && prefix === cachePrefix() ? found : null);
      };
      transaction.onerror = transaction.onabort = () => {
        database.close();
        resolve(null);
      };
    });
  } catch {
    return null;
  }
}

export async function writeCachedResponse<T>(path: string, value: T): Promise<void> {
  if (!("indexedDB" in window) || !hasClientIdentity()) return;
  const key = cacheKey(path);
  try {
    const database = await openDatabase();
    if (!hasClientIdentity() || key !== cacheKey(path)) { database.close(); return; }
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put({ key, value, savedAt: Date.now() } satisfies CacheRecord<T>);
      transaction.oncomplete = () => {
        database.close();
        resolve();
      };
      transaction.onerror = transaction.onabort = () => {
        database.close();
        reject(transaction.error ?? new Error("写入本地邮件缓存失败"));
      };
    });
  } catch {
    // Cache is best effort. A cache failure must not break the mailbox.
  }
}

export async function clearClientCache(): Promise<void> {
  if (!("indexedDB" in window)) return;
  try {
    const database = await openDatabase();
    await new Promise<void>((resolve) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).clear();
      transaction.oncomplete = transaction.onerror = transaction.onabort = () => {
        database.close();
        resolve();
      };
    });
  } catch {
    // Best effort only.
  }
}
