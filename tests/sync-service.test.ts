import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MailDatabase } from "../src/database.js";
import { SyncService } from "../src/sync-service.js";
import type { MailAccount, MailSyncer } from "../src/types.js";

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mail-collector-"));
  const database = new MailDatabase(path.join(directory, "test.db"));
  const account = database.createAccount({
    name: "Test",
    email: "test@example.com",
    host: "imap.example.com",
    port: 993,
    secure: true,
    username: "test@example.com",
    encryptedPassword: crypto.randomBytes(32).toString("hex"),
    mailbox: "INBOX",
    enabled: true
  });
  return { directory, database, account };
}

test("records inserted messages and advances the last UID", async () => {
  const { directory, database, account } = fixture();
  const syncer: MailSyncer = {
    async testConnection(_account: MailAccount) {},
    async sync() {
      return { messages: [{
        uid: 7,
        messageId: null,
        subject: "A message",
        fromName: null,
        fromAddress: "sender@example.com",
        toText: null,
        receivedAt: new Date().toISOString(),
        textBody: "Body",
        htmlBody: null,
        snippet: "Body",
        hasAttachments: false,
        isRead: false,
        size: 10,
        bodyStatus: "complete",
        bodyError: null
      }], readStates: [{ uid: 7, isRead: false }], lastUid: 7, uidValidity: "100" };
    }
  };

  const result = await new SyncService(database, syncer, 100, 1024).syncAccount(account.id);
  assert.equal(result.inserted, 1);
  assert.equal(database.getAccount(account.id)?.lastUid, 7);
  assert.equal(database.getAccount(account.id)?.uidValidity, "100");
  assert.equal(database.getAccount(account.id)?.lastError, null);
  database.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("reports per-account failures when synchronizing all accounts", async () => {
  const { directory, database, account } = fixture();
  database.createAccount({
    name: "Second",
    email: "second@example.com",
    host: "imap.example.com",
    port: 993,
    secure: true,
    username: "second@example.com",
    encryptedPassword: "encrypted",
    mailbox: "INBOX",
    enabled: true
  });
  const syncer: MailSyncer = {
    async testConnection(_account: MailAccount) {},
    async sync(input) {
      if (input.id !== account.id) throw new Error("authentication failed");
      return { messages: [], readStates: [], lastUid: 0, uidValidity: "100" };
    }
  };

  const result = await new SyncService(database, syncer, 100, 1024).syncAll();
  assert.equal(result.succeeded.length, 1);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0]?.error, "authentication failed");
  database.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("records a synchronization error", async () => {
  const { directory, database, account } = fixture();
  const syncer: MailSyncer = {
    async testConnection(_account: MailAccount) {},
    async sync() { throw new Error("connection failed"); }
  };
  const service = new SyncService(database, syncer, 100, 1024);

  await assert.rejects(() => service.syncAccount(account.id), /connection failed/);
  assert.equal(database.getAccount(account.id)?.lastError, "connection failed");
  assert.equal(service.syncingIds.has(account.id), false);
  database.close();
  fs.rmSync(directory, { recursive: true, force: true });
});
