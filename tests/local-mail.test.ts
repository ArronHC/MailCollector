import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import LegacyDatabase from "better-sqlite3";
import { MailDatabase } from "../src/database.js";
import type { ParsedMessage } from "../src/types.js";

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mail-collector-local-"));
  const database = new MailDatabase(path.join(directory, "test.db"));
  const account = database.createAccount({
    name: "Test",
    email: "test@example.com",
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    username: "test@example.com",
    encryptedPassword: "encrypted",
    mailbox: "INBOX",
    enabled: true
  });
  return { directory, database, account };
}

function message(uid: number, subject = `Message ${uid}`): ParsedMessage {
  return {
    uid,
    messageId: `${uid}@example.com`,
    subject,
    fromName: "Sender",
    fromAddress: "sender@example.com",
    toText: "test@example.com",
    receivedAt: `2026-08-0${uid}T12:00:00.000Z`,
    textBody: `Body ${uid}`,
    htmlBody: null,
    snippet: `Body ${uid}`,
    hasAttachments: false,
    isRead: false,
    size: 10,
    bodyStatus: "complete",
    bodyError: null
  };
}

test("migrates legacy messages to inbox received state", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mail-collector-migration-"));
  const databasePath = path.join(directory, "legacy.db");
  const legacy = new LegacyDatabase(databasePath);
  legacy.exec(`
    CREATE TABLE accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL,
      host TEXT NOT NULL, port INTEGER NOT NULL, secure INTEGER NOT NULL DEFAULT 1,
      username TEXT NOT NULL, encrypted_password TEXT NOT NULL, mailbox TEXT NOT NULL DEFAULT 'INBOX',
      enabled INTEGER NOT NULL DEFAULT 1, uid_validity TEXT, last_uid INTEGER NOT NULL DEFAULT 0,
      last_sync_at TEXT, last_error TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      uid INTEGER NOT NULL, message_id TEXT, subject TEXT NOT NULL DEFAULT '', from_name TEXT,
      from_address TEXT, to_text TEXT, received_at TEXT NOT NULL, text_body TEXT, html_body TEXT,
      snippet TEXT NOT NULL DEFAULT '', has_attachments INTEGER NOT NULL DEFAULT 0,
      is_read INTEGER NOT NULL DEFAULT 1, is_starred INTEGER NOT NULL DEFAULT 0, size INTEGER NOT NULL DEFAULT 0,
      body_status TEXT NOT NULL DEFAULT 'complete', body_error TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(account_id, uid)
    );
    INSERT INTO accounts (name, email, host, port, username, encrypted_password)
    VALUES ('Legacy', 'legacy@example.com', 'imap.gmail.com', 993, 'legacy@example.com', 'encrypted');
    INSERT INTO messages (account_id, uid, subject, received_at) VALUES (1, 1, 'Legacy message', '2026-08-01T00:00:00.000Z');
  `);
  legacy.close();

  const database = new MailDatabase(databasePath);
  const stored = database.getMessage(1) as { folder: string; snoozedUntil: string | null; kind: string; labels: unknown[] };
  assert.equal(stored.folder, "inbox");
  assert.equal(stored.snoozedUntil, null);
  assert.equal(stored.kind, "received");
  assert.deepEqual(stored.labels, []);
  assert.deepEqual(database.listLabels().map((label) => label.name), ["个人", "工作", "订阅"]);
  database.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("supports folders, snooze, labels, bulk actions, and local conflict preservation", () => {
  const { directory, database, account } = fixture();
  database.saveMessages(account.id, [message(1), message(2), message(3)]);
  const custom = database.createLabel("Project A");
  const work = database.listLabels().find((label) => label.name === "工作")!;

  assert.equal(database.listMessages({ limit: 40, offset: 0 }).total, 3);
  assert.deepEqual(database.updateMessages([1], {
    isStarred: true,
    snoozedUntil: "2099-01-01T00:00:00.000Z",
    labels: [work.id, custom.id]
  }), { updated: 1, missingIds: [] });
  assert.equal(database.listMessages({ view: "inbox", limit: 40, offset: 0 }).total, 2);
  assert.equal(database.listMessages({ view: "snoozed", limit: 40, offset: 0 }).total, 1);
  assert.equal(database.listMessages({ view: "all", label: String(custom.id), limit: 40, offset: 0 }).total, 1);
  assert.equal(database.listMessages({ view: "all", label: "工作", limit: 40, offset: 0 }).total, 1);

  database.updateMessages([2], { folder: "archive" });
  assert.equal(database.listMessages({ view: "archive", limit: 40, offset: 0 }).total, 1);
  assert.deepEqual(database.updateMessages([2, 3, 999], { isRead: true, folder: "trash", labels: [custom.id] }), {
    updated: 2,
    missingIds: [999]
  });
  assert.equal(database.listMessages({ view: "trash", readState: "read", limit: 40, offset: 0 }).total, 2);

  database.commitSync(account.id, {
    messages: [message(1, "Server replacement")],
    readStates: [{ uid: 1, isRead: true }],
    lastUid: 3,
    uidValidity: "100"
  });
  const preserved = database.getMessage(1) as { subject: string; folder: string; snoozedUntil: string; labels: Array<{ id: number }> };
  assert.equal(preserved.subject, "Message 1");
  assert.equal(preserved.folder, "inbox");
  assert.equal(preserved.snoozedUntil, "2099-01-01T00:00:00.000Z");
  assert.deepEqual(preserved.labels.map((label) => label.id).sort((a, b) => a - b), [work.id, custom.id].sort((a, b) => a - b));

  assert.equal(database.deleteLabel(custom.id), "deleted");
  assert.equal(database.listMessages({ view: "all", label: String(custom.id), limit: 40, offset: 0 }).total, 0);
  assert.equal(database.deleteLabel(work.id), "protected");
  assert.equal(database.deleteMessage(3), true);
  assert.equal(database.getMessage(3), null);
  database.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("stores and updates drafts, creates sent copies, and preserves local records on mailbox reset", () => {
  const { directory, database, account } = fixture();
  const draft = database.createDraft({
    accountId: account.id,
    to: ["one@example.com"],
    cc: [],
    bcc: [],
    subject: "Initial draft",
    body: "First body"
  }) as { id: number; kind: string };
  assert.equal(draft.kind, "draft");
  assert.equal(database.listMessages({ view: "drafts", limit: 40, offset: 0 }).total, 1);

  const updated = database.updateDraft(draft.id, {
    cc: ["copy@example.com"],
    subject: "Updated draft",
    body: "Updated body"
  }) as { subject: string; cc: string[]; textBody: string };
  assert.equal(updated.subject, "Updated draft");
  assert.deepEqual(updated.cc, ["copy@example.com"]);
  assert.equal(updated.textBody, "Updated body");

  const sent = database.createSentMessage({
    accountId: account.id,
    to: ["two@example.com"],
    cc: [],
    bcc: [],
    subject: "Direct send",
    body: "Sent body"
  }, "sent-direct@example.com") as { kind: string };
  assert.equal(sent.kind, "sent");
  assert.equal(database.listMessages({ view: "sent", limit: 40, offset: 0 }).total, 1);

  const converted = database.convertDraftToSent(draft.id, "sent-draft@example.com") as { kind: string; messageId: string };
  assert.equal(converted.kind, "sent");
  assert.equal(converted.messageId, "sent-draft@example.com");
  assert.equal(database.listMessages({ view: "drafts", limit: 40, offset: 0 }).total, 0);
  assert.equal(database.listMessages({ view: "sent", limit: 40, offset: 0 }).total, 2);

  database.commitSync(account.id, { messages: [message(1)], readStates: [], lastUid: 1, uidValidity: "100" });
  database.commitSync(account.id, { messages: [message(1, "Reset copy")], readStates: [], lastUid: 1, uidValidity: "200" });
  assert.equal(database.listMessages({ view: "sent", limit: 40, offset: 0 }).total, 2);
  assert.equal(database.listMessages({ view: "inbox", limit: 40, offset: 0 }).total, 1);
  database.close();
  fs.rmSync(directory, { recursive: true, force: true });
});
