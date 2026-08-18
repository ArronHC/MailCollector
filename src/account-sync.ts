import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import { decryptSecret, encryptSecret } from "./crypto.js";
import type { MailProviderKind } from "./types.js";

const syncKeyPrefix = "mcsk1_";
const relayPageSize = 500;
const oauthSecretVersion = 1;

type OAuthProvider = "google" | "microsoft";

type LocalAccount = {
  id: number;
  syncId: string;
  syncUpdatedAt: string;
  name: string;
  email: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  encryptedPassword: string;
  mailbox: string;
  provider: MailProviderKind;
  enabled: boolean;
};

type LocalState = {
  syncId: string;
  remoteRevision: number;
  payloadHash: string | null;
  deleted: boolean;
};

export type AccountSyncAuth =
  | { type: "password"; secret: string }
  | {
      type: "oauth";
      provider: OAuthProvider;
      email: string;
      displayName: string;
      refreshToken: string;
      scope: string;
    };

export type AccountSyncPayload = {
  version: 1;
  syncId: string;
  updatedAt: string;
  name: string;
  email: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  mailbox: string;
  provider: MailProviderKind;
  enabled: boolean;
  auth: AccountSyncAuth;
};

export type AccountSyncRelayChange = {
  revision: number;
  syncId: string;
  ciphertext: string | null;
  deleted: boolean;
  updatedAt: string;
};

type RelayPutResult =
  | { ok: true; record: AccountSyncRelayChange }
  | { ok: false; current: AccountSyncRelayChange | null };

type StoredSyncConfig = {
  version: 1;
  enabled: boolean;
  relayUrl: string;
  relayToken: string;
  syncKey: string;
  lastCursor: number;
  lastSyncAt: string | null;
  lastError: string | null;
};

export type AccountSyncStatus = {
  enabled: boolean;
  relayUrl: string;
  hasRelayToken: boolean;
  hasSyncKey: boolean;
  recoveryKey: string;
  configured: boolean;
  lastCursor: number;
  lastSyncAt: string | null;
  lastError: string | null;
  syncing: boolean;
};

export type AccountSyncResult = {
  pulled: number;
  pushed: number;
  deleted: number;
  conflicts: number;
  cursor: number;
};

type OAuthStoredCredential = {
  version: 1;
  provider: OAuthProvider;
  email: string;
  displayName: string;
  clientId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
};

const accountSyncPayloadSchema = z.object({
  version: z.literal(1),
  syncId: z.string().uuid(),
  updatedAt: z.string().datetime({ offset: true }),
  name: z.string().min(1).max(80),
  email: z.string().email().max(320),
  host: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean(),
  username: z.string().min(1).max(320),
  mailbox: z.string().min(1).max(255),
  provider: z.enum(["gmail", "microsoft", "imap"]),
  enabled: z.boolean(),
  auth: z.discriminatedUnion("type", [
    z.object({ type: z.literal("password"), secret: z.string().min(1).max(4000) }),
    z.object({
      type: z.literal("oauth"),
      provider: z.enum(["google", "microsoft"]),
      email: z.string().email().max(320),
      displayName: z.string().max(320),
      refreshToken: z.string().min(1).max(8000),
      scope: z.string().max(8000)
    })
  ])
});

function parseSyncKey(value: string): Buffer {
  const trimmed = value.trim();
  if (!trimmed.startsWith(syncKeyPrefix)) throw new Error("同步密钥格式不正确");
  const raw = Buffer.from(trimmed.slice(syncKeyPrefix.length), "base64url");
  if (raw.length !== 32) throw new Error("同步密钥必须包含 256 位密钥材料");
  return raw;
}

export function generateAccountSyncKey(): string {
  return `${syncKeyPrefix}${crypto.randomBytes(32).toString("base64url")}`;
}

