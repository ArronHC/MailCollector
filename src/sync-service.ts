import crypto from "node:crypto";
import type { MailDatabase, MailJobType } from "./database.js";
import { classifyProviderError, DeferredJobError, retryDelayMs } from "./provider-errors.js";
import { ProviderConcurrencyLimiter } from "./provider-limiter.js";
import type { MailProvider, MailSyncer } from "./types.js";

type SyncServiceOptions = {
  backfillPageSize?: number;
  reconcileLimit?: number;
  leaseMs?: number;
  maxAttempts?: number;
  activeReconcileMinutes?: number;
  normalReconcileMinutes?: number;
  inactiveReconcileMinutes?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  providerConcurrency?: number;
  bodyPrefetchPerAccount?: number;
  bodyPrefetchPerDrain?: number;
};

export class SyncService {
  readonly syncingIds = new Set<number>();
  private readonly ownerPrefix = `${process.pid}:${crypto.randomUUID()}`;
  private readonly backfillPageSize: number;
  private readonly reconcileLimit: number;
  private readonly leaseMs: number;
  private readonly maxAttempts: number;
  private readonly activeReconcileMinutes: number;
  private readonly normalReconcileMinutes: number;
  private readonly inactiveReconcileMinutes: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly random: () => number;
  private readonly providerLimiter: ProviderConcurrencyLimiter;
  private readonly bodyPrefetchPerAccount: number;
  private readonly bodyPrefetchPerDrain: number;
  private readonly stopController = new AbortController();
  private stopped = false;

  get isStopping(): boolean {
    return this.stopped;
  }

  constructor(
    private readonly database: MailDatabase,
    private readonly provider: MailProvider | MailSyncer,
    private readonly initialLimit: number,
    private readonly maxMessageBytes: number,
    options: SyncServiceOptions = {}
  ) {
    this.backfillPageSize = options.backfillPageSize ?? 100;
    this.reconcileLimit = options.reconcileLimit ?? 500;
    this.leaseMs = options.leaseMs ?? 300_000;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.activeReconcileMinutes = options.activeReconcileMinutes ?? 30;
    this.normalReconcileMinutes = options.normalReconcileMinutes ?? 180;
    this.inactiveReconcileMinutes = options.inactiveReconcileMinutes ?? 720;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.random = options.random ?? Math.random;
    this.providerLimiter = new ProviderConcurrencyLimiter(options.providerConcurrency ?? 3);
    this.bodyPrefetchPerAccount = options.bodyPrefetchPerAccount ?? 10;
    this.bodyPrefetchPerDrain = options.bodyPrefetchPerDrain ?? 3;
  }

