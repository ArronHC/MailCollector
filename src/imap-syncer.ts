import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { decryptSecret } from "./crypto.js";
import { assertAllowedMailHost, createMailHostLookup } from "./network-security.js";
import type { BackfillResult, MailAccount, MailOperation, MailProvider, ParsedMessage, SyncResult } from "./types.js";

type ImapItem = Awaited<ReturnType<ImapFlow["fetchOne"]>> & object;

function envelopeAddresses(addresses: Array<{ name?: string; address?: string }> | undefined): string | null {
  if (!addresses?.length) return null;
  return addresses.map((item) => item.name ? `${item.name} <${item.address ?? ""}>` : item.address ?? "").filter(Boolean).join(", ") || null;
}

function hasAttachment(node: any): boolean {
  if (!node) return false;
  if (node.disposition === "attachment" || node.dispositionParameters?.filename || node.parameters?.name) return true;
  return Array.isArray(node.childNodes) && node.childNodes.some(hasAttachment);
}

function metadata(item: ImapItem, mailbox: string, uidValidity: string): ParsedMessage {
  const sender = item.envelope?.from?.[0];
  const subject = item.envelope?.subject || "(无主题)";
  return {
    uid: item.uid,
    providerMessageId: `${mailbox}:${uidValidity}:${item.uid}`,
    messageId: item.envelope?.messageId || null,
    subject,
    fromName: sender?.name || null,
    fromAddress: sender?.address || null,
    toText: envelopeAddresses(item.envelope?.to),
    receivedAt: new Date(item.internalDate ?? item.envelope?.date ?? Date.now()).toISOString(),
    textBody: null,
    htmlBody: null,
    snippet: subject.replace(/\s+/g, " ").trim().slice(0, 240),
    hasAttachments: hasAttachment(item.bodyStructure),
    isRead: item.flags?.has("\\Seen") ?? false,
    size: item.size || 0,
    bodyStatus: "not_fetched",
    bodyError: null
  };
}

function remoteState(item: ImapItem): { uid: number; isRead: boolean; isStarred: boolean } {
  return {
    uid: item.uid,
    isRead: item.flags?.has("\\Seen") ?? false,
    isStarred: item.flags?.has("\\Flagged") ?? false
  };
}

export class ImapMailProvider implements MailProvider {
  constructor(private readonly encryptionKey: Buffer, private readonly allowPrivateMailHosts = false) {}

  async testConnection(account: MailAccount): Promise<void> {
    await this.withMailbox(account, true, 1024 * 1024, async () => undefined);
  }

  initialSync(account: MailAccount, initialLimit: number, signal?: AbortSignal): Promise<SyncResult> {
    return this.syncMetadata(account, initialLimit, true, signal);
  }

  incrementalSync(account: MailAccount, reconcileLimit: number, signal?: AbortSignal): Promise<SyncResult> {
    return this.syncMetadata(account, reconcileLimit, false, signal);
  }

  reconcile(account: MailAccount, reconcileLimit: number, signal?: AbortSignal): Promise<SyncResult> {
    return this.syncMetadata(account, reconcileLimit, false, signal);
  }

  async backfill(account: MailAccount, beforeSequence: number, pageSize: number, signal?: AbortSignal): Promise<BackfillResult> {
    return this.withMailbox(account, true, 1024 * 1024, async (client) => {
      if (!client.mailbox || typeof client.mailbox === "boolean") throw new Error("无法读取邮箱状态");
      if (beforeSequence <= 0 || client.mailbox.exists === 0) {
        return { messages: [], remoteStates: [], nextCursor: null, complete: true, oldestReceivedAt: null };
      }
      const uidValidity = client.mailbox.uidValidity.toString();
      if (account.uidValidity && account.uidValidity !== uidValidity) throw new Error("IMAP_UIDVALIDITY_CHANGED");
      const end = Math.min(beforeSequence, client.mailbox.exists);
      const start = Math.max(1, end - pageSize + 1);
      const items = await this.fetchMetadata(client, `${start}:${end}`, false);
      const messages = items.map((item) => metadata(item, account.mailbox, uidValidity));
      return {
        messages,
        remoteStates: items.map(remoteState),
        nextCursor: start > 1 ? start - 1 : null,
        complete: start === 1,
        oldestReceivedAt: messages.length ? messages.reduce((oldest, item) => item.receivedAt < oldest ? item.receivedAt : oldest, messages[0]!.receivedAt) : null
      };
    }, signal);
  }