export function encryptAccountSyncPayload(payload: AccountSyncPayload, syncKey: string): string {
  return encryptSecret(JSON.stringify(accountSyncPayloadSchema.parse(payload)), parseSyncKey(syncKey));
}

export function decryptAccountSyncPayload(ciphertext: string, syncKey: string): AccountSyncPayload {
  const plaintext = decryptSecret(ciphertext, parseSyncKey(syncKey));
  return accountSyncPayloadSchema.parse(JSON.parse(plaintext)) as AccountSyncPayload;
}

export function accountSyncPayloadHash(payload: AccountSyncPayload): string {
  return crypto.createHash("sha256").update(JSON.stringify(accountSyncPayloadSchema.parse(payload))).digest("hex");
}

function normalizeRelayUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("同步服务器 URL 无效");
  }
  if (!["https:", "http:"].includes(url.protocol)) throw new Error("同步服务器仅支持 HTTP 或 HTTPS");
  if (url.username || url.password || url.search || url.hash) throw new Error("同步服务器 URL 不能包含凭据、查询参数或片段");
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname.toLowerCase());
  if (url.protocol !== "https:" && !loopback) throw new Error("远程同步服务器必须使用 HTTPS");
  return url.toString().replace(/\/$/, "");
}

function safeIso(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return new Date().toISOString();
  return new Date(timestamp).toISOString();
}

class AccountSyncConfigStore {
  private readonly filePath: string;

  constructor(databasePath: string, private readonly encryptionKey: Buffer) {
    this.filePath = `${databasePath}.account-sync.json`;
  }

  read(): StoredSyncConfig {
    if (!fs.existsSync(this.filePath)) return this.defaults();
    try {
      const wrapper = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as { version?: number; encrypted?: string };
      if (wrapper.version !== 1 || !wrapper.encrypted) throw new Error("invalid config wrapper");
      const parsed = JSON.parse(decryptSecret(wrapper.encrypted, this.encryptionKey)) as StoredSyncConfig;
      if (parsed.version !== 1) throw new Error("unsupported config version");
      return {
        ...this.defaults(),
        ...parsed,
        relayUrl: parsed.relayUrl ? normalizeRelayUrl(parsed.relayUrl) : "",
        lastCursor: Math.max(0, Math.trunc(parsed.lastCursor || 0))
      };
    } catch {
      throw new Error("账户同步配置无法读取，请检查本地数据目录");
    }
  }

