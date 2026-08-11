import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MailDatabase } from "../src/database.js";
import { classifyMail, type ClassifiableMessage } from "../src/mail-classifier.js";
import type { ParsedMessage } from "../src/types.js";

function candidate(input: Partial<ClassifiableMessage>): ClassifiableMessage {
  return { subject: "", fromName: null, fromAddress: null, toText: null, textBody: null, snippet: "", ...input };
}

test("classifies confident subscription, work, and personal messages", () => {
  assert.equal(classifyMail(candidate({ subject: "Weekly product digest", fromAddress: "newsletter@example.com", textBody: "Manage preferences or unsubscribe" })), "订阅");
  assert.equal(classifyMail(candidate({ subject: "Project meeting and review", fromAddress: "manager@company.example", textBody: "Meeting agenda and action items" })), "工作");
  assert.equal(classifyMail(candidate({ subject: "Happy birthday invitation", fromAddress: "friend@gmail.com", textBody: "Hi Arron" })), "个人");
  assert.equal(classifyMail(candidate({ subject: "Security alert", fromAddress: "no-reply@accounts.example.com", textBody: "A new sign-in was detected" })), null);
});

test("automatically labels inserted mail and preserves manual labels during reclassification", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mail-collector-classifier-"));
  const database = new MailDatabase(path.join(directory, "test.db"));
  const account = database.createAccount({ name: "Test", email: "test@example.com", host: "imap.example.com", port: 993, secure: true, username: "test@example.com", encryptedPassword: "encrypted", mailbox: "INBOX", enabled: true });
  const message: ParsedMessage = {
    uid: 1, providerMessageId: "INBOX:100:1", messageId: "newsletter@example.com", subject: "Weekly newsletter", fromName: "Product News", fromAddress: "newsletter@example.com", toText: "test@example.com",
    receivedAt: new Date().toISOString(), textBody: "Manage preferences or unsubscribe", htmlBody: null, snippet: "Weekly updates", hasAttachments: false,
    isRead: false, size: 20, bodyStatus: "fetched", bodyError: null
  };
  database.saveMessages(account.id, [message]);
  const stored = database.listMessages({ view: "all", limit: 10, offset: 0 }).messages as Array<{ id: number; labels: Array<{ id: number; name: string }> }>;
  assert.deepEqual(stored[0]?.labels.map((label) => label.name), ["订阅"]);

  const work = database.listLabels().find((label) => label.name === "工作")!;
  database.updateMessages([stored[0]!.id], { labels: [work.id] });
  database.autoClassifyMessages(account.id);
  const reclassified = database.getMessage(stored[0]!.id) as { labels: Array<{ name: string }> };
  assert.deepEqual(reclassified.labels.map((label) => label.name).sort(), ["工作", "订阅"]);
  database.close();
  fs.rmSync(directory, { recursive: true, force: true });
});
