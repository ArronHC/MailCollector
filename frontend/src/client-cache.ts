import { getMobileBackendUrl } from "./mobile-backend";

const DATABASE_NAME = "mail-collector-client-cache";
const DATABASE_VERSION = 1;
const STORE_NAME = "responses";

type CacheRecord<T> = {
  key: string;
  value: T;
  savedAt: number;
};

function cacheKey(path: string): string {
  const backend = getMobileBackendUrl() || window.location.origin;
  return `${backend}|${path}`;
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
  if (!("indexedDB" in window)) return null;
  try {
    const database = await openDatabase();
    return await new Promise<T | null>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readonly");
      const request = transaction.objectStore(STORE_NAME).get(cacheKey(path));
      request.onsuccess = () => resolve((request.result as CacheRecord<T> | undefined)?.value ?? null);
      request.onerror = () => reject(request.error ?? new Error("读取本地邮件缓存失败"));
      transaction.oncomplete = () => database.close();
      transaction.onabort = () => database.close();
    });
  } catch {
    return null;
  }
}

export async function writeCachedResponse<T>(path: string, value: T): Promise<void> {
  if (!("indexedDB" in window)) return;
  try {
    const database = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put({ key: cacheKey(path), value, savedAt: Date.now() } satisfies CacheRecord<T>);
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
