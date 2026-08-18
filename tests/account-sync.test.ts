import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AccountSyncRepository,
  accountSyncPayloadHash,
  decryptAccountSyncPayload,
  encryptAccountSyncPayload,
  generateAccountSyncKey,
  type AccountSyncPayload
} from "../src/account-sync.js";

function samplePayload(): AccountSyncPayload {
  return {
    version: 1,
    syncId: "550e8400-e29b-41d4-a716-446655440000",
    updatedAt: "2026-08-19T00:00:00.000Z",
    name: "Gmail",
    email: "arron@example.com",
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    username: "arron@example.com",
    mailbox: "INBOX",
    provider: "gmail",
    enabled: true,
    auth: {
      type: "oauth",
      provider: "google",
      email: "arron@example.com",
      displayName: "Arron",
      refreshToken: "refresh-secret",
      scope: "openid email https://mail.google.com/"
    }
  };
}

test("account sync payload is encrypted with a separate recovery key", () => {
  const key = generateAccountSyncKey();
  assert.match(key, /^mcsk1_[A-Za-z0-9_-]+$/);
  const payload = samplePayload();
  const ciphertext = encryptAccountSyncPayload(payload, key);
  assert.equal(ciphertext.includes(payload.email), false);
  assert.equal(ciphertext.includes("refresh-secret"), false);
  assert.deepEqual(decryptAccountSyncPayload(ciphertext, key), payload);
  assert.equal(accountSyncPayloadHash(payload), accountSyncPayloadHash({ ...payload }));
});

test("account sync payload rejects the wrong recovery key", () => {
  const payload = samplePayload();
  const ciphertext = encryptAccountSyncPayload(payload, generateAccountSyncKey());
  assert.throws(() => decryptAccountSyncPayload(ciphertext, generateAccountSyncKey()));
});

test("relay uses optimistic revisions and keeps tombstones", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mail-collector-account-sync-"));
  const databasePath = path.join(directory, "relay.db");
  const repository = new AccountSyncRepository(databasePath);
  try {
    const first = repository.relayPut(samplePayload().syncId, 0, "ciphertext-one", false);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.record.revision, 1);

    const stale = repository.relayPut(samplePayload().syncId, 0, "ciphertext-stale", false);
    assert.equal(stale.ok, false);
    if (stale.ok) return;
    assert.equal(stale.current?.revision, 1);

    const deleted = repository.relayPut(samplePayload().syncId, 1, null, true);
    assert.equal(deleted.ok, true);
    if (!deleted.ok) return;
    assert.equal(deleted.record.deleted, true);
    assert.equal(deleted.record.revision, 2);

    const page = repository.relayChanges(0);
    assert.equal(page.cursor, 2);
    assert.deepEqual(page.changes.map((item) => [item.revision, item.deleted]), [[1, false], [2, true]]);
  } finally {
    repository.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
