import { classifyProviderError, retryDelayMs } from "./provider-errors.js";
import { ProviderConcurrencyLimiter } from "./provider-limiter.js";
import type { MailDatabase } from "./database.js";
import type { SyncService } from "./sync-service.js";
import type { MailAccount, MailProvider } from "./types.js";

type Watcher = {
  controller: AbortController;
  fingerprint: string;
  promise: Promise<void>;
};

type IdleServiceOptions = {
  scanIntervalMs: number;
  debounceMs: number;
  reconnectMaxMs: number;
  startupConcurrency: number;
};

export class ImapIdleService {
  private readonly watchers = new Map<number, Watcher>();
  private readonly debounceTimers = new Map<number, NodeJS.Timeout>();
  private scanTimer: NodeJS.Timeout | null = null;
  private stopped = true;
  private readonly startupLimiter: ProviderConcurrencyLimiter;

  constructor(
    private readonly database: MailDatabase,
    private readonly syncService: SyncService,
    private readonly provider: Pick<MailProvider, "watch">,
    private readonly options: IdleServiceOptions
  ) {
    this.startupLimiter = new ProviderConcurrencyLimiter(options.startupConcurrency);
  }

  get activeCount(): number {
    return this.watchers.size;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.refresh();
    this.scanTimer = setInterval(() => this.refresh(), this.options.scanIntervalMs);
    this.scanTimer.unref();
  }

  refresh(): void {
    if (this.stopped) return;
    const desired = new Map(this.database.listAccounts()
      .filter((account) => account.enabled && account.syncState !== "reauth_required")
      .map((account) => [account.id, account]));

    for (const [accountId, watcher] of this.watchers) {
      const account = desired.get(accountId);
      if (!account || watcher.fingerprint !== this.fingerprint(account)) {
        watcher.controller.abort();
        this.watchers.delete(accountId);
      }
    }
    for (const account of desired.values()) {
      if (!this.watchers.has(account.id)) this.startWatcher(account);
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.scanTimer) clearInterval(this.scanTimer);
    this.scanTimer = null;
    for (const [accountId, timer] of this.debounceTimers) {
      clearTimeout(timer);
      this.syncService.triggerAccount(accountId, "imap_idle_shutdown_flush");
    }
    this.debounceTimers.clear();
    this.startupLimiter.close();
    const watchers = [...this.watchers.values()];
    this.watchers.clear();
    for (const watcher of watchers) watcher.controller.abort();
    await Promise.allSettled(watchers.map((watcher) => watcher.promise));
  }

  private startWatcher(account: MailAccount): void {
    const controller = new AbortController();
    const watcher: Watcher = {
      controller,
      fingerprint: this.fingerprint(account),
      promise: Promise.resolve()
    };
    watcher.promise = this.watchLoop(account, controller.signal).finally(() => {
      if (this.watchers.get(account.id) === watcher) this.watchers.delete(account.id);
    });
    this.watchers.set(account.id, watcher);
  }

  private async watchLoop(account: MailAccount, signal: AbortSignal): Promise<void> {
    let attempt = 0;
    while (!signal.aborted && !this.stopped) {
      try {
        let ready!: () => void;
        const connected = new Promise<void>((resolve) => { ready = resolve; });
        let watchPromise!: Promise<void>;
        const limiterKey = account.provider === "imap" ? `imap:${account.host.toLowerCase()}` : account.provider;
        await this.startupLimiter.run(limiterKey, async () => {
          watchPromise = this.provider.watch(account, (reason) => this.queueTrigger(account.id, reason), signal, ready);
          await Promise.race([connected, watchPromise]);
        });
        attempt = 0;
        await watchPromise;
        if (signal.aborted || this.stopped) return;
        throw new Error("IMAP IDLE connection closed");
      } catch (error) {
        if (signal.aborted || this.stopped) return;
        const classified = classifyProviderError(error);
        console.log(JSON.stringify({
          event: "imap_idle_disconnected",
          at: new Date().toISOString(),
          account_id: account.id,
          provider: account.provider,
          error_kind: classified.kind,
          error: classified.message
        }));
        if (classified.kind === "reauth_required" || classified.kind === "permission") {
          this.database.markReauthRequired(account.id, classified.message);
          return;
        }
        attempt += 1;
        const delay = Math.min(this.options.reconnectMaxMs, retryDelayMs(attempt));
        await this.delay(delay, signal);
      }
    }
  }

  private queueTrigger(accountId: number, reason: "exists" | "expunge" | "flags"): void {
    if (this.debounceTimers.has(accountId)) return;
    const timer = setTimeout(() => {
      this.debounceTimers.delete(accountId);
      this.syncService.triggerAccount(accountId, `imap_idle_${reason}`);
    }, this.options.debounceMs);
    timer.unref();
    this.debounceTimers.set(accountId, timer);
  }

  private delay(milliseconds: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, milliseconds);
      timer.unref();
      const abort = () => done();
      signal.addEventListener("abort", abort, { once: true });
      function done() {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        resolve();
      }
    });
  }

  private fingerprint(account: MailAccount): string {
    return [account.host, account.port, account.secure, account.username, account.mailbox, account.encryptedPassword].join("|");
  }
}
