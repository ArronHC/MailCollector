import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MailDatabase } from "../src/database.js";

test("stores messages once and removes them with their account", () => {
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
  const message = {
    uid: 42,
    providerMessageId: "INBOX:100:42",
    messageId: "message@example.com",
    subject: "Hello",
    fromName: "Sender",
    fromAddress: "sender@example.com",
    toText: "test@example.com",
    receivedAt: "2026-08-09T12:00:00.000Z",
    textBody: "Hello there",
    htmlBody: null,
    snippet: "Hello there",
    hasAttachments: false,
    isRead: false,
    size: 100,
    bodyStatus: "fetched" as const,
    bodyError: null
  };

  assert.equal(database.saveMessages(account.id, [message]), 1);
  assert.equal(database.saveMessages(account.id, [message]), 0);
  assert.equal(database.listMessages({ limit: 40, offset: 0 }).total, 1);
  assert.equal(database.listMessages({ readState: "unread", limit: 40, offset: 0 }).total, 1);
  assert.equal(database.setMessageRead(1, true), true);
  assert.equal(database.listMessages({ readState: "unread", limit: 40, offset: 0 }).total, 0);
  assert.equal(database.listMessages({ readState: "read", limit: 40, offset: 0 }).total, 1);
  assert.equal(database.setMessageStarred(1, true), true);
  assert.equal(database.listMessages({ starred: true, limit: 40, offset: 0 }).total, 1);
  assert.equal(database.deleteAccount(account.id), true);
  assert.equal(database.listMessages({ limit: 40, offset: 0 }).total, 0);

  database.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("atomically resets messages when UIDVALIDITY changes", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mail-collector-"));
  const database = new MailDatabase(path.join(directory, "test.db"));
  const account = database.createAccount({
    name: "Test",
    email: "test@example.com",
    host: "imap.example.com",
    port: 993,
    secure: true,
    username: "test@example.com",
    encryptedPassword: "encrypted",
    mailbox: "INBOX",
    enabled: true
  });
  const message = {
    uid: 1,
    providerMessageId: "INBOX:100:1",
    messageId: null,
    subject: "Message",
    fromName: null,
    fromAddress: null,
    toText: null,
    receivedAt: new Date().toISOString(),
    textBody: null,
    htmlBody: null,
    snippet: "",
    hasAttachments: false,
    isRead: true,
    size: 1,
    bodyStatus: "fetched" as const,
    bodyError: null
  };

  database.commitSync(account.id, { messages: [message], remoteStates: [{ uid: 1, isRead: true, isStarred: false }], lastUid: 1, uidValidity: "100" });
  database.updateMessages([1], { isStarred: true, folder: "archive" });
  database.deleteMessage(1);
  const result = database.commitSync(account.id, { messages: [{ ...message, providerMessageId: "INBOX:200:1", subject: "Replacement" }], remoteStates: [{ uid: 1, isRead: false, isStarred: false }], lastUid: 1, uidValidity: "200" });
  assert.equal(result.mailboxReset, true);
  assert.equal(database.listMessages({ limit: 40, offset: 0 }).total, 1);
  assert.equal(database.listMessages({ readState: "unread", limit: 40, offset: 0 }).total, 1);
  const replacement = database.listMessages({ view: "all", limit: 10, offset: 0 }).messages[0] as { id: number; subject: string; folder: string; isStarred: boolean };
  assert.notEqual(replacement.id, 1);
  assert.equal(replacement.subject, "Replacement");
  assert.equal(replacement.folder, "inbox");
  assert.equal(replacement.isStarred, false);
  assert.deepEqual(database.getMessageDeletionState(1), { providerDeleted: true, localDeleted: true, deletedAt: database.getMessageDeletionState(1)?.deletedAt ?? null });
  assert.equal(database.getAccount(account.id)?.uidValidity, "200");
  database.close();
  fs.rmSync(directory, { recursive: true, force: true });
});
