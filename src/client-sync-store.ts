import crypto from "node:crypto";
import Database from "better-sqlite3";

export type ClientPlatform = "windows" | "android" | "web";

export type ClientDevice = {
  id: string;
  name: string;
  platform: ClientPlatform;
  lastSeenAt: string;
  lastSyncRevision: number;
  createdAt: string;
  revokedAt: string | null;
};

export type ClientSyncEvent = {
  revision: number;
  operationId: string;
  deviceId: string;
  kind: string;
  method: string;
  path: string;
  resourceId: string | null;
  createdAt: string;
};

type DeviceInput = {
  id: string;
  name: string;
  platform: ClientPlatform;
};

type DeviceRow = {
  id: string;
  name: string;
  platform: ClientPlatform;
  last_seen_at: string;
  last_sync_revision: number;
  created_at: string;
  revoked_at: string | null;
};

type EventRow = {
  revision: number;
  operation_id: string;
  device_id: string;
  kind: string;
  method: string;
  path: string;
  resource_id: string | null;
  created_at: string;
};

export class ClientSyncStore {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS client_devices (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        platform TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        last_sync_revision INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        revoked_at TEXT
      );

      CREATE INDEX IF NOT EXISTS client_devices_user_idx
        ON client_devices(user_id, revoked_at, last_seen_at DESC);

      CREATE TABLE IF NOT EXISTS client_device_sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        device_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS client_device_sessions_device_idx
        ON client_device_sessions(user_id, device_id);

