import crypto from "node:crypto";
import type { MailDatabase, MailJob } from "./database.js";
import { classifyProviderError, DeferredJobError, retryDelayMs } from "./provider-errors.js";
import type { SyncService } from "./sync-service.js";

export class MailWorker {
  private readonly owner = `${process.pid}:worker:${crypto.randomUUID()}`;
  private drainPromise: Promise<void> | null = null;
  private stopped = false;

  constructor(
    private readonly database: MailDatabase,
    private readonly syncService: SyncService,
    private readonly leaseMs: number,
    private readonly concurrency = 3
  ) {}

  async runOnce(): Promise<boolean> {
    if (this.stopped) return false;
    const job = this.database.claimNextJob(this.owner, this.leaseMs);
    if (!job) return false;
    return this.execute(job);
  }

  async drain(): Promise<void> {
    if (this.stopped) return;
    if (this.drainPromise) return this.drainPromise;
    this.drainPromise = (async () => {
      const jobs: MailJob[] = [];
      for (let index = 0; index < this.concurrency; index += 1) {
        const job = this.database.claimNextJob(this.owner, this.leaseMs);
        if (!job) break;
        jobs.push(job);
      }
      await Promise.all(jobs.map((job) => this.execute(job)));
      await this.syncService.prefetchRecentBodies().catch(() => undefined);
    })().finally(() => { this.drainPromise = null; });
    return this.drainPromise;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.drainPromise;
  }

  private async execute(job: MailJob): Promise<boolean> {
    const heartbeat = setInterval(() => this.database.renewJobLease(job.id, this.owner, this.leaseMs), Math.max(1000, Math.floor(this.leaseMs / 3)));
    heartbeat.unref();
    try {
      await this.syncService.executeJob(job.type, job.accountId, job.id);
      this.database.completeJob(job.id, this.owner);
      return true;
    } catch (error) {
      const classified = classifyProviderError(error);
      const retryAt = this.syncService.isStopping ? new Date()
        : error instanceof DeferredJobError ? error.retryAt
        : classified.retryable && job.attempts < job.maxAttempts
          ? new Date(Date.now() + retryDelayMs(job.attempts, classified.retryAfterMs))
          : null;
      this.database.failJob(job.id, this.owner, classified.message, retryAt);
      return false;
    } finally {
      clearInterval(heartbeat);
    }
  }
}
