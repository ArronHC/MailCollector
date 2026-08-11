type Waiter = {
  resolve: () => void;
  reject: (error: Error) => void;
};

export class ProviderConcurrencyLimiter {
  private readonly active = new Map<string, number>();
  private readonly waiters = new Map<string, Waiter[]>();
  private closed = false;

  constructor(private readonly maxConcurrency: number) {}

  async run<T>(provider: string, task: () => Promise<T>): Promise<T> {
    await this.acquire(provider);
    try {
      if (this.closed) throw new Error("Provider limiter is closed");
      return await task();
    } finally {
      this.release(provider);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const queue of this.waiters.values()) {
      for (const waiter of queue) waiter.reject(new Error("Provider limiter is closed"));
    }
    this.waiters.clear();
  }

  private acquire(provider: string): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Provider limiter is closed"));
    const active = this.active.get(provider) ?? 0;
    if (active < this.maxConcurrency) {
      this.active.set(provider, active + 1);
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const queue = this.waiters.get(provider) ?? [];
      queue.push({ resolve, reject });
      this.waiters.set(provider, queue);
    });
  }

  private release(provider: string): void {
    const queue = this.waiters.get(provider);
    const next = queue?.shift();
    if (next && !this.closed) {
      if (!queue?.length) this.waiters.delete(provider);
      next.resolve();
      return;
    }
    const active = (this.active.get(provider) ?? 1) - 1;
    if (active > 0) this.active.set(provider, active);
    else this.active.delete(provider);
  }
}