  async syncAccount(id: number, requestedType?: "initial" | "incremental" | "reconcile", jobId?: number): Promise<{ inserted: number; mailboxReset: boolean }> {
    const account = this.database.getAccount(id);
    if (!account) throw new Error("邮箱不存在");
    if (!account.enabled) throw new Error("邮箱已停用");
    const type = requestedType ?? (account.uidValidity === null ? "initial" : "incremental");
    const owner = `${this.ownerPrefix}:sync:${jobId ?? crypto.randomUUID()}`;
    if (!this.database.acquireAccountLease(id, owner, this.leaseMs)) throw new Error("该邮箱正在同步");
    const stopHeartbeat = this.startAccountHeartbeat(id, owner);

    this.syncingIds.add(id);
    const startedAt = Date.now();
    this.database.markSyncStarted(id, type === "initial" ? "initial_sync" : "syncing");
    this.log("mail_sync_started", { account_id: id, provider: account.provider, sync_job_id: jobId ?? null, sync_type: type });
    try {
      let result;
      try {
        result = await this.providerRequest(async () => {
          if ("initialSync" in this.provider) {
            if (type === "initial") return this.provider.initialSync(account, this.initialLimit, this.stopController.signal);
            if (type === "reconcile") return this.provider.reconcile(account, this.reconcileLimit, this.stopController.signal);
            return this.provider.incrementalSync(account, this.reconcileLimit, this.stopController.signal);
          }
          return this.provider.sync(account, this.initialLimit, this.maxMessageBytes);
        }, { accountId: id, provider: account.provider, jobId });
      } catch (error) {
        const classified = classifyProviderError(error);
        if (type === "initial" || classified.kind !== "cursor_invalid" || !("initialSync" in this.provider)) throw error;
        this.log("cursor_invalid", { account_id: id, provider: account.provider, sync_job_id: jobId ?? null });
        result = await this.providerRequest(() => (this.provider as MailProvider).initialSync(account, this.initialLimit, this.stopController.signal), { accountId: id, provider: account.provider, jobId });
      }
      const committed = this.database.commitSync(id, result, owner);
      if (result.backfillCursor !== undefined && result.backfillCursor !== null) this.database.enqueueJob(id, "backfill", 4, "progressive_initial_sync");
      if (type === "reconcile") this.database.markReconciled(id, this.nextReconcileAt(id));
      this.log("mail_sync_completed", {
        account_id: id,
        provider: account.provider,
        sync_job_id: jobId ?? null,
        sync_type: type,
        webhook_to_sync_latency: account.lastEventAt ? Math.max(0, startedAt - Date.parse(account.lastEventAt)) : null,
        mail_sync_duration: Date.now() - startedAt,
        mail_sync_changes_count: result.messages.length,
        inserted: committed.inserted,
        mailbox_reset: committed.mailboxReset
      });
      return committed;
    } catch (error) {
      const classified = classifyProviderError(error);
      const latest = this.database.getAccount(id);
      if (latest?.enabled && !this.stopped) {
        if (classified.kind === "reauth_required" || classified.kind === "permission") this.database.markReauthRequired(id, classified.message);
        else this.database.markSyncError(id, classified.message);
      }
      this.log("mail_sync_failed", { account_id: id, provider: account.provider, sync_job_id: jobId ?? null, sync_type: type, error_kind: classified.kind, error: classified.message });
      throw error;
    } finally {
      this.syncingIds.delete(id);
      stopHeartbeat();
      this.database.releaseAccountLease(id, owner);
    }
  }

  async backfillAccount(id: number, jobId?: number): Promise<{ inserted: number; complete: boolean }> {
    const account = this.database.getAccount(id);
    if (!account) throw new Error("邮箱不存在");
    if (!account.enabled) throw new Error("邮箱已停用");
    if (account.backfillCursor === null) return { inserted: 0, complete: true };
    const owner = `${this.ownerPrefix}:backfill:${jobId ?? crypto.randomUUID()}`;
    if (!this.database.acquireAccountLease(id, owner, this.leaseMs)) throw new Error("该邮箱正在同步");
    const stopHeartbeat = this.startAccountHeartbeat(id, owner);
    this.syncingIds.add(id);
    this.database.markSyncStarted(id, "backfilling");
    try {
      if (!("backfill" in this.provider)) throw new Error("当前 Provider 不支持历史回填");
      const provider = this.provider as MailProvider;
      const result = await this.providerRequest(() => provider.backfill(account, account.backfillCursor!, this.backfillPageSize, this.stopController.signal), { accountId: id, provider: account.provider, jobId });
      const committed = this.database.commitBackfill(id, result, owner);
      this.log("backfill_progress", { account_id: id, provider: account.provider, sync_job_id: jobId ?? null, inserted: committed.inserted, next_cursor: result.nextCursor, complete: result.complete });
      if (!result.complete) this.database.enqueueJob(id, "backfill", 4, "backfill_continue", new Date(Date.now() + 1000));
      return committed;
    } catch (error) {
      const classified = classifyProviderError(error);
      if (classified.kind === "cursor_invalid") {
        this.database.enqueueJob(id, "initial", 1, "backfill_cursor_recovery");
        this.log("cursor_invalid", { account_id: id, provider: account.provider, sync_job_id: jobId ?? null });
      }
      if (this.database.getAccount(id)?.enabled && !this.stopped) this.database.markSyncError(id, classified.message);
      throw error;
    } finally {
      this.syncingIds.delete(id);
      stopHeartbeat();
      this.database.releaseAccountLease(id, owner);
    }
  }

