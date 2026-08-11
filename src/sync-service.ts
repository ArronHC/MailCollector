import type { MailDatabase } from "./database.js";
import type { MailSyncer } from "./types.js";

export class SyncService {
  readonly syncingIds = new Set<number>();

  constructor(
    private readonly database: MailDatabase,
    private readonly syncer: MailSyncer,
    private readonly initialLimit: number,
    private readonly maxMessageBytes: number
  ) {}

  async syncAccount(id: number): Promise<{ inserted: number; mailboxReset: boolean }> {
    const account = this.database.getAccount(id);
    if (!account) throw new Error("邮箱不存在");
    if (!account.enabled) throw new Error("邮箱已停用");
    if (this.syncingIds.has(id)) throw new Error("该邮箱正在同步");

    this.syncingIds.add(id);
    try {
      const result = await this.syncer.sync(account, this.initialLimit, this.maxMessageBytes);
      return this.database.commitSync(id, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.database.markSyncError(id, message);
      throw error;
    } finally {
      this.syncingIds.delete(id);
    }
  }

  async syncAll(): Promise<{ succeeded: Array<{ accountId: number; inserted: number; mailboxReset: boolean }>; failed: Array<{ accountId: number; error: string }> }> {
    const accounts = this.database.listAccounts().filter((account) => account.enabled);
    const succeeded: Array<{ accountId: number; inserted: number; mailboxReset: boolean }> = [];
    const failed: Array<{ accountId: number; error: string }> = [];
    for (const account of accounts) {
      try {
        succeeded.push({ accountId: account.id, ...await this.syncAccount(account.id) });
      } catch (error) {
        failed.push({ accountId: account.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { succeeded, failed };
  }
}