  write(config: StoredSyncConfig): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const encrypted = encryptSecret(JSON.stringify(config), this.encryptionKey);
    fs.writeFileSync(this.filePath, `${JSON.stringify({ version: 1, encrypted }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  private defaults(): StoredSyncConfig {
    return {
      version: 1,
      enabled: false,
      relayUrl: "",
      relayToken: "",
      syncKey: "",
      lastCursor: 0,
      lastSyncAt: null,
      lastError: null
    };
  }
}

export class AccountSyncRepository {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  listAccounts(): LocalAccount[] {
    return (this.db.prepare(`
      SELECT id, sync_id AS syncId, sync_updated_at AS syncUpdatedAt, name, email, host, port,
        secure, username, encrypted_password AS encryptedPassword, mailbox, provider, enabled
      FROM accounts ORDER BY id
    `).all() as Array<Omit<LocalAccount, "secure" | "enabled"> & { secure: number; enabled: number }>).map((row) => ({
      ...row,
      secure: Boolean(row.secure),
      enabled: Boolean(row.enabled)
    }));
  }

  getAccount(syncId: string): LocalAccount | null {
    const row = this.db.prepare(`
      SELECT id, sync_id AS syncId, sync_updated_at AS syncUpdatedAt, name, email, host, port,
        secure, username, encrypted_password AS encryptedPassword, mailbox, provider, enabled
      FROM accounts WHERE sync_id = ?
    `).get(syncId) as (Omit<LocalAccount, "secure" | "enabled"> & { secure: number; enabled: number }) | undefined;
    return row ? { ...row, secure: Boolean(row.secure), enabled: Boolean(row.enabled) } : null;
  }

  upsertAccount(payload: AccountSyncPayload, encryptedPassword: string): { id: number; created: boolean } {
    const existing = this.db.prepare("SELECT id FROM accounts WHERE sync_id = ?").get(payload.syncId) as { id: number } | undefined;
    if (existing) {
      this.db.prepare(`
        UPDATE accounts SET sync_updated_at = @syncUpdatedAt, name = @name, email = @email, host = @host,
          port = @port, secure = @secure, username = @username, encrypted_password = @encryptedPassword,
          mailbox = @mailbox, provider = @provider, enabled = @enabled
        WHERE sync_id = @syncId
      `).run({
        syncId: payload.syncId,
        syncUpdatedAt: safeIso(payload.updatedAt),
        name: payload.name,
        email: payload.email,
        host: payload.host,
        port: payload.port,
        secure: Number(payload.secure),
        username: payload.username,
        encryptedPassword,
        mailbox: payload.mailbox,
        provider: payload.provider,
        enabled: Number(payload.enabled)
      });
      return { id: existing.id, created: false };
    }
    const result = this.db.prepare(`
      INSERT INTO accounts (
        sync_id, sync_updated_at, name, email, host, port, secure, username, encrypted_password,
        mailbox, provider, enabled
      ) VALUES (
        @syncId, @syncUpdatedAt, @name, @email, @host, @port, @secure, @username, @encryptedPassword,
        @mailbox, @provider, @enabled
      )
    `).run({
      syncId: payload.syncId,
      syncUpdatedAt: safeIso(payload.updatedAt),
      name: payload.name,
      email: payload.email,
      host: payload.host,
      port: payload.port,
      secure: Number(payload.secure),
      username: payload.username,
      encryptedPassword,
      mailbox: payload.mailbox,
      provider: payload.provider,
      enabled: Number(payload.enabled)
    });
    return { id: Number(result.lastInsertRowid), created: true };
  }

  deleteAccount(syncId: string): { deleted: boolean; id: number | null } {
    const existing = this.db.prepare("SELECT id FROM accounts WHERE sync_id = ?").get(syncId) as { id: number } | undefined;
    if (!existing) return { deleted: false, id: null };
    const result = this.db.prepare("DELETE FROM accounts WHERE sync_id = ?").run(syncId);
    return { deleted: result.changes > 0, id: existing.id };
  }

  getState(syncId: string): LocalState | null {
    const row = this.db.prepare(`
      SELECT sync_id AS syncId, remote_revision AS remoteRevision, payload_hash AS payloadHash, deleted
      FROM account_sync_local_state WHERE sync_id = ?
    `).get(syncId) as (Omit<LocalState, "deleted"> & { deleted: number }) | undefined;
    return row ? { ...row, deleted: Boolean(row.deleted) } : null;
  }

  listStates(): LocalState[] {
    return (this.db.prepare(`
      SELECT sync_id AS syncId, remote_revision AS remoteRevision, payload_hash AS payloadHash, deleted
      FROM account_sync_local_state ORDER BY sync_id
    `).all() as Array<Omit<LocalState, "deleted"> & { deleted: number }>).map((row) => ({ ...row, deleted: Boolean(row.deleted) }));
  }

  saveState(syncId: string, remoteRevision: number, payloadHash: string | null, deleted: boolean): void {
    this.db.prepare(`
      INSERT INTO account_sync_local_state (sync_id, remote_revision, payload_hash, deleted, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(sync_id) DO UPDATE SET
        remote_revision = excluded.remote_revision,
        payload_hash = excluded.payload_hash,
        deleted = excluded.deleted,
        updated_at = excluded.updated_at
    `).run(syncId, remoteRevision, payloadHash, Number(deleted), new Date().toISOString());
  }

  relayChanges(after: number, limit = relayPageSize): { changes: AccountSyncRelayChange[]; cursor: number; hasMore: boolean } {
    const normalizedAfter = Math.max(0, Math.trunc(after));
    const normalizedLimit = Math.min(relayPageSize, Math.max(1, Math.trunc(limit)));
    const rows = this.db.prepare(`
      SELECT revision, sync_id AS syncId, ciphertext, deleted, updated_at AS updatedAt
      FROM account_sync_relay_changes
      WHERE revision > ? ORDER BY revision ASC LIMIT ?
    `).all(normalizedAfter, normalizedLimit) as Array<Omit<AccountSyncRelayChange, "deleted"> & { deleted: number }>;
    const changes = rows.map((row) => ({ ...row, deleted: Boolean(row.deleted) }));
    const cursor = changes.at(-1)?.revision ?? normalizedAfter;
    const hasMore = Boolean(this.db.prepare("SELECT 1 FROM account_sync_relay_changes WHERE revision > ? LIMIT 1").get(cursor));
    return { changes, cursor, hasMore };
  }

  relayPut(syncId: string, baseRevision: number, ciphertext: string | null, deleted: boolean): RelayPutResult {
    const transaction = this.db.transaction((): RelayPutResult => {
      const current = this.relayRecord(syncId);
      const currentRevision = current?.revision ?? 0;
      if (currentRevision !== baseRevision) return { ok: false, current };
      const updatedAt = new Date().toISOString();
      const inserted = this.db.prepare(`
        INSERT INTO account_sync_relay_changes (sync_id, ciphertext, deleted, updated_at)
        VALUES (?, ?, ?, ?)
      `).run(syncId, deleted ? null : ciphertext, Number(deleted), updatedAt);
      const revision = Number(inserted.lastInsertRowid);
      this.db.prepare(`
        INSERT INTO account_sync_relay_records (sync_id, revision, ciphertext, deleted, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(sync_id) DO UPDATE SET
          revision = excluded.revision,
          ciphertext = excluded.ciphertext,
          deleted = excluded.deleted,
          updated_at = excluded.updated_at
      `).run(syncId, revision, deleted ? null : ciphertext, Number(deleted), updatedAt);
      return { ok: true, record: { revision, syncId, ciphertext: deleted ? null : ciphertext, deleted, updatedAt } };
    });
    return transaction();
  }

  private relayRecord(syncId: string): AccountSyncRelayChange | null {
    const row = this.db.prepare(`
      SELECT revision, sync_id AS syncId, ciphertext, deleted, updated_at AS updatedAt
      FROM account_sync_relay_records WHERE sync_id = ?
    `).get(syncId) as (Omit<AccountSyncRelayChange, "deleted"> & { deleted: number }) | undefined;
    return row ? { ...row, deleted: Boolean(row.deleted) } : null;
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS account_sync_local_state (
        sync_id TEXT PRIMARY KEY,
        remote_revision INTEGER NOT NULL DEFAULT 0,
        payload_hash TEXT,
        deleted INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS account_sync_relay_changes (
        revision INTEGER PRIMARY KEY AUTOINCREMENT,
        sync_id TEXT NOT NULL,
        ciphertext TEXT,
        deleted INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS account_sync_relay_changes_sync_id_idx
        ON account_sync_relay_changes(sync_id, revision DESC);

      CREATE TABLE IF NOT EXISTS account_sync_relay_records (
        sync_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL UNIQUE,
        ciphertext TEXT,
        deleted INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
    `);
  }
}

type AccountSyncManagerOptions = {
  databasePath: string;
  encryptionKey: Buffer;
  googleClientId: string;
  microsoftClientId: string;
  relayServerToken?: string;
  intervalMs?: number;
  onAccountChanged?: (accountId: number, created: boolean) => void;
  onAccountDeleted?: (accountId: number | null) => void;
};

export class AccountSyncManager {
  private readonly repository: AccountSyncRepository;
  private readonly configStore: AccountSyncConfigStore;
  private readonly oauthFilePath: string;
  private timer: NodeJS.Timeout | null = null;
  private syncing = false;

