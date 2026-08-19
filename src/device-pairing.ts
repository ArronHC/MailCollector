import crypto from "node:crypto";
import Database from "better-sqlite3";

const pairingLifetimeMs = 5 * 60_000;
const pairingCodeDigits = 6;

export type PairedDevice = {
  id: string;
  name: string;
  platform: string;
  createdAt: string;
  lastSeenAt: string | null;
};

export type PendingPairingRequest = {
  pairingId: string;
  deviceName: string;
  platform: string;
  requesterPublicKey: string;
  requestedAt: string;
  expiresAt: string;
};

type PairingRow = {
  id: string;
  userId: number;
  codeHash: string;
  status: "waiting" | "requested" | "approved" | "rejected";
  requesterDeviceName: string | null;
  requesterPlatform: string | null;
  requesterPublicKey: string | null;
  joinTokenHash: string | null;
  approverPublicKey: string | null;
  encryptedBundle: string | null;
  approvedDeviceId: string | null;
  createdAt: string;
  requestedAt: string | null;
  expiresAt: string;
};

export class DevicePairingManager {
  private readonly db: Database.Database;

  constructor(databasePath: string, private readonly secret: Buffer, private readonly publicBaseUrl: string) {
    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  create(userId: number): { pairingId: string; code: string; expiresAt: string; publicBaseUrl: string } {
    this.cleanup();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + pairingLifetimeMs).toISOString();
    this.db.prepare("UPDATE device_pairing_sessions SET status = 'rejected' WHERE user_id = ? AND status IN ('waiting', 'requested')").run(userId);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const code = crypto.randomInt(0, 10 ** pairingCodeDigits).toString().padStart(pairingCodeDigits, "0");
      const id = crypto.randomUUID();
      try {
        this.db.prepare(`
          INSERT INTO device_pairing_sessions (id, user_id, code_hash, status, created_at, expires_at)
          VALUES (?, ?, ?, 'waiting', ?, ?)
        `).run(id, userId, this.hashCode(code), now.toISOString(), expiresAt);
        return { pairingId: id, code, expiresAt, publicBaseUrl: this.publicBaseUrl };
      } catch (error) {
        if (attempt === 9) throw error;
      }
    }
    throw new Error("无法生成设备配对码，请稍后重试");
  }

  request(input: { code: string; deviceName: string; platform: string; requesterPublicKey: string }): { pairingId: string; joinToken: string; expiresAt: string } {
    this.cleanup();
    const row = this.db.prepare(`
      SELECT id, user_id AS userId, code_hash AS codeHash, status,
        requester_device_name AS requesterDeviceName, requester_platform AS requesterPlatform,
        requester_public_key AS requesterPublicKey, join_token_hash AS joinTokenHash,
        approver_public_key AS approverPublicKey, encrypted_bundle AS encryptedBundle,
        approved_device_id AS approvedDeviceId, created_at AS createdAt, requested_at AS requestedAt,
        expires_at AS expiresAt
      FROM device_pairing_sessions
      WHERE code_hash = ? AND status = 'waiting' AND expires_at > ?
      LIMIT 1
    `).get(this.hashCode(input.code), new Date().toISOString()) as PairingRow | undefined;
    if (!row) throw Object.assign(new Error("配对码无效或已过期"), { status: 404 });

    const joinToken = crypto.randomBytes(32).toString("base64url");
    const requestedAt = new Date().toISOString();
    const changed = this.db.prepare(`
      UPDATE device_pairing_sessions
      SET status = 'requested', requester_device_name = ?, requester_platform = ?, requester_public_key = ?,
        join_token_hash = ?, requested_at = ?
      WHERE id = ? AND status = 'waiting'
    `).run(
      input.deviceName.trim().slice(0, 120),
      input.platform.trim().slice(0, 40),
      input.requesterPublicKey,
      this.hashToken(joinToken),
      requestedAt,
      row.id
    );
    if (!changed.changes) throw Object.assign(new Error("该配对码已经被使用"), { status: 409 });
    return { pairingId: row.id, joinToken, expiresAt: row.expiresAt };
  }

  pending(userId: number): PendingPairingRequest[] {
    this.cleanup();
    return (this.db.prepare(`
      SELECT id AS pairingId, requester_device_name AS deviceName, requester_platform AS platform,
        requester_public_key AS requesterPublicKey, requested_at AS requestedAt, expires_at AS expiresAt
      FROM device_pairing_sessions
      WHERE user_id = ? AND status = 'requested' AND expires_at > ?
      ORDER BY requested_at DESC
    `).all(userId, new Date().toISOString()) as PendingPairingRequest[]);
  }

  approve(userId: number, pairingId: string, input: { deviceId: string; deviceTokenHash: string; approverPublicKey: string; encryptedBundle: string }): PairedDevice {
    const transaction = this.db.transaction(() => {
      const row = this.getOwnedPairing(userId, pairingId);
      if (!row || row.status !== "requested") throw Object.assign(new Error("配对请求不存在或状态已变化"), { status: 409 });
      if (Date.parse(row.expiresAt) <= Date.now()) throw Object.assign(new Error("配对请求已过期"), { status: 410 });
      if (!row.requesterDeviceName || !row.requesterPlatform) throw new Error("配对请求缺少设备信息");

      const createdAt = new Date().toISOString();
      this.db.prepare(`
        INSERT INTO paired_devices (id, user_id, name, platform, token_hash, created_at, last_seen_at, revoked_at)
        VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)
      `).run(input.deviceId, userId, row.requesterDeviceName, row.requesterPlatform, input.deviceTokenHash, createdAt);

      const updated = this.db.prepare(`
        UPDATE device_pairing_sessions
        SET status = 'approved', approver_public_key = ?, encrypted_bundle = ?, approved_device_id = ?
        WHERE id = ? AND user_id = ? AND status = 'requested'
      `).run(input.approverPublicKey, input.encryptedBundle, input.deviceId, pairingId, userId);
      if (!updated.changes) throw Object.assign(new Error("配对请求状态已变化"), { status: 409 });

      return { id: input.deviceId, name: row.requesterDeviceName, platform: row.requesterPlatform, createdAt, lastSeenAt: null } satisfies PairedDevice;
    });
    return transaction();
  }

  reject(userId: number, pairingId: string): void {
    const changed = this.db.prepare(`
      UPDATE device_pairing_sessions SET status = 'rejected'
      WHERE id = ? AND user_id = ? AND status IN ('waiting', 'requested')
    `).run(pairingId, userId);
    if (!changed.changes) throw Object.assign(new Error("配对请求不存在或已结束"), { status: 404 });
  }

  poll(pairingId: string, joinToken: string): {
    status: "requested" | "approved" | "rejected" | "expired";
    approverPublicKey?: string;
    encryptedBundle?: string;
    deviceId?: string;
  } {
    const row = this.db.prepare(`
      SELECT id, user_id AS userId, code_hash AS codeHash, status,
        requester_device_name AS requesterDeviceName, requester_platform AS requesterPlatform,
        requester_public_key AS requesterPublicKey, join_token_hash AS joinTokenHash,
        approver_public_key AS approverPublicKey, encrypted_bundle AS encryptedBundle,
        approved_device_id AS approvedDeviceId, created_at AS createdAt, requested_at AS requestedAt,
        expires_at AS expiresAt
      FROM device_pairing_sessions WHERE id = ? LIMIT 1
    `).get(pairingId) as PairingRow | undefined;
    if (!row || !row.joinTokenHash || !this.safeEqual(row.joinTokenHash, this.hashToken(joinToken))) {
      throw Object.assign(new Error("配对会话未授权"), { status: 401 });
    }
    if (Date.parse(row.expiresAt) <= Date.now() && row.status !== "approved") return { status: "expired" };
    if (row.status === "rejected" || row.status === "waiting") return { status: row.status === "rejected" ? "rejected" : "requested" };
    if (row.status === "approved") {
      if (!row.approverPublicKey || !row.encryptedBundle || !row.approvedDeviceId) throw new Error("配对结果不完整");
      return {
        status: "approved",
        approverPublicKey: row.approverPublicKey,
        encryptedBundle: row.encryptedBundle,
        deviceId: row.approvedDeviceId
      };
    }
    return { status: "requested" };
  }

  listDevices(userId: number): PairedDevice[] {
    return this.db.prepare(`
      SELECT id, name, platform, created_at AS createdAt, last_seen_at AS lastSeenAt
      FROM paired_devices
      WHERE user_id = ? AND revoked_at IS NULL
      ORDER BY COALESCE(last_seen_at, created_at) DESC
    `).all(userId) as PairedDevice[];
  }

  revokeDevice(userId: number, deviceId: string): void {
    const changed = this.db.prepare(`
      UPDATE paired_devices SET revoked_at = ?
      WHERE id = ? AND user_id = ? AND revoked_at IS NULL
    `).run(new Date().toISOString(), deviceId, userId);
    if (!changed.changes) throw Object.assign(new Error("设备不存在或已移除"), { status: 404 });
  }

  authorizeDevice(deviceToken: string): { userId: number; deviceId: string; deviceName: string } | null {
    const token = deviceToken.trim();
    if (token.length < 24) return null;
    const row = this.db.prepare(`
      SELECT id AS deviceId, user_id AS userId, name AS deviceName
      FROM paired_devices
      WHERE token_hash = ? AND revoked_at IS NULL
      LIMIT 1
    `).get(this.hashToken(token)) as { userId: number; deviceId: string; deviceName: string } | undefined;
    if (!row) return null;
    this.db.prepare("UPDATE paired_devices SET last_seen_at = ? WHERE id = ?").run(new Date().toISOString(), row.deviceId);
    return row;
  }

  private getOwnedPairing(userId: number, pairingId: string): PairingRow | null {
    const row = this.db.prepare(`
      SELECT id, user_id AS userId, code_hash AS codeHash, status,
        requester_device_name AS requesterDeviceName, requester_platform AS requesterPlatform,
        requester_public_key AS requesterPublicKey, join_token_hash AS joinTokenHash,
        approver_public_key AS approverPublicKey, encrypted_bundle AS encryptedBundle,
        approved_device_id AS approvedDeviceId, created_at AS createdAt, requested_at AS requestedAt,
        expires_at AS expiresAt
      FROM device_pairing_sessions WHERE id = ? AND user_id = ? LIMIT 1
    `).get(pairingId, userId) as PairingRow | undefined;
    return row ?? null;
  }

  private cleanup(): void {
    const cutoff = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    this.db.prepare("DELETE FROM device_pairing_sessions WHERE expires_at < ?").run(cutoff);
  }

  private hashCode(code: string): string {
    return crypto.createHmac("sha256", this.secret).update(code.replace(/\D/g, "")).digest("hex");
  }

  private hashToken(token: string): string {
    return crypto.createHash("sha256").update(token).digest("hex");
  }

  private safeEqual(left: string, right: string): boolean {
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS device_pairing_sessions (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        code_hash TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        requester_device_name TEXT,
        requester_platform TEXT,
        requester_public_key TEXT,
        join_token_hash TEXT,
        approver_public_key TEXT,
        encrypted_bundle TEXT,
        approved_device_id TEXT,
        created_at TEXT NOT NULL,
        requested_at TEXT,
        expires_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS device_pairing_sessions_user_status_idx
        ON device_pairing_sessions(user_id, status, expires_at);

      CREATE TABLE IF NOT EXISTS paired_devices (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        platform TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        last_seen_at TEXT,
        revoked_at TEXT
      );

      CREATE INDEX IF NOT EXISTS paired_devices_user_idx
        ON paired_devices(user_id, revoked_at, last_seen_at);
    `);
  }
}
