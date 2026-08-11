import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { decryptSecret } from "./crypto.js";
import { assertAllowedMailHost, createMailHostLookup } from "./network-security.js";
import type { MailAccount, MailSyncer, ParsedMessage, SyncResult } from "./types.js";

function addressText(value: unknown): string | null {
  if (!value || typeof value !== "object" || !("text" in value)) return null;
  return String(value.text || "") || null;
}

function firstAddress(value: unknown): { name: string | null; address: string | null } {
  if (!value || typeof value !== "object" || !("value" in value) || !Array.isArray(value.value)) {
    return { name: null, address: null };
  }
  const first = value.value[0];
  return first ? { name: first.name || null, address: first.address || null } : { name: null, address: null };
}

function envelopeAddresses(addresses: Array<{ name?: string; address?: string }> | undefined): string | null {
  if (!addresses?.length) return null;
  return addresses.map((item) => item.name ? `${item.name} <${item.address ?? ""}>` : item.address ?? "").filter(Boolean).join(", ") || null;
}

function placeholder(
  item: Awaited<ReturnType<ImapFlow["fetchOne"]>> & object,
  status: "too_large" | "parse_error",
  error: string
): ParsedMessage {
  const sender = item.envelope?.from?.[0];
  return {
    uid: item.uid,
    messageId: item.envelope?.messageId || null,
    subject: item.envelope?.subject || "(无主题)",
    fromName: sender?.name || null,
    fromAddress: sender?.address || null,
    toText: envelopeAddresses(item.envelope?.to),
    receivedAt: new Date(item.internalDate ?? item.envelope?.date ?? Date.now()).toISOString(),
    textBody: null,
    htmlBody: null,
    snippet: status === "too_large" ? "邮件正文超过本地大小限制，未下载。" : "邮件正文解析失败，已保留邮件信息。",
    hasAttachments: Boolean(item.bodyStructure?.childNodes?.some((node) => node.disposition === "attachment")),
    isRead: item.flags?.has("\\Seen") ?? false,
    size: item.size || 0,
    bodyStatus: status,
    bodyError: error.slice(0, 1000)
  };
}

export class ImapMailSyncer implements MailSyncer {
  constructor(private readonly encryptionKey: Buffer, private readonly allowPrivateMailHosts = false) {}

  async testConnection(account: MailAccount): Promise<void> {
    await assertAllowedMailHost(account.host, this.allowPrivateMailHosts, true);
    const client = this.client(account, 1024 * 1024);
    try {
      await client.connect();
      const lock = await client.getMailboxLock(account.mailbox, { readOnly: true });
      lock.release();
    } finally {
      if (client.usable) await client.logout();
    }
  }

  async sync(account: MailAccount, initialLimit: number, maxMessageBytes: number): Promise<SyncResult> {
    await assertAllowedMailHost(account.host, this.allowPrivateMailHosts, true);
    const client = this.client(account, maxMessageBytes);
    try {
      await client.connect();
      const lock = await client.getMailboxLock(account.mailbox, { readOnly: true });
      try {
        if (!client.mailbox || typeof client.mailbox === "boolean") throw new Error("无法读取邮箱状态");
        const { exists, uidValidity } = client.mailbox;
        const uidValidityText = uidValidity.toString();
        const mailboxReset = account.uidValidity !== null && account.uidValidity !== uidValidityText;
        const previousUid = mailboxReset ? 0 : account.lastUid;
        if (!exists) return { messages: [], readStates: [], lastUid: 0, uidValidity: uidValidityText };

        const flagItems = await client.fetchAll(
          `${Math.max(1, exists - initialLimit + 1)}:*`,
          { uid: true, flags: true },
          { uid: false }
        );
        const readStates = flagItems.map((item) => ({
          uid: item.uid,
          isRead: item.flags?.has("\\Seen") ?? false
        }));

        const range = previousUid > 0
          ? `${previousUid + 1}:*`
          : `${Math.max(1, exists - initialLimit + 1)}:*`;
        const messages: ParsedMessage[] = [];
        let lastUid = previousUid;
        let retainedBytes = 0;
        const maxBatchBytes = Math.max(maxMessageBytes, 25 * 1024 * 1024);

        const items = await client.fetchAll(
          range,
          { uid: true, size: true, envelope: true, internalDate: true, bodyStructure: true, flags: true },
          { uid: previousUid > 0 }
        );
        for (const item of items) {
          if (item.uid <= previousUid) continue;
          if ((item.size || 0) > maxMessageBytes) {
            messages.push(placeholder(item, "too_large", `邮件大小 ${item.size} 字节，超过限制 ${maxMessageBytes} 字节`));
            lastUid = Math.max(lastUid, item.uid);
            continue;
          }
          if (retainedBytes > 0 && retainedBytes + (item.size || 0) > maxBatchBytes) break;
          try {
            const sourceItem = await client.fetchOne(item.uid, { source: true }, { uid: true });
            if (!sourceItem || !sourceItem.source) throw new Error("服务器未返回邮件正文");
            const parsed = await simpleParser(sourceItem.source, {
              skipHtmlToText: true,
              skipTextToHtml: true,
              skipImageLinks: true
            });
            const sender = firstAddress(parsed.from);
            const text = parsed.text?.trim() || null;
            const snippet = (text ?? parsed.subject ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
            messages.push({
              uid: item.uid,
              messageId: parsed.messageId || item.envelope?.messageId || null,
              subject: parsed.subject || item.envelope?.subject || "(无主题)",
              fromName: sender.name,
              fromAddress: sender.address,
              toText: addressText(parsed.to),
              receivedAt: new Date(item.internalDate ?? parsed.date ?? Date.now()).toISOString(),
              textBody: text,
              htmlBody: typeof parsed.html === "string" ? parsed.html : null,
              snippet,
              hasAttachments: parsed.attachments.length > 0,
              isRead: item.flags?.has("\\Seen") ?? false,
              size: item.size || sourceItem.source.length,
              bodyStatus: "complete",
              bodyError: null
            });
            retainedBytes += sourceItem.source.length;
          } catch (error) {
            messages.push(placeholder(item, "parse_error", error instanceof Error ? error.message : String(error)));
          }
          lastUid = Math.max(lastUid, item.uid);
        }
        return { messages, readStates, lastUid, uidValidity: uidValidityText };
      } finally {
        lock.release();
      }
    } finally {
      if (client.usable) await client.logout();
    }
  }

  private client(account: MailAccount, maxMessageBytes: number): ImapFlow {
    return new ImapFlow({
      host: account.host,
      port: account.port,
      secure: account.secure,
      doSTARTTLS: account.secure ? undefined : true,
      auth: {
        user: account.username,
        pass: decryptSecret(account.encryptedPassword, this.encryptionKey)
      },
      logger: false,
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