  constructor(private readonly options: AccountSyncManagerOptions) {
    this.repository = new AccountSyncRepository(options.databasePath);
    this.configStore = new AccountSyncConfigStore(options.databasePath, options.encryptionKey);
    this.oauthFilePath = `${options.databasePath}.oauth-secrets.json`;
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.repository.close();
  }

  start(): void {
    if (this.timer) return;
    const intervalMs = Math.max(60_000, this.options.intervalMs ?? 5 * 60_000);
    this.timer = setInterval(() => void this.syncNow().catch(() => undefined), intervalMs);
    this.timer.unref?.();
    setTimeout(() => void this.syncNow().catch(() => undefined), 5_000).unref?.();
  }

  status(): AccountSyncStatus {
    const config = this.configStore.read();
    return {
      enabled: config.enabled,
      relayUrl: config.relayUrl,
      hasRelayToken: Boolean(config.relayToken),
      hasSyncKey: Boolean(config.syncKey),
      recoveryKey: config.syncKey,
      configured: Boolean(config.relayUrl && config.relayToken && config.syncKey),
      lastCursor: config.lastCursor,
      lastSyncAt: config.lastSyncAt,
      lastError: config.lastError,
      syncing: this.syncing
    };
  }

  configure(input: { enabled: boolean; relayUrl?: string; relayToken?: string; syncKey?: string }): AccountSyncStatus {
    const current = this.configStore.read();
    const relayUrl = input.relayUrl === undefined ? current.relayUrl : normalizeRelayUrl(input.relayUrl);
    const relayToken = input.relayToken === undefined ? current.relayToken : input.relayToken.trim();
    const syncKey = input.syncKey === undefined ? current.syncKey : input.syncKey.trim();
    if (relayToken && relayToken.length < 24) throw new Error("同步服务器令牌至少需要 24 个字符");
    if (syncKey) parseSyncKey(syncKey);
    if (input.enabled && (!relayUrl || !relayToken || !syncKey)) throw new Error("启用账户同步前需要配置服务器、令牌和同步密钥");
    const relayChanged = relayUrl !== current.relayUrl;
    const syncKeyChanged = syncKey !== current.syncKey;
    if (current.lastCursor > 0 && relayChanged) {
      throw Object.assign(new Error("已有账户同步历史，当前版本不支持直接切换同步服务器 namespace"), { status: 409 });
    }
    if (current.lastCursor > 0 && syncKeyChanged) {
      throw Object.assign(new Error("已有账户同步历史，当前版本不支持直接轮换 Recovery Key"), { status: 409 });
    }
    const namespaceChanged = relayChanged || syncKeyChanged;
    this.configStore.write({
      ...current,
      enabled: input.enabled,
      relayUrl,
      relayToken,
      syncKey,
      lastCursor: namespaceChanged ? 0 : current.lastCursor,
      lastSyncAt: namespaceChanged ? null : current.lastSyncAt,
      lastError: null
    });
    return this.status();
  }

