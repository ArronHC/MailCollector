import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MailDatabase } from "../src/database.js";
import { ImapIdleService } from "../src/imap-idle-service.js";
import { MailWorker } from "../src/mail-worker.js";
import { SyncService } from "../src/sync-service.js";
import type { BackfillResult, MailAccount, MailOperation, MailProvider, ParsedMessage, SyncResult } from "../src/types.js";

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mail-sync-engine-"));
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
  return { directory, database, account, close: () => { database.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}

function message(uid: number, uidValidity = "100"): ParsedMessage {
  return {
    uid,
    providerMessageId: `INBOX:${uidValidity}:${uid}`,
    messageId: `${uid}@example.com`,
    subject: `Message ${uid}`,
    fromName: "Sender",
    fromAddress: "sender@example.com",
    toText: "test@example.com",
    receivedAt: `2026-08-10T00:00:${String(uid).padStart(2, "0")}.000Z`,
    textBody: null,
    htmlBody: null,
    snippet: `Message ${uid}`,
    hasAttachments: false,
    isRead: false,
    size: 100,
    bodyStatus: "not_fetched",
    bodyError: null
  };
}

function syncResult(messages: ParsedMessage[] = [], uidValidity = "100", lastUid = messages.at(-1)?.uid ?? 0): SyncResult {
  return { messages, remoteStates: messages.map((item) => ({ uid: item.uid, isRead: item.isRead, isStarred: false })), lastUid, uidValidity };
}

function provider(overrides: Partial<MailProvider> = {}): MailProvider {
  const emptyBackfill: BackfillResult = { messages: [], remoteStates: [], nextCursor: null, complete: true, oldestReceivedAt: null };
  return {
    async testConnection(_account: MailAccount) {},
    async initialSync() { return syncResult(); },
    async incrementalSync() { return syncResult(); },
    async reconcile() { return syncResult(); },
    async backfill() { return emptyBackfill; },
    async fetchBody() { return { textBody: "Body", htmlBody: null, snippet: "Body", hasAttachments: false, size: 4, bodyStatus: "fetched", bodyError: null }; },
    async performOperation(_account: MailAccount, _operation: MailOperation) {},
    async createSubscription() { return null; },
    async renewSubscription() { return null; },
    async watch(_account, _onEvent, signal, onReady) {
      onReady?.();
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
    ...overrides
  };
}

test("coalesces duplicate and out-of-order account events into one incremental job", async () => {
  const context = fixture();
  context.database.commitSync(context.account.id, syncResult([], "100", 10));
  let calls = 0;
  const service = new SyncService(context.database, provider({ async incrementalSync() { calls += 1; return syncResult([message(11)], "100", 11); } }), 100, 1024);
  service.triggerAccount(context.account.id, "event-2");
  service.triggerAccount(context.account.id, "event-1");
  service.triggerAccount(context.account.id, "event-3");
  assert.equal(context.database.countJobs(context.account.id, "incremental"), 1);
  assert.equal(await new MailWorker(context.database, service, 5000).runOnce(), true);
  assert.equal(calls, 1);
  assert.equal(context.database.listMessages({ view: "all", limit: 10, offset: 0 }).total, 1);
  assert.equal(context.database.countJobs(context.account.id), 0);
  context.close();
});

test("serializes concurrent synchronization for the same account", async () => {
  const context = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const service = new SyncService(context.database, provider({
    async initialSync() { calls += 1; await gate; return syncResult(); }
  }), 100, 1024);
  const first = service.syncAccount(context.account.id);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(() => service.syncAccount(context.account.id), /正在同步/);
  release();
  await first;
  assert.equal(calls, 1);
  context.close();
});

test("reclaims account and job leases after a worker crash", async () => {
  const context = fixture();
  assert.equal(context.database.acquireAccountLease(context.account.id, "worker-a", 5), true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(context.database.acquireAccountLease(context.account.id, "worker-b", 5000), true);
  context.database.releaseAccountLease(context.account.id, "worker-b");

  context.database.enqueueJob(context.account.id, "initial", 1, "crash-test");
  const firstClaim = context.database.claimNextJob("worker-a", 5);
  assert.ok(firstClaim);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const recoveredClaim = context.database.claimNextJob("worker-b", 5000);
  assert.equal(recoveredClaim?.id, firstClaim.id);
  context.database.completeJob(recoveredClaim!.id, "worker-b");
  assert.equal(context.database.countJobs(context.account.id), 0);
  context.close();
});

test("rolls back a partial batch and cursor advancement, then retries idempotently", () => {
  const context = fixture();
  const invalidMessage = { ...message(2), receivedAt: null } as unknown as ParsedMessage;
  assert.throws(() => context.database.commitSync(context.account.id, syncResult([message(1), invalidMessage], "100", 2)), /NOT NULL/);
  assert.equal(context.database.listMessages({ view: "all", limit: 10, offset: 0 }).total, 0);
  assert.equal(context.database.getAccount(context.account.id)?.lastUid, 0);
  context.database.commitSync(context.account.id, syncResult([message(1), message(2)], "100", 2));
  context.database.commitSync(context.account.id, syncResult([message(1), message(2)], "100", 2));
  assert.equal(context.database.listMessages({ view: "all", limit: 10, offset: 0 }).total, 2);
  assert.equal(context.database.getAccount(context.account.id)?.lastUid, 2);
  context.close();
});

test("recovers an invalid incremental cursor with a scoped initial sync", async () => {
  const context = fixture();
  context.database.commitSync(context.account.id, syncResult([], "100", 10));
  let recoveryCalls = 0;
  const cursorError = Object.assign(new Error("cursor invalid"), { code: "CURSOR_INVALID" });
  const service = new SyncService(context.database, provider({
    async incrementalSync() { throw cursorError; },
    async initialSync() { recoveryCalls += 1; return syncResult([message(20, "200")], "200", 20); }
  }), 100, 1024);
  const result = await service.syncAccount(context.account.id);
  assert.equal(result.mailboxReset, true);
  assert.equal(recoveryCalls, 1);
  assert.equal(context.database.getAccount(context.account.id)?.uidValidity, "200");
  context.close();
});

test("retries provider rate limits with backoff and marks authentication failures for reauthorization", async () => {
  const rateContext = fixture();
  let calls = 0;
  const delays: number[] = [];
  const rateError = Object.assign(new Error("too many requests"), { status: 429 });
  const rateService = new SyncService(rateContext.database, provider({
    async initialSync() { calls += 1; if (calls === 1) throw rateError; return syncResult(); }
  }), 100, 1024, { maxAttempts: 2, sleep: async (delay) => { delays.push(delay); }, random: () => 0 });
  await rateService.syncAccount(rateContext.account.id);
  assert.equal(calls, 2);
  assert.deepEqual(delays, [750]);
  rateContext.close();

  const authContext = fixture();
  const authError = Object.assign(new Error("authentication failed"), { status: 401 });
  const authService = new SyncService(authContext.database, provider({ async initialSync() { throw authError; } }), 100, 1024);
  await assert.rejects(() => authService.syncAccount(authContext.account.id), /authentication failed/);
  assert.equal(authContext.database.getAccount(authContext.account.id)?.syncState, "reauth_required");
  authContext.close();
});

test("uses tombstones for provider and local deletion without physical row loss", () => {
  const context = fixture();
  context.database.commitSync(context.account.id, syncResult([message(1)], "100", 1));
  context.database.commitSync(context.account.id, { ...syncResult([], "100", 1), reconcileWindow: { minUid: 1, presentUids: [] } });
  assert.equal(context.database.getMessage(1), null);
  assert.deepEqual(context.database.getMessageDeletionState(1), { providerDeleted: true, localDeleted: false, deletedAt: context.database.getMessageDeletionState(1)?.deletedAt ?? null });
  assert.ok(context.database.getMessageDeletionState(1)?.deletedAt);

  context.database.commitSync(context.account.id, syncResult([message(1)], "100", 1));
  assert.equal(context.database.deleteMessage(1), true);
  assert.equal(context.database.getMessage(1), null);
  assert.equal(context.database.getMessageDeletionState(1)?.localDeleted, true);
  context.database.commitSync(context.account.id, syncResult([message(1)], "100", 1));
  assert.equal(context.database.getMessage(1), null);
  context.close();
});

test("retries a durable optimistic write operation and succeeds", async () => {
  const context = fixture();
  context.database.commitSync(context.account.id, syncResult([message(1)], "100", 1));
  context.database.updateMessages([1], { isRead: true });
  let calls = 0;
  const transient = Object.assign(new Error("network timeout"), { code: "ETIMEDOUT" });
  const service = new SyncService(context.database, provider({
    async performOperation() { calls += 1; if (calls === 1) throw transient; }
  }), 100, 1024, { maxAttempts: 1, random: () => 0 });
  const worker = new MailWorker(context.database, service, 5000);
  assert.equal(await worker.runOnce(), false);
  assert.equal(context.database.getOperationState(1)?.status, "pending");
  context.database.enqueueJob(context.account.id, "operation", 0, "operation_resume", new Date(), 5, true);
  assert.equal(await worker.runOnce(), false);
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.equal(await worker.runOnce(), true);
  assert.equal(calls, 2);
  assert.equal(context.database.getOperationState(1)?.status, "success");
  assert.equal(context.database.countJobs(context.account.id, "operation"), 0);
  context.close();
});

test("resumes paged backfill after restart without duplicating messages", async () => {
  const context = fixture();
  context.database.commitSync(context.account.id, { ...syncResult([message(10)], "100", 10), backfillCursor: 9 });
  let pages = 0;
  const service = new SyncService(context.database, provider({
    async backfill() {
      pages += 1;
      return pages === 1
        ? { messages: [message(8), message(9)], remoteStates: [], nextCursor: 7, complete: false, oldestReceivedAt: message(8).receivedAt }
        : { messages: [message(7), message(8)], remoteStates: [], nextCursor: null, complete: true, oldestReceivedAt: message(7).receivedAt };
    }
  }), 100, 1024);
  await service.backfillAccount(context.account.id);
  assert.equal(context.database.getAccount(context.account.id)?.backfillCursor, 7);
  await service.backfillAccount(context.account.id);
  assert.equal(context.database.getAccount(context.account.id)?.backfillStatus, "complete");
  assert.equal(context.database.listMessages({ view: "all", limit: 20, offset: 0 }).total, 4);
  context.close();
});

test("debounces IMAP IDLE events and stops watchers for disabled accounts", async () => {
  const context = fixture();
  let emit: ((reason: "exists" | "expunge" | "flags") => void) | null = null;
  const watchProvider = provider({
    async watch(_account, onEvent, signal, onReady) {
      emit = onEvent;
      onReady?.();
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    }
  });
  const service = new SyncService(context.database, watchProvider, 100, 1024);
  const idle = new ImapIdleService(context.database, service, watchProvider, {
    scanIntervalMs: 10_000,
    debounceMs: 5,
    reconnectMaxMs: 100,
    startupConcurrency: 1
  });
  idle.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(idle.activeCount, 1);
  emit!("exists");
  emit!("flags");
  emit!("expunge");
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(context.database.countJobs(context.account.id, "initial"), 1);
  context.database.setAccountEnabled(context.account.id, false);
  idle.refresh();
  assert.equal(idle.activeCount, 0);
  await idle.stop();
  context.close();
});

test("limits concurrent requests independently per provider", async () => {
  const context = fixture();
  context.database.createAccount({
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
  let active = 0;
  let maxActive = 0;
  const service = new SyncService(context.database, provider({
    async initialSync() {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return syncResult();
    }
  }), 100, 1024, { providerConcurrency: 1 });
  const result = await service.syncAll();
  assert.equal(result.succeeded.length, 2);
  assert.equal(maxActive, 1);
  context.close();
});

test("does not multiply provider retries inside a durable job attempt", async () => {
  const context = fixture();
  context.database.commitSync(context.account.id, syncResult([], "100", 10));
  let calls = 0;
  const rateError = Object.assign(new Error("too many requests"), { status: 429 });
  const service = new SyncService(context.database, provider({
    async incrementalSync() { calls += 1; throw rateError; }
  }), 100, 1024, { maxAttempts: 5, sleep: async () => undefined });
  context.database.enqueueJob(context.account.id, "incremental", 1, "rate-limit-test");
  assert.equal(await new MailWorker(context.database, service, 5000).runOnce(), false);
  assert.equal(calls, 1);
  assert.equal(context.database.countJobs(context.account.id, "incremental"), 1);
  context.close();
});

test("drops provider work waiting on concurrency when the account is disabled", async () => {
  const context = fixture();
  const second = context.database.createAccount({
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
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const firstStarted = new Promise<void>((resolve) => { started = resolve; });
  const calls: number[] = [];
  const service = new SyncService(context.database, provider({
    async initialSync(account) {
      calls.push(account.id);
      if (calls.length === 1) {
        started();
        await gate;
      }
      return syncResult();
    }
  }), 100, 1024, { providerConcurrency: 1 });
  const syncing = service.syncAll();
  await firstStarted;
  const waitingId = calls[0] === context.account.id ? second.id : context.account.id;
  context.database.setAccountEnabled(waitingId, false);
  release();
  const result = await syncing;
  assert.equal(calls.length, 1);
  assert.equal(result.succeeded.length, 1);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0]!.error, /已停用/);
  context.close();
});

test("returns an aborted in-flight job to the durable queue during shutdown", async () => {
  const context = fixture();
  context.database.commitSync(context.account.id, syncResult([], "100", 10));
  let started!: () => void;
  const providerStarted = new Promise<void>((resolve) => { started = resolve; });
  const service = new SyncService(context.database, provider({
    async incrementalSync(_account, _limit, signal) {
      started();
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("operation was aborted")), { once: true });
      });
      return syncResult();
    }
  }), 100, 1024);
  context.database.enqueueJob(context.account.id, "incremental", 1, "shutdown-test");
  const worker = new MailWorker(context.database, service, 5000);
  const running = worker.runOnce();
  await providerStarted;
  service.stop();
  assert.equal(await running, false);
  assert.equal(context.database.countJobs(context.account.id, "incremental"), 1);
  context.close();
});
