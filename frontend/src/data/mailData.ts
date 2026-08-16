export type MailSource = "gmail" | "outlook" | "qq" | "icloud" | "netease" | "other";
export type MessageFolder = "inbox" | "archive" | "trash" | "spam";
export type MessageKind = "received" | "draft" | "sent";
export type MessageView = MessageFolder | "snoozed" | "sent" | "drafts" | "all";

export interface MailLabel {
  id: number;
  name: string;
  builtIn: boolean;
  messageCount?: number;
}

export interface MailAccount {
  id: number;
  syncId: string;
  syncUpdatedAt: string;
  name: string;
  email: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  mailbox: string;
  enabled: boolean;
  lastSyncAt: string | null;
  lastSuccessfulSyncAt: string | null;
  lastError: string | null;
  status: "ready" | "syncing" | "error" | "disabled" | "degraded" | "reauth_required" | "backfilling";
  messageCount: number;
  unreadCount: number;
}

export interface MailItem {
  id: number;
  accountId: number;
  accountName: string;
  accountEmail: string;
  subject: string;
  fromName: string | null;
  fromAddress: string | null;
  toText: string | null;
  receivedAt: string;
  snippet: string;
  hasAttachments: boolean;
  isRead: boolean;
  isStarred: boolean;
  size: number;
  bodyStatus: "not_fetched" | "fetching" | "fetched" | "failed";
  folder: MessageFolder;
  snoozedUntil: string | null;
  kind: MessageKind;
  labels: MailLabel[];
}

export interface MailDetail extends MailItem {
  messageId: string | null;
  toText: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  ccText: string | null;
  bccText: string | null;
  textBody: string | null;
  htmlBody: string | null;
  bodyError: string | null;
}

export interface MessageActions {
  isRead?: boolean;
  isStarred?: boolean;
  folder?: MessageFolder;
  snoozedUntil?: string | null;
  labels?: number[];
}

export interface DraftContent {
  accountId: number;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
}

export interface MailProvider {
  id: string;
  name: string;
  host: string;
  port: number;
  secure: boolean;
}

export const sourceNames: Record<MailSource, string> = {
  gmail: "Gmail",
  outlook: "Outlook",
  qq: "QQ邮箱",
  icloud: "iCloud",
  netease: "网易邮箱",
  other: "其他邮箱"
};

export function accountSource(account: Pick<MailAccount, "name" | "email" | "host">): MailSource {
  const value = `${account.name} ${account.email} ${account.host}`.toLowerCase();
  if (value.includes("gmail") || value.includes("google")) return "gmail";
  if (value.includes("outlook") || value.includes("hotmail") || value.includes("office365") || value.includes("live.com")) return "outlook";
  if (value.includes("qq.com") || value.includes("qq邮箱")) return "qq";
  if (value.includes("icloud") || value.includes("mail.me.com") || value.includes("@me.com") || value.includes("@mac.com")) return "icloud";
  if (value.includes("163.com") || value.includes("126.com") || value.includes("netease")) return "netease";
  return "other";
}

export function messageSource(mail: Pick<MailItem, "accountName" | "accountEmail">): MailSource {
  return accountSource({ name: mail.accountName, email: mail.accountEmail, host: "" });
}

export function formatListTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "昨天";
  return date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

export function relativeDetailTime(value: string, nowMs = Date.now()): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "";
  const diff = nowMs - timestamp;
  if (diff < 0 || diff >= 86_400_000) return "";
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.max(1, Math.floor(diff / 60_000))} 分钟前`;
  return `${Math.max(1, Math.floor(diff / 3_600_000))} 小时前`;
}

export function formatDetailTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const relative = relativeDetailTime(value);
  return `${date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })}${relative ? `（${relative}）` : ""}`;
}

export function formatLastSync(accounts: Array<{ lastSuccessfulSyncAt: string | null }>): string {
  let latest = 0;
  for (const account of accounts) {
    const value = account.lastSuccessfulSyncAt ? Date.parse(account.lastSuccessfulSyncAt) : 0;
    if (value > latest) latest = value;
  }
  if (!latest) return "尚未同步";
  const date = new Date(latest);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return `今天 ${date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "昨天";
  return date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}
