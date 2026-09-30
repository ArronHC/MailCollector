import { clientStorageScope, hasClientIdentity } from "./client-identity";
import type { MailDetail } from "./data/mailData";

const DATABASE_NAME = "mail-collector-client-cache";
const STORE_NAME = "responses";
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_RECORDS = 500;
const MAX_BYTES = 25 * 1024 * 1024;
let generation = 0;
type CacheRecord<T> = { key: string; value: T; savedAt: number };
const cacheKey = (path: string) => `${clientStorageScope()}|${path}`;
const cacheable = (path: string) => /^\/api\/(messages(?:[/?]|$)|accounts$|labels$|providers$)/.test(path);

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function readCachedResponse<T>(path: string): Promise<T | null> {
  if (!("indexedDB" in window) || !hasClientIdentity() || !cacheable(path)) return null;
  const key = cacheKey(path);
  try {
    const database = await openDatabase();
    return await new Promise<T | null>((resolve) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(key);
      let value: T | null = null;
      request.onsuccess = () => {
        const record = request.result as CacheRecord<T> | undefined;
        if (!record) return;
        if (Date.now() - record.savedAt > TTL_MS) store.delete(key);
        else value = record.value;
      };
      transaction.oncomplete = () => { database.close(); resolve(hasClientIdentity() && key === cacheKey(path) ? value : null); };
      transaction.onerror = transaction.onabort = () => { database.close(); resolve(null); };
    });
  } catch { return null; }
}

export async function findCachedMessageById(id: number): Promise<MailDetail | null> {
  // Only an exact detail record is eligible; list items are not MailDetail.
  const data = await readCachedResponse<{ message: MailDetail }>(`/api/messages/${id}`);
  const mail = data?.message;
  return mail?.id === id && Array.isArray(mail.to) && Array.isArray(mail.cc) && Array.isArray(mail.bcc)
    && "textBody" in mail && "htmlBody" in mail ? mail : null;
}

export async function writeCachedResponse<T>(path: string, value: T, expectedGeneration = generation): Promise<void> {
  if (!("indexedDB" in window) || !hasClientIdentity() || !cacheable(path)) return;
  const key = cacheKey(path);
  try {
    const database = await openDatabase();
    if (key !== cacheKey(path) || expectedGeneration !== generation) { database.close(); return; }
    await new Promise<void>((resolve) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const now = Date.now();
      const record = { key, value, savedAt: now } satisfies CacheRecord<T>;
      if (JSON.stringify(record).length * 2 <= MAX_BYTES) store.put(record);
      const request = store.getAll();
      request.onsuccess = () => {
        const records = (request.result as CacheRecord<unknown>[]).sort((a, b) => b.savedAt - a.savedAt);
        let count = 0;
        let bytes = 0;
        for (const item of records) {
          bytes += JSON.stringify(item).length * 2;
          if (now - item.savedAt > TTL_MS || ++count > MAX_RECORDS || bytes > MAX_BYTES) store.delete(item.key);
        }
      };
      transaction.oncomplete = transaction.onerror = transaction.onabort = () => { database.close(); resolve(); };
    });
  } catch { /* Cache is best effort. */ }
}

export function cacheGeneration(): number { return generation; }
export async function clearClientCache(): Promise<void> {
  generation += 1;
  if (!("indexedDB" in window)) return;
  try {
    const database = await openDatabase();
    await new Promise<void>((resolve) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).clear();
      transaction.oncomplete = transaction.onerror = transaction.onabort = () => { database.close(); resolve(); };
    });
  } catch { /* Best effort. */ }
}
