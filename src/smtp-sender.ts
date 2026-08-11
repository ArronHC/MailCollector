import nodemailer from "nodemailer";
import { decryptSecret } from "./crypto.js";
import type { LocalMessageContent, MailAccount } from "./types.js";

export type SmtpPreset = {
  host: string;
  port: number;
  secure: boolean;
};

const smtpPresets: Record<string, SmtpPreset> = {
  "imap.gmail.com": { host: "smtp.gmail.com", port: 465, secure: true },
  "outlook.office365.com": { host: "smtp.office365.com", port: 587, secure: false },
  "imap.mail.me.com": { host: "smtp.mail.me.com", port: 587, secure: false },
  "imap.qq.com": { host: "smtp.qq.com", port: 465, secure: true },
  "imap.163.com": { host: "smtp.163.com", port: 465, secure: true },
  "imap.126.com": { host: "smtp.126.com", port: 465, secure: true }
};

export function smtpPresetForImapHost(host: string): SmtpPreset {
  const preset = smtpPresets[host.trim().toLowerCase()];
  if (!preset) {
    throw new Error(`不支持 IMAP 主机 ${host} 的 SMTP 发送；请添加明确的 SMTP 映射`);
  }
  return preset;
}

export class SmtpSender {
  constructor(private readonly encryptionKey: Buffer) {}

  async send(account: MailAccount, message: LocalMessageContent): Promise<{ messageId: string | null; sentAt: string }> {
    const preset = smtpPresetForImapHost(account.host);

    const transport = nodemailer.createTransport({
      ...preset,
      requireTLS: !preset.secure,
      auth: {
        user: account.username,
        pass: decryptSecret(account.encryptedPassword, this.encryptionKey)
      },
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 60_000
    });
    const result = await transport.sendMail({
      from: account.name ? { name: account.name, address: account.email } : account.email,
      to: message.to,
      cc: message.cc.length ? message.cc : undefined,
      bcc: message.bcc.length ? message.bcc : undefined,
      subject: message.subject,
      text: message.body
    });
    return { messageId: result.messageId || null, sentAt: new Date().toISOString() };
  }
}