  ensureRecoveryKey(): string {
    const config = this.configStore.read();
    if (config.syncKey) return config.syncKey;
    const syncKey = generateAccountSyncKey();
    this.configStore.write({ ...config, syncKey, lastCursor: 0, lastSyncAt: null, lastError: null });
    return syncKey;
  }

  relayAvailable(): boolean {
    return Boolean(this.options.relayServerToken?.trim());
  }

  relayAuthorized(token: string): boolean {
    const expected = Buffer.from(this.options.relayServerToken?.trim() ?? "");
    const supplied = Buffer.from(token.trim());
    return expected.length >= 24 && supplied.length === expected.length && crypto.timingSafeEqual(expected, supplied);
  }

  relayChanges(after: number): { changes: AccountSyncRelayChange[]; cursor: number; hasMore: boolean } {
    if (!this.relayAvailable()) throw Object.assign(new Error("账户同步 relay 未启用"), { status: 404 });
    return this.repository.relayChanges(after);
  }

  relayPut(syncId: string, baseRevision: number, ciphertext: string | null, deleted: boolean): RelayPutResult {
    if (!this.relayAvailable()) throw Object.assign(new Error("账户同步 relay 未启用"), { status: 404 });
    if (!deleted && (!ciphertext || ciphertext.length > 64_000)) throw Object.assign(new Error("同步记录无效或过大"), { status: 400 });
    return this.repository.relayPut(syncId, baseRevision, ciphertext, deleted);
  }