  async fetchMessageBody(messageId: number): Promise<boolean> {
    this.database.reclaimStaleBodyFetches(new Date(Date.now() - this.leaseMs).toISOString());
    const reference = this.database.getMessageProviderRef(messageId);
    if (!reference || reference.bodyStatus === "fetched" || reference.bodyStatus === "fetching" || (reference.bodyStatus === "failed" && !reference.bodyRetryable)) return false;
    const account = this.database.getAccount(reference.accountId);
    if (!account || !account.enabled) return false;
    if (reference.size > this.maxMessageBytes) {
      this.database.markBodyFailed(messageId, `邮件大小 ${reference.size} 字节，超过限制 ${this.maxMessageBytes} 字节`, false);
      return false;
    }
    const owner = `${this.ownerPrefix}:body:${messageId}`;
    if (!this.database.acquireAccountLease(account.id, owner, this.leaseMs)) return false;
    const stopHeartbeat = this.startAccountHeartbeat(account.id, owner);
    if (!this.database.markBodyFetching(messageId)) {
      stopHeartbeat();
      this.database.releaseAccountLease(account.id, owner);
      return false;
    }
    try {
      if (!("fetchBody" in this.provider)) throw new Error("当前 Provider 不支持按需正文获取");
      const provider = this.provider as MailProvider;
      if (!this.database.hasAccountLease(account.id, owner)) throw new Error("账号同步租约已失效");
      const body = await this.providerRequest(() => provider.fetchBody(account, reference.uid, reference.uidValidity, this.maxMessageBytes, this.stopController.signal), { accountId: account.id, provider: account.provider });
      this.database.saveMessageBody(messageId, body, owner);
      return true;
    } catch (error) {
      const classified = classifyProviderError(error);
      if (classified.kind === "cursor_invalid") {
        this.database.markBodyFailed(messageId, classified.message, false, owner);
        this.database.enqueueJob(account.id, "initial", 1, "body_cursor_recovery");
      } else {
        this.database.markBodyFailed(messageId, classified.message, true, owner);
      }
      throw error;
    } finally {
      stopHeartbeat();
      this.database.releaseAccountLease(account.id, owner);
    }
  }

  async prefetchRecentBodies(): Promise<number> {
    if (this.stopped || this.bodyPrefetchPerAccount <= 0 || this.bodyPrefetchPerDrain <= 0) return 0;
    const ids = this.database.listPendingBodyFetchIds(this.bodyPrefetchPerAccount, this.bodyPrefetchPerDrain, this.maxMessageBytes);
    let fetched = 0;
    for (const id of ids) {
      if (this.stopped) break;
      try {
        if (await this.fetchMessageBody(id)) fetched += 1;
      } catch {
        // 单个正文获取失败不阻塞后续预取
      }
    }
    return fetched;
  }