  async fetchBody(account: MailAccount, uid: number, uidValidity: string, maxMessageBytes: number, signal?: AbortSignal): Promise<Pick<ParsedMessage, "textBody" | "htmlBody" | "snippet" | "hasAttachments" | "size" | "bodyStatus" | "bodyError">> {
    return this.withMailbox(account, true, maxMessageBytes, async (client) => {
      if (!client.mailbox || typeof client.mailbox === "boolean" || client.mailbox.uidValidity.toString() !== uidValidity) throw new Error("IMAP_UIDVALIDITY_CHANGED");
      const item = await client.fetchOne(uid, { source: true, size: true }, { uid: true });
      if (!item || !item.source) throw new Error("服务器未返回邮件正文");
      const size = item.size || item.source.length;
      if (size > maxMessageBytes) {
        return {
          textBody: null,
          htmlBody: null,
          snippet: "邮件正文超过本地大小限制，未下载。",
          hasAttachments: false,
          size,
          bodyStatus: "failed",
          bodyError: `邮件大小 ${size} 字节，超过限制 ${maxMessageBytes} 字节`
        };
      }
      const parsed = await simpleParser(item.source, { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true });
      const textBody = parsed.text?.trim() || null;
      return {
        textBody,
        htmlBody: typeof parsed.html === "string" ? parsed.html : null,
        snippet: (textBody ?? parsed.subject ?? "").replace(/\s+/g, " ").trim().slice(0, 240),
        hasAttachments: parsed.attachments.length > 0,
        size,
        bodyStatus: "fetched",
        bodyError: null
      };
    }, signal);
  }

  async performOperation(account: MailAccount, operation: MailOperation, signal?: AbortSignal): Promise<void> {
    await this.withMailbox(account, false, 1024 * 1024, async (client) => {
      if (!client.mailbox || typeof client.mailbox === "boolean" || client.mailbox.uidValidity.toString() !== operation.uidValidity) throw new Error("IMAP_UIDVALIDITY_CHANGED");
      if (operation.operation === "mark_read") await client.messageFlagsAdd(operation.uid, ["\\Seen"], { uid: true });
      else if (operation.operation === "mark_unread") await client.messageFlagsRemove(operation.uid, ["\\Seen"], { uid: true });
      else if (operation.operation === "star") await client.messageFlagsAdd(operation.uid, ["\\Flagged"], { uid: true });
      else await client.messageFlagsRemove(operation.uid, ["\\Flagged"], { uid: true });
    }, signal);
  }

  async createSubscription(_account: MailAccount): Promise<null> {
    return null;
  }

  async renewSubscription(_account: MailAccount): Promise<null> {
    return null;
  }

