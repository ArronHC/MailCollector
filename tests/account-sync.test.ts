import assert from "node:assert/strict";
import crypto from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AccountSyncManager,
  AccountSyncRepository,
  accountSyncPayloadHash,
  decryptAccountSyncPayload,
  encryptAccountSyncPayload,
  generateAccountSyncKey,
  type AccountSyncPayload
} from "../src/account-sync.js";
import { decryptSecret, encryptSecret } from "../src/crypto.js";
import { MailDatabase } from "../src/database.js";

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

async function readJsonBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function relayHttpServer(repository: AccountSyncRepository, token: string): http.Server {
  return http.createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.statusCode = 401;
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/api/account-sync/v1/changes") {
      response.end(JSON.stringify(repository.relayChanges(Number(url.searchParams.get("after") ?? 0))));
      return;
    }
    const match = request.method === "PUT" ? url.pathname.match(/^\/api\/account-sync\/v1\/records\/([0-9a-f-]+)$/i) : null;
    if (match?.[1]) {
      const input = await readJsonBody(request);
      response.end(JSON.stringify(repository.relayPut(
        match[1],
        Number(input.baseRevision ?? 0),
        typeof input.ciphertext === "string" ? input.ciphertext : null,
        input.deleted === true
      )));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
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

test("two devices replicate an encrypted account and later observe its tombstone", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mail-collector-account-sync-e2e-"));
  const relayRepository = new AccountSyncRepository(path.join(directory, "relay.db"));
  const relayToken = "relay-token-for-tests-0123456789";
  const server = relayHttpServer(relayRepository, relayToken);
  const keyA = crypto.randomBytes(32);
  const keyB = crypto.randomBytes(32);
  const dbAPath = path.join(directory, "device-a.db");
  const dbBPath = path.join(directory, "device-b.db");
  const dbA = new MailDatabase(dbAPath);
  const dbB = new MailDatabase(dbBPath);
  const managerA = new AccountSyncManager({ databasePath: dbAPath, encryptionKey: keyA, googleClientId: "", microsoftClientId: "" });
  const managerB = new AccountSyncManager({ databasePath: dbBPath, encryptionKey: keyB, googleClientId: "", microsoftClientId: "" });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const relayUrl = `http://127.0.0.1:${address.port}`;
    const recoveryKey = generateAccountSyncKey();
    const syncId = crypto.randomUUID();
    const syncUpdatedAt = new Date().toISOString();
    const created = dbA.createAccount({
      syncId,
      syncUpdatedAt,
      name: "Personal IMAP",
      email: "person@example.com",
      host: "imap.example.com",
      port: 993,
      secure: true,
      username: "person@example.com",
      encryptedPassword: encryptSecret("device-independent-app-password", keyA),
      mailbox: "INBOX",
      provider: "imap",
      enabled: true
    });

    managerA.configure({ enabled: true, relayUrl, relayToken, syncKey: recoveryKey });
    managerB.configure({ enabled: true, relayUrl, relayToken, syncKey: recoveryKey });
    const uploaded = await managerA.syncNow();
    assert.equal(uploaded.pushed, 1);
    const downloaded = await managerB.syncNow();
    assert.equal(downloaded.pulled >= 1, true);

    const replicated = dbB.listAccounts().find((account) => account.syncId === syncId);
    assert.ok(replicated);
    assert.equal(replicated.email, "person@example.com");
    assert.equal(decryptSecret(replicated.encryptedPassword, keyB), "device-independent-app-password");
    assert.equal(replicated.lastUid, 0);
    assert.equal(replicated.uidValidity, null);

    assert.equal(dbA.deleteAccount(created.id), true);
    const tombstone = await managerA.syncNow();
    assert.equal(tombstone.deleted, 1);
    await managerB.syncNow();
    assert.equal(dbB.listAccounts().some((account) => account.syncId === syncId), false);
  } finally {
    managerA.close();
    managerB.close();
    dbA.close();
    dbB.close();
    relayRepository.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