  async processOperation(accountId: number, jobId?: number): Promise<void> {
    const account = this.database.getAccount(accountId);
    if (!account) return;
    const owner = `${this.ownerPrefix}:operation:${jobId ?? crypto.randomUUID()}`;
    if (!this.database.acquireAccountLease(accountId, owner, this.leaseMs)) throw new Error("该邮箱正在同步");
    const stopAccountHeartbeat = this.startAccountHeartbeat(accountId, owner);
    try {
      const operation = this.database.claimNextOperation(accountId, owner, this.leaseMs);
      if (!operation) return;
      const operationHeartbeat = setInterval(() => this.database.renewOperationLease(operation.id, owner, this.leaseMs), Math.max(1000, Math.floor(this.leaseMs / 3)));
      operationHeartbeat.unref();
      try {
        if (!("performOperation" in this.provider)) throw new Error("当前 Provider 不支持远端写操作");
        const provider = this.provider as MailProvider;
        if (!this.database.hasAccountLease(accountId, owner)) throw new Error("账号同步租约已失效");
        await this.providerRequest(() => provider.performOperation(account, operation, this.stopController.signal), { accountId, provider: account.provider, jobId });
        if (!this.database.completeOperation(operation.id, owner)) {
          this.database.enqueueCorrectiveOperation(operation.messageId, operation.operation === "mark_read" || operation.operation === "mark_unread" ? "read" : "star");
          throw new Error("账号同步租约已失效，已安排状态校正");
        }
      } catch (error) {
        const classified = classifyProviderError(error);
        const correctiveScheduled = error instanceof Error && error.message.includes("已安排状态校正");
        const accountDisabled = !this.database.getAccount(accountId)?.enabled;
        const retryAt = correctiveScheduled ? null
          : accountDisabled || this.stopped ? new Date()
          : classified.kind !== "cursor_invalid" && classified.retryable && operation.attempts < operation.maxAttempts
          ? new Date(Date.now() + retryDelayMs(operation.attempts, classified.retryAfterMs, this.random))
          : null;
        this.database.failOperation(operation.id, owner, classified.message, retryAt);
        this.log("operation_failed", { account_id: accountId, provider: account.provider, sync_job_id: jobId ?? null, operation_id: operation.id, operation: operation.operation, retry_at: retryAt?.toISOString() ?? null, error: classified.message });
        if (classified.kind === "cursor_invalid") this.database.enqueueJob(accountId, "initial", 1, "operation_cursor_recovery");
        if (correctiveScheduled) throw new DeferredJobError(classified.message, new Date());
        if (retryAt) throw new DeferredJobError(classified.message, retryAt);
        throw error;
      } finally {
        clearInterval(operationHeartbeat);
      }
      if (this.database.hasPendingOperations(accountId)) this.database.enqueueJob(accountId, "operation", 0, "operation_continue");
    } finally {
      stopAccountHeartbeat();
      this.database.releaseAccountLease(accountId, owner);
    }
  }

  triggerAccount(id: number, reason = "provider_event"): void {
    const account = this.database.getAccount(id);
    if (!account || !account.enabled) return;
    this.database.recordSyncEvent(id);
    this.database.enqueueJob(id, account.uidValidity === null ? "initial" : "incremental", 1, reason);
    this.log("webhook_received", { account_id: id, provider: account.provider, sync_job_id: null, reason });
  }

  scheduleDueAccounts(): void {
    const now = Date.now();
    for (const account of this.database.listAccounts()) {
      if (!account.enabled || account.syncState === "reauth_required") continue;
      const recoveryAt = new Date(now + (account.syncState === "error" ? this.normalReconcileMinutes * 60_000 : 0));
      if (account.uidValidity === null) {
        this.database.enqueueJob(account.id, "initial", 1, "initial_sync", recoveryAt, 5, true, true);
      } else {
        if (!account.nextSyncAt || Date.parse(account.nextSyncAt) <= now) this.database.enqueueJob(account.id, "reconcile", 3, "periodic_reconciliation", recoveryAt, 5, true, true);
        if (account.backfillStatus === "pending" && account.backfillCursor === null) this.database.enqueueJob(account.id, "initial", 4, "backfill_discovery", recoveryAt, 5, true, true);
        else if (account.backfillCursor !== null && account.backfillStatus !== "complete") this.database.enqueueJob(account.id, "backfill", 4, "backfill_resume", recoveryAt, 5, true, true);
      }
      if (this.database.hasPendingOperations(account.id)) this.database.enqueueJob(account.id, "operation", 0, "operation_resume", new Date(), 5, true);
    }
  }

  async syncAll(): Promise<{ succeeded: Array<{ accountId: number; inserted: number; mailboxReset: boolean }>; failed: Array<{ accountId: number; error: string }> }> {
    const accounts = this.database.listAccounts().filter((account) => account.enabled);
    const results = await Promise.all(accounts.map(async (account) => {
      try {
        return { ok: true as const, accountId: account.id, result: await this.syncAccount(account.id) };
      } catch (error) {
        return { ok: false as const, accountId: account.id, error: error instanceof Error ? error.message : String(error) };
      }
    }));
    return {
      succeeded: results.filter((item): item is Extract<typeof item, { ok: true }> => item.ok).map((item) => ({ accountId: item.accountId, ...item.result })),
      failed: results.filter((item): item is Extract<typeof item, { ok: false }> => !item.ok).map((item) => ({ accountId: item.accountId, error: item.error }))
    };
  }

