import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { MailDatabase } from "../src/database.js";

function temporaryDatabase(prefix = "mail-collector-config-sync-") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const databasePath = path.join(directory, "test.db");
  return { directory, databasePath, database: new MailDatabase(databasePath) };
}

test("compares and swaps the singleton cloud configuration bundle", () => {
  const { directory, database } = temporaryDatabase();
  try {
    assert.deepEqual(database.getConfigBundle(), { revision: 0, envelope: null });
    const first = { version: "1", iv: "first-iv", ciphertext: "first-ciphertext" };
    assert.deepEqual(database.compareAndSwapConfigBundle(0, first), { ok: true, revision: 1 });
    assert.deepEqual(database.compareAndSwapConfigBundle(0, { ...first, ciphertext: "stale" }), { ok: false, currentRevision: 1 });

    const second = { version: "1", iv: "second-iv", ciphertext: "second-ciphertext" };
    assert.deepEqual(database.compareAndSwapConfigBundle(1, second), { ok: true, revision: 2 });
    assert.deepEqual(database.getConfigBundle(), { revision: 2, envelope: second });
    assert.throws(() => database.compareAndSwapConfigBundle(2, { version: "1", iv: "iv", ciphertext: "x".repeat(513 * 1024) }), /512KB/);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("keeps stable account sync IDs and preserves messages during synced upserts", () => {
  const { directory, database } = temporaryDatabase();
  try {
    const account = database.createAccount({
      name: "Primary",
      email: "mail@example.com",
      host: "imap.example.com",
      port: 993,
      secure: true,
      username: "mail@example.com",
      encryptedPassword: "encrypted-one",
      mailbox: "INBOX",
      enabled: true
    });
    assert.match(account.syncId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(database.getAccountBySyncId(account.syncId)?.id, account.id);

    database.commitSync(account.id, {
      messages: [{
        uid: 4,
        providerMessageId: "INBOX:100:4",
        messageId: null,
        subject: "Preserved",
        fromName: null,
        fromAddress: "sender@example.com",
        toText: "mail@example.com",
        receivedAt: "2026-08-11T10:00:00.000Z",
        textBody: "Body",
        htmlBody: null,
        snippet: "Body",
        hasAttachments: false,
        isRead: true,
        size: 4,
        bodyStatus: "fetched",
        bodyError: null
      }],
      remoteStates: [{ uid: 4, isRead: true, isStarred: false }],
      lastUid: 4,
      uidValidity: "100"
    });

    const updatedAt = new Date(Date.parse(account.syncUpdatedAt) + 1_000).toISOString();
    const result = database.upsertSyncedAccount({
      syncId: account.syncId,
      name: "Renamed",
      email: "mail@example.com",
      host: "imap.changed.example.com",
      port: 993,
      secure: true,
      username: "mail@example.com",
      encryptedPassword: "encrypted-two",
      mailbox: "Archive",
      enabled: true,
      syncUpdatedAt: updatedAt
    });
    assert.equal(result.status, "updated");
    assert.equal(result.connectionChanged, true);
    assert.equal(result.account.id, account.id);
    assert.equal(result.account.uidValidity, null);
    assert.equal(result.account.lastUid, 0);
    assert.equal(result.account.syncState, "idle");
    assert.equal(database.listMessages({ view: "all", limit: 10, offset: 0 }).total, 1);

    assert.equal(database.applyAccountTombstone(account.syncId, account.syncUpdatedAt), "stale");
    const tombstoneAt = new Date(Date.parse(updatedAt) + 1_000).toISOString();
    assert.equal(database.applyAccountTombstone(account.syncId, tombstoneAt), "applied");
    assert.equal(database.getAccount(account.id)?.enabled, false);
    assert.equal(database.getAccount(account.id)?.syncUpdatedAt, tombstoneAt);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("migration 3 backfills stable account sync metadata and creates the bundle schema", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mail-collector-config-migration-"));
  const databasePath = path.join(directory, "test.db");
  const legacy = new Database(databasePath);
  legacy.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO schema_migrations (version, name) VALUES (1, 'reliable_mail_sync'), (2, 'uidvalidity_message_identity');
    CREATE TABLE accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      host TEXT NOT NULL,
      port INTEGER NOT NULL,
      secure INTEGER NOT NULL DEFAULT 1,
      username TEXT NOT NULL,
      encrypted_password TEXT NOT NULL,
      mailbox TEXT NOT NULL DEFAULT 'INBOX',
      provider TEXT NOT NULL DEFAULT 'imap',
      enabled INTEGER NOT NULL DEFAULT 1,
      uid_validity TEXT,
      last_uid INTEGER NOT NULL DEFAULT 0,
      last_sync_at TEXT,
      last_successful_sync_at TEXT,
      last_reconcile_at TEXT,
      last_event_at TEXT,
      last_error TEXT,
      sync_error_count INTEGER NOT NULL DEFAULT 0,
      sync_state TEXT NOT NULL DEFAULT 'idle',
      next_sync_at TEXT,
      backfill_cursor INTEGER,
      backfill_status TEXT NOT NULL DEFAULT 'pending',
      lease_owner TEXT,
      lease_expires_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO accounts (name, email, host, port, secure, username, encrypted_password, mailbox)
    VALUES ('Legacy', 'legacy@example.com', 'imap.example.com', 993, 1, 'legacy@example.com', 'encrypted', 'INBOX');
  `);
  legacy.close();

  let syncId: string;
  const migrated = new MailDatabase(databasePath);
  try {
    const account = migrated.listAccounts()[0]!;
    syncId = account.syncId;
    assert.match(syncId, /^[0-9a-f-]{36}$/i);
    assert.match(account.syncUpdatedAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);
    assert.ok(Number.isFinite(Date.parse(account.syncUpdatedAt)));
  } finally {
    migrated.close();
  }

  const reopened = new MailDatabase(databasePath);
  try {
    assert.equal(reopened.listAccounts()[0]?.syncId, syncId!);
  } finally {
    reopened.close();
  }

  const inspection = new Database(databasePath, { readonly: true });
  try {
    const migration = inspection.prepare("SELECT name FROM schema_migrations WHERE version = 3").get() as { name: string } | undefined;
    const index = inspection.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'accounts_sync_id_idx'").get() as { name: string } | undefined;
    const table = inspection.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cloud_config_bundle'").get() as { name: string } | undefined;
    assert.equal(migration?.name, "cloud_config_sync");
    assert.equal(index?.name, "accounts_sync_id_idx");
    assert.equal(table?.name, "cloud_config_bundle");
  } finally {
    inspection.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