  async watch(account: MailAccount, onEvent: (reason: "exists" | "expunge" | "flags") => void, signal: AbortSignal, onReady?: () => void): Promise<void> {
    await assertAllowedMailHost(account.host, this.allowPrivateMailHosts, true);
    const client = this.client(account, 1024 * 1024, true);
    let connectionError: Error | null = null;
    const abort = () => client.close();
    const onError = (error: Error) => { connectionError = error; };
    client.on("error", onError);
    client.on("exists", () => onEvent("exists"));
    client.on("expunge", () => onEvent("expunge"));
    client.on("flags", () => onEvent("flags"));
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (signal.aborted) return;
      await client.connect();
      await client.mailboxOpen(account.mailbox, { readOnly: true });
      console.log(JSON.stringify({ event: "imap_idle_connected", at: new Date().toISOString(), account_id: account.id, provider: account.provider }));
      onReady?.();
      if (signal.aborted) return;
      await new Promise<void>((resolve) => client.once("close", resolve));
      if (!signal.aborted) throw connectionError ?? new Error("IMAP IDLE connection closed");
    } finally {
      signal.removeEventListener("abort", abort);
      client.removeListener("error", onError);
      if (client.usable) await client.logout().catch(() => undefined);
      else client.close();
    }
  }

  private async syncMetadata(account: MailAccount, limit: number, initial: boolean, signal?: AbortSignal): Promise<SyncResult> {
    return this.withMailbox(account, true, 1024 * 1024, async (client) => {
      if (!client.mailbox || typeof client.mailbox === "boolean") throw new Error("无法读取邮箱状态");
      const { exists, uidValidity } = client.mailbox;
      const uidValidityText = uidValidity.toString();
      const mailboxReset = account.uidValidity !== null && account.uidValidity !== uidValidityText;
      const useInitialWindow = initial || mailboxReset || account.uidValidity === null;
      const previousUid = mailboxReset ? 0 : account.lastUid;
      if (!exists) {
        return {
          messages: [],
          remoteStates: [],
          lastUid: mailboxReset ? 0 : previousUid,
          uidValidity: uidValidityText,
          backfillCursor: null,
          reconcileWindow: { minUid: 0, presentUids: [] }
        };
      }

      const recentStart = Math.max(1, exists - limit + 1);
      const recentItems = await this.fetchMetadata(client, `${recentStart}:*`, false);
      const remoteStates = recentItems.map(remoteState);
      const range = useInitialWindow ? `${recentStart}:*` : `${previousUid + 1}:*`;
      const newItems = useInitialWindow ? recentItems : await this.fetchMetadata(client, range, true, limit);
      const messages = newItems.filter((item) => item.uid > previousUid || useInitialWindow).map((item) => metadata(item, account.mailbox, uidValidityText));
      const lastUid = messages.reduce((highest, item) => Math.max(highest, item.uid), previousUid);
      return {
        messages,
        remoteStates,
        lastUid,
        uidValidity: uidValidityText,
        backfillCursor: useInitialWindow ? (recentStart > 1 ? recentStart - 1 : null) : undefined,
        reconcileWindow: recentItems.length ? { minUid: recentStart === 1 ? 0 : Math.min(...recentItems.map((item) => item.uid)), presentUids: recentItems.map((item) => item.uid) } : { minUid: 0, presentUids: [] }
      };
    }, signal);
  }

  private async fetchMetadata(client: ImapFlow, range: string, uid: boolean, limit?: number): Promise<ImapItem[]> {
    const items: ImapItem[] = [];
    for await (const item of client.fetch(
      range,
      { uid: true, size: true, envelope: true, internalDate: true, bodyStructure: true, flags: true },
      { uid }
    )) {
      items.push(item as ImapItem);
      if (limit && items.length >= limit) break;
    }
    return items;
  }

  private async withMailbox<T>(account: MailAccount, readOnly: boolean, maxMessageBytes: number, action: (client: ImapFlow) => Promise<T>, signal?: AbortSignal): Promise<T> {
    await assertAllowedMailHost(account.host, this.allowPrivateMailHosts, true);
    const client = this.client(account, maxMessageBytes);
    const abort = () => client.close();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      if (signal?.aborted) throw new Error("operation was aborted");
      await client.connect();
      if (signal?.aborted) throw new Error("operation was aborted");
      const lock = await client.getMailboxLock(account.mailbox, { readOnly });
      try {
        return await action(client);
      } finally {
        lock.release();
      }
    } finally {
      signal?.removeEventListener("abort", abort);
      if (client.usable) await client.logout();
    }
  }

  private client(account: MailAccount, maxMessageBytes: number, idle = false): ImapFlow {
    return new ImapFlow({
      host: account.host,
      port: account.port,
      secure: account.secure,
      doSTARTTLS: account.secure ? undefined : true,
      auth: { user: account.username, pass: decryptSecret(account.encryptedPassword, this.encryptionKey) },
      logger: false,
      qresync: idle,
      maxIdleTime: idle ? 25 * 60_000 : undefined,
      missingIdleCommand: idle ? "NOOP" : undefined,
      tls: { lookup: createMailHostLookup(this.allowPrivateMailHosts, true) },
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 60_000,
      maxLineLength: 1024 * 1024,
      maxLiteralSize: maxMessageBytes + 1024 * 1024,
      maxResponseSize: maxMessageBytes + 2 * 1024 * 1024
    });
  }
}

// Backward-compatible export for existing imports.
export { ImapMailProvider as ImapMailSyncer };