      CREATE TABLE IF NOT EXISTS client_sync_events (
        revision INTEGER PRIMARY KEY AUTOINCREMENT,
        operation_id TEXT NOT NULL UNIQUE,
        user_id INTEGER NOT NULL,
        device_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        resource_id TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS client_sync_events_user_revision_idx
        ON client_sync_events(user_id, revision);

      CREATE TABLE IF NOT EXISTS client_sync_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  upsertDevice(userId: number, input: DeviceInput): ClientDevice {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO client_devices (id, user_id, name, platform, last_seen_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        platform = excluded.platform,
        last_seen_at = excluded.last_seen_at
      WHERE client_devices.user_id = excluded.user_id
        AND client_devices.revoked_at IS NULL
    `).run(input.id, userId, input.name, input.platform, now, now);

    const row = this.db.prepare(`
      SELECT id, name, platform, last_seen_at, last_sync_revision, created_at, revoked_at
      FROM client_devices
      WHERE id = ? AND user_id = ?
    `).get(input.id, userId) as DeviceRow | undefined;

    if (!row || row.revoked_at) {
      const error = new Error("此设备已被移除，请在已登录设备中重新授权");
      Object.assign(error, { status: 403 });
      throw error;
    }
    return this.mapDevice(row);
  }

  ensureSession(userId: number, tokenHash: string, input: DeviceInput): ClientDevice {
    const device = this.upsertDevice(userId, input);
    const existing = this.db.prepare(`
      SELECT device_id AS deviceId
      FROM client_device_sessions
      WHERE token_hash = ? AND user_id = ?
    `).get(tokenHash, userId) as { deviceId: string } | undefined;

    if (existing && existing.deviceId !== input.id) {
      const error = new Error("登录凭证已经绑定到另一台设备");
      Object.assign(error, { status: 401 });
      throw error;
    }
    if (!existing) this.bindSession(userId, tokenHash, input.id);
    return device;
  }

  bindSession(userId: number, tokenHash: string, deviceId: string): void {
    this.db.prepare(`
      INSERT INTO client_device_sessions (token_hash, user_id, device_id, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(token_hash) DO UPDATE SET
        user_id = excluded.user_id,
        device_id = excluded.device_id
    `).run(tokenHash, userId, deviceId, new Date().toISOString());
  }

  unbindSession(tokenHash: string): void {
    this.db.prepare("DELETE FROM client_device_sessions WHERE token_hash = ?").run(tokenHash);
  }

  listDevices(userId: number): ClientDevice[] {
    const rows = this.db.prepare(`
      SELECT id, name, platform, last_seen_at, last_sync_revision, created_at, revoked_at
      FROM client_devices
      WHERE user_id = ? AND revoked_at IS NULL
      ORDER BY last_seen_at DESC
    `).all(userId) as DeviceRow[];
    return rows.map((row) => this.mapDevice(row));
  }

  renameDevice(userId: number, deviceId: string, name: string): ClientDevice | null {
    this.db.prepare(`
      UPDATE client_devices SET name = ?, last_seen_at = ?
      WHERE id = ? AND user_id = ? AND revoked_at IS NULL
    `).run(name, new Date().toISOString(), deviceId, userId);
    const row = this.db.prepare(`
      SELECT id, name, platform, last_seen_at, last_sync_revision, created_at, revoked_at
      FROM client_devices WHERE id = ? AND user_id = ? AND revoked_at IS NULL
    `).get(deviceId, userId) as DeviceRow | undefined;
    return row ? this.mapDevice(row) : null;
  }

  revokeDevice(userId: number, deviceId: string): boolean {
    const result = this.db.prepare(`
      UPDATE client_devices SET revoked_at = ?
      WHERE id = ? AND user_id = ? AND revoked_at IS NULL
    `).run(new Date().toISOString(), deviceId, userId);
    this.db.prepare("DELETE FROM client_device_sessions WHERE user_id = ? AND device_id = ?").run(userId, deviceId);
    return result.changes > 0;
  }

  ack(userId: number, deviceId: string, revision: number): void {
    this.db.prepare(`
      UPDATE client_devices
      SET last_sync_revision = MAX(last_sync_revision, ?), last_seen_at = ?
      WHERE id = ? AND user_id = ? AND revoked_at IS NULL
    `).run(revision, new Date().toISOString(), deviceId, userId);
  }

  recordMutation(input: {
    userId: number;
    deviceId: string;
    operationId?: string;
    method: string;
    path: string;
  }): number {
    const operationId = input.operationId || crypto.randomUUID();
    const kind = this.kindForPath(input.path);
    const resourceId = this.resourceIdForPath(input.path);
    this.db.prepare(`
      INSERT OR IGNORE INTO client_sync_events
        (operation_id, user_id, device_id, kind, method, path, resource_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(operationId, input.userId, input.deviceId, kind, input.method, input.path, resourceId, new Date().toISOString());
    const row = this.db.prepare("SELECT revision FROM client_sync_events WHERE operation_id = ?").get(operationId) as { revision: number } | undefined;
    return row?.revision ?? this.currentRevision(input.userId);
  }

  pull(userId: number, deviceId: string, after: number, limit = 250): { revision: number; events: ClientSyncEvent[] } {
    this.refreshServerFingerprint(userId);
    const rows = this.db.prepare(`
      SELECT revision, operation_id, device_id, kind, method, path, resource_id, created_at
      FROM client_sync_events
      WHERE user_id = ? AND revision > ?
      ORDER BY revision ASC
      LIMIT ?
    `).all(userId, after, Math.max(1, Math.min(limit, 500))) as EventRow[];
    const revision = rows.length ? rows[rows.length - 1].revision : this.currentRevision(userId);
    this.ack(userId, deviceId, revision);
    return { revision, events: rows.map((row) => this.mapEvent(row)) };
  }

  currentRevision(userId: number): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(revision), 0) AS revision FROM client_sync_events WHERE user_id = ?").get(userId) as { revision: number };
    return row.revision;
  }

  private refreshServerFingerprint(userId: number): void {
    const messages = this.db.prepare(`
      SELECT
        COUNT(*) AS count,
        COALESCE(MAX(id), 0) AS maxId,
        COALESCE(SUM(is_read), 0) AS readCount,
        COALESCE(SUM(is_starred), 0) AS starredCount,
        COALESCE(SUM(local_deleted), 0) AS deletedCount,
        COALESCE(SUM(CASE WHEN folder = 'inbox' THEN 1 ELSE 0 END), 0) AS inboxCount,
        COALESCE(SUM(CASE WHEN folder = 'archive' THEN 1 ELSE 0 END), 0) AS archiveCount,
        COALESCE(SUM(CASE WHEN folder = 'trash' THEN 1 ELSE 0 END), 0) AS trashCount,
        COALESCE(MAX(received_at), '') AS latestReceivedAt
      FROM messages
    `).get();
    const accounts = this.db.prepare(`
      SELECT COUNT(*) AS count, COALESCE(MAX(last_event_at), '') AS lastEventAt,
             COALESCE(MAX(last_successful_sync_at), '') AS lastSyncAt
      FROM accounts
    `).get();
    const labels = this.db.prepare("SELECT COUNT(*) AS count FROM labels").get();
    const fingerprint = JSON.stringify({ messages, accounts, labels });
    const key = `mail-state:${userId}`;
    const previous = this.db.prepare("SELECT value FROM client_sync_meta WHERE key = ?").get(key) as { value: string } | undefined;
    const now = new Date().toISOString();

    if (!previous) {
      this.db.prepare("INSERT INTO client_sync_meta (key, value, updated_at) VALUES (?, ?, ?)").run(key, fingerprint, now);
      return;
    }
    if (previous.value === fingerprint) return;

    this.db.transaction(() => {
      this.db.prepare("UPDATE client_sync_meta SET value = ?, updated_at = ? WHERE key = ?").run(fingerprint, now, key);
      this.db.prepare(`
        INSERT INTO client_sync_events
          (operation_id, user_id, device_id, kind, method, path, resource_id, created_at)
        VALUES (?, ?, 'server', 'mail-state', 'SYNC', '/api/messages', NULL, ?)
      `).run(crypto.randomUUID(), userId, now);
    })();
  }

  private kindForPath(path: string): string {
    if (path.startsWith("/api/messages")) return "message";
    if (path.startsWith("/api/accounts")) return "account";
    if (path.startsWith("/api/labels")) return "label";
    if (path.startsWith("/api/drafts")) return "draft";
    if (path.startsWith("/api/send")) return "send";
    if (path.startsWith("/api/sync")) return "mail-sync";
    return "state";
  }

  private resourceIdForPath(path: string): string | null {
    const match = path.match(/^\/api\/(?:messages|accounts|labels|drafts)\/(\d+)/);
    return match?.[1] ?? null;
  }

  private mapDevice(row: DeviceRow): ClientDevice {
    return {
      id: row.id,
      name: row.name,
      platform: row.platform,
      lastSeenAt: row.last_seen_at,
      lastSyncRevision: row.last_sync_revision,
      createdAt: row.created_at,
      revokedAt: row.revoked_at
    };
  }

  private mapEvent(row: EventRow): ClientSyncEvent {
    return {
      revision: row.revision,
      operationId: row.operation_id,
      deviceId: row.device_id,
      kind: row.kind,
      method: row.method,
      path: row.path,
      resourceId: row.resource_id,
      createdAt: row.created_at
    };
  }
}