  async syncNow(): Promise<AccountSyncResult> {
    if (this.syncing) throw Object.assign(new Error("账户同步正在进行"), { status: 409 });
    const config = this.configStore.read();
    if (!config.enabled) throw Object.assign(new Error("账户同步尚未启用"), { status: 409 });
    if (!config.relayUrl || !config.relayToken || !config.syncKey) throw Object.assign(new Error("账户同步配置不完整"), { status: 400 });
    parseSyncKey(config.syncKey);
    this.syncing = true;
    const result: AccountSyncResult = { pulled: 0, pushed: 0, deleted: 0, conflicts: 0, cursor: config.lastCursor };
    try {
      let cursor = config.lastCursor;
      while (true) {
        const page = await this.relayRequest<{ changes: AccountSyncRelayChange[]; cursor: number; hasMore: boolean }>(
          config,
          `/api/account-sync/v1/changes?after=${cursor}`
        );
        for (const change of page.changes) {
          const applied = this.applyRemoteChange(change, config.syncKey);
          result.pulled += 1;
          result.deleted += applied.deleted;
          result.conflicts += applied.conflict ? 1 : 0;
          cursor = Math.max(cursor, change.revision);
        }
        cursor = Math.max(cursor, page.cursor);
        if (!page.hasMore) break;
      }
      result.cursor = cursor;

      const accounts = new Map(this.repository.listAccounts().map((account) => [account.syncId, account]));
      for (const account of accounts.values()) {
        const payload = this.exportPayload(account);
        const hash = accountSyncPayloadHash(payload);
        const state = this.repository.getState(account.syncId);
        if (state && !state.deleted && state.payloadHash === hash) continue;
        const pushed = await this.pushRecord(config, payload.syncId, state?.remoteRevision ?? 0, encryptAccountSyncPayload(payload, config.syncKey), false);
        if (pushed.deletedRemotely) {
          const removed = this.repository.deleteAccount(payload.syncId);
          this.deleteOAuthCredential(payload.syncId);
          this.repository.saveState(payload.syncId, pushed.revision, null, true);
          this.options.onAccountDeleted?.(removed.id);
          result.deleted += removed.deleted ? 1 : 0;
          result.conflicts += 1;
          result.cursor = Math.max(result.cursor, pushed.revision);
          continue;
        }
        if (pushed.conflict) result.conflicts += 1;
        this.repository.saveState(payload.syncId, pushed.revision, hash, false);
        result.pushed += 1;
        result.cursor = Math.max(result.cursor, pushed.revision);
      }

      const currentIds = new Set(accounts.keys());
      for (const state of this.repository.listStates()) {
        if (currentIds.has(state.syncId) || state.deleted) continue;
        const pushed = await this.pushRecord(config, state.syncId, state.remoteRevision, null, true);
        this.deleteOAuthCredential(state.syncId);
        this.repository.saveState(state.syncId, pushed.revision, null, true);
        result.pushed += 1;
        result.deleted += 1;
        result.conflicts += pushed.conflict ? 1 : 0;
        result.cursor = Math.max(result.cursor, pushed.revision);
      }

      this.configStore.write({ ...config, lastCursor: result.cursor, lastSyncAt: new Date().toISOString(), lastError: null });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.configStore.write({ ...config, lastCursor: result.cursor, lastSyncAt: config.lastSyncAt, lastError: message.slice(0, 1000) });
      throw error;
    } finally {
      this.syncing = false;
    }
  }

