import type { MailProviderKind } from "./types.js";

export const providers = [
  { id: "gmail", adapter: "gmail", name: "Gmail", host: "imap.gmail.com", port: 993, secure: true },
  { id: "outlook", adapter: "microsoft", name: "Outlook / Microsoft 365", host: "outlook.office365.com", port: 993, secure: true },
  { id: "icloud", adapter: "imap", name: "iCloud Mail", host: "imap.mail.me.com", port: 993, secure: true },
  { id: "qq", adapter: "imap", name: "QQ 邮箱", host: "imap.qq.com", port: 993, secure: true },
  { id: "163", adapter: "imap", name: "网易 163", host: "imap.163.com", port: 993, secure: true },
  { id: "126", adapter: "imap", name: "网易 126", host: "imap.126.com", port: 993, secure: true },
  { id: "custom", adapter: "imap", name: "其他 IMAP", host: "", port: 993, secure: true }
] as const;

export function inferProvider(host: string): MailProviderKind {
  const normalized = host.trim().toLowerCase();
  if (normalized === "imap.gmail.com") return "gmail";
  if (normalized === "outlook.office365.com") return "microsoft";
  return "imap";
}