  async executeJob(type: MailJobType, accountId: number, jobId: number): Promise<void> {
    if (type === "backfill") await this.backfillAccount(accountId, jobId);
    else if (type === "operation") await this.processOperation(accountId, jobId);
    else await this.syncAccount(accountId, type, jobId);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.stopController.abort();
    this.providerLimiter.close();
  }

  private async providerRequest<T>(
    request: () => Promise<T>,
    context: { accountId: number; provider: string; jobId?: number } = { accountId: 0, provider: "unknown" }
  ): Promise<T> {
    let lastError: unknown;
    const maxAttempts = context.jobId === undefined ? this.maxAttempts : 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        if (this.stopped) throw new Error("邮件同步服务正在关闭");
        const account = context.accountId ? this.database.getAccount(context.accountId) : null;
        const limiterKey = account?.provider === "imap" ? `imap:${account.host.toLowerCase()}` : context.provider;
        return await this.providerLimiter.run(limiterKey, async () => {
          if (this.stopped) throw new Error("邮件同步服务正在关闭");
          const latest = context.accountId ? this.database.getAccount(context.accountId) : null;
          if (context.accountId && (!latest || !latest.enabled)) throw new Error("邮箱已停用");
          return request();
        });
      } catch (error) {
        lastError = error;
        const classified = classifyProviderError(error);
        if (!classified.retryable || classified.kind === "cursor_invalid" || attempt >= maxAttempts) throw error;
        const delay = retryDelayMs(attempt, classified.retryAfterMs, this.random);
        this.log("mail_sync_retry", { account_id: context.accountId, provider: context.provider, sync_job_id: context.jobId ?? null, attempt, delay_ms: delay, error_kind: classified.kind });
        await this.waitForRetry(delay);
      }
    }
    throw lastError;
  }

  private async waitForRetry(milliseconds: number): Promise<void> {
    if (this.stopped) throw new Error("邮件同步服务正在关闭");
    let abort: (() => void) | null = null;
    const stopped = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new Error("邮件同步服务正在关闭"));
      this.stopController.signal.addEventListener("abort", abort, { once: true });
    });
    try {
      await Promise.race([this.sleep(milliseconds), stopped]);
    } finally {
      if (abort) this.stopController.signal.removeEventListener("abort", abort);
    }
  }

  private nextReconcileAt(accountId: number): string {
    const account = this.database.getAccount(accountId);
    const now = Date.now();
    const lastEvent = account?.lastEventAt ? Date.parse(account.lastEventAt) : 0;
    const lastSuccess = account?.lastSuccessfulSyncAt ? Date.parse(account.lastSuccessfulSyncAt) : 0;
    let minutes = now - lastEvent < 60 * 60_000 ? this.activeReconcileMinutes
      : now - lastSuccess < 24 * 60 * 60_000 ? this.normalReconcileMinutes
      : this.inactiveReconcileMinutes;
    if (account?.syncErrorCount) minutes = Math.min(this.inactiveReconcileMinutes, minutes * 2 ** Math.min(3, account.syncErrorCount));
    return new Date(now + minutes * 60_000).toISOString();
  }

  private startAccountHeartbeat(accountId: number, owner: string): () => void {
    const heartbeat = setInterval(() => this.database.renewAccountLease(accountId, owner, this.leaseMs), Math.max(1000, Math.floor(this.leaseMs / 3)));
    heartbeat.unref();
    return () => clearInterval(heartbeat);
  }

  private log(event: string, fields: Record<string, unknown>): void {
    console.log(JSON.stringify({ event, at: new Date().toISOString(), ...fields }));
  }
}