  private applyRemoteChange(change: AccountSyncRelayChange, syncKey: string): { deleted: number; conflict: boolean } {
    if (change.deleted) {
      const removed = this.repository.deleteAccount(change.syncId);
      this.deleteOAuthCredential(change.syncId);
      this.repository.saveState(change.syncId, change.revision, null, true);
      if (removed.deleted) this.options.onAccountDeleted?.(removed.id);
      return { deleted: removed.deleted ? 1 : 0, conflict: false };
    }
    if (!change.ciphertext) throw new Error(`同步记录 ${change.syncId} 缺少加密内容`);
    const payload = decryptAccountSyncPayload(change.ciphertext, syncKey);
    if (payload.syncId !== change.syncId) throw new Error("同步记录标识与加密内容不一致");
    const remoteHash = accountSyncPayloadHash(payload);
    const local = this.repository.getAccount(change.syncId);
    const state = this.repository.getState(change.syncId);
    if (local) {
      const localHash = accountSyncPayloadHash(this.exportPayload(local));
      const localDirty = state ? state.deleted || state.payloadHash !== localHash : localHash !== remoteHash;
      if (localDirty) {
        this.repository.saveState(change.syncId, change.revision, state?.payloadHash ?? remoteHash, false);
        return { deleted: 0, conflict: true };
      }
    }
    const applied = this.importPayload(payload);
    this.repository.saveState(change.syncId, change.revision, remoteHash, false);
    this.options.onAccountChanged?.(applied.id, applied.created);
    return { deleted: 0, conflict: false };
  }

  private async pushRecord(
    config: StoredSyncConfig,
    syncId: string,
    baseRevision: number,
    ciphertext: string | null,
    deleted: boolean
  ): Promise<{ revision: number; conflict: boolean; deletedRemotely: boolean }> {
    let base = baseRevision;
    let conflict = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await this.relayRequest<RelayPutResult>(config, `/api/account-sync/v1/records/${encodeURIComponent(syncId)}`, {
        method: "PUT",
        body: JSON.stringify({ baseRevision: base, ciphertext, deleted })
      });
      if (response.ok) return { revision: response.record.revision, conflict, deletedRemotely: false };
      conflict = true;
      if (response.current?.deleted && !deleted) return { revision: response.current.revision, conflict: true, deletedRemotely: true };
      base = response.current?.revision ?? 0;
    }
    throw Object.assign(new Error("账户同步冲突持续发生，请稍后重试"), { status: 409 });
  }

  private async relayRequest<T>(config: StoredSyncConfig, endpoint: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${config.relayToken}`);
    if (init.body) headers.set("Content-Type", "application/json");
    let response: Response;
    try {
      response = await fetch(`${config.relayUrl}${endpoint}`, { ...init, headers, signal: AbortSignal.timeout(15_000) });
    } catch (error) {
      throw Object.assign(new Error(`账户同步服务器连接失败：${error instanceof Error ? error.message : String(error)}`), { status: 503 });
    }
    const body = await response.json().catch(() => ({})) as { error?: string } & T;
    if (!response.ok) throw Object.assign(new Error(body.error || `账户同步请求失败 (${response.status})`), { status: response.status });
    return body as T;
  }

  private exportPayload(account: LocalAccount): AccountSyncPayload {
    const decrypted = decryptSecret(account.encryptedPassword, this.options.encryptionKey);
    let auth: AccountSyncAuth;
    if (decrypted === "oauth-v1:google" || decrypted === "oauth-v1:microsoft") {
      const provider: OAuthProvider = decrypted.endsWith("google") ? "google" : "microsoft";
      const credential = this.readOAuthCredential(account.syncId);
      if (!credential || credential.provider !== provider || !credential.refreshToken) throw new Error(`邮箱 ${account.email} 缺少可同步的 OAuth refresh token`);
      auth = {
        type: "oauth",
        provider,
        email: credential.email,
        displayName: credential.displayName,
        refreshToken: credential.refreshToken,
        scope: credential.scope
      };
    } else {
      auth = { type: "password", secret: decrypted };
    }
    return accountSyncPayloadSchema.parse({
      version: 1,
      syncId: account.syncId,
      updatedAt: safeIso(account.syncUpdatedAt),
      name: account.name,
      email: account.email,
      host: account.host,
      port: account.port,
      secure: account.secure,
      username: account.username,
      mailbox: account.mailbox,
      provider: account.provider,
      enabled: account.enabled,
      auth
    }) as AccountSyncPayload;
  }

  private importPayload(payload: AccountSyncPayload): { id: number; created: boolean } {
    let encryptedPassword: string;
    if (payload.auth.type === "password") {
      encryptedPassword = encryptSecret(payload.auth.secret, this.options.encryptionKey);
      this.deleteOAuthCredential(payload.syncId);
    } else {
      const clientId = payload.auth.provider === "google" ? this.options.googleClientId.trim() : this.options.microsoftClientId.trim();
      if (!clientId) throw new Error(payload.auth.provider === "google" ? "本机未配置 Google OAuth Client ID" : "本机未配置 Microsoft OAuth Client ID");
      encryptedPassword = encryptSecret(`oauth-v1:${payload.auth.provider}`, this.options.encryptionKey);
      this.writeOAuthCredential(payload.syncId, {
        version: oauthSecretVersion,
        provider: payload.auth.provider,
        email: payload.auth.email,
        displayName: payload.auth.displayName,
        clientId,
        accessToken: "",
        refreshToken: payload.auth.refreshToken,
        expiresAt: 0,
        scope: payload.auth.scope
      });
    }
    return this.repository.upsertAccount(payload, encryptedPassword);
  }

  private readOAuthCredential(syncId: string): OAuthStoredCredential | null {
    const records = this.readOAuthRecords();
    const encrypted = records[syncId];
    if (!encrypted) return null;
    try {
      const parsed = JSON.parse(decryptSecret(encrypted, this.options.encryptionKey)) as OAuthStoredCredential;
      return parsed.version === oauthSecretVersion ? parsed : null;
    } catch {
      throw new Error("OAuth 凭据存储损坏，请重新授权邮箱");
    }
  }

  private writeOAuthCredential(syncId: string, credential: OAuthStoredCredential): void {
    const records = this.readOAuthRecords();
    records[syncId] = encryptSecret(JSON.stringify(credential), this.options.encryptionKey);
    this.writeOAuthRecords(records);
  }

  private deleteOAuthCredential(syncId: string): void {
    const records = this.readOAuthRecords();
    if (!(syncId in records)) return;
    delete records[syncId];
    this.writeOAuthRecords(records);
  }

  private readOAuthRecords(): Record<string, string> {
    if (!fs.existsSync(this.oauthFilePath)) return {};
    try {
      const parsed = JSON.parse(fs.readFileSync(this.oauthFilePath, "utf8")) as { version?: number; records?: Record<string, string> };
      if (parsed.version !== oauthSecretVersion || !parsed.records || typeof parsed.records !== "object") throw new Error("invalid OAuth store");
      return parsed.records;
    } catch {
      throw new Error("OAuth 凭据文件无法读取，请检查本地数据目录");
    }
  }

  private writeOAuthRecords(records: Record<string, string>): void {
    fs.mkdirSync(path.dirname(this.oauthFilePath), { recursive: true });
    fs.writeFileSync(this.oauthFilePath, `${JSON.stringify({ version: oauthSecretVersion, records }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  }
}
