import assert from "node:assert/strict";
import test from "node:test";
import { smtpPresetForImapHost } from "../src/smtp-sender.js";

test("derives SMTP settings from supported IMAP hosts without opening a connection", () => {
  assert.deepEqual(smtpPresetForImapHost("imap.gmail.com"), { host: "smtp.gmail.com", port: 465, secure: true });
  assert.deepEqual(smtpPresetForImapHost("OUTLOOK.OFFICE365.COM"), { host: "smtp.office365.com", port: 587, secure: false });
  assert.deepEqual(smtpPresetForImapHost("imap.mail.me.com"), { host: "smtp.mail.me.com", port: 587, secure: false });
  assert.deepEqual(smtpPresetForImapHost("imap.qq.com"), { host: "smtp.qq.com", port: 465, secure: true });
  assert.deepEqual(smtpPresetForImapHost("imap.163.com"), { host: "smtp.163.com", port: 465, secure: true });
  assert.deepEqual(smtpPresetForImapHost("imap.126.com"), { host: "smtp.126.com", port: 465, secure: true });
  assert.throws(() => smtpPresetForImapHost("imap.example.com"), /不支持 IMAP 主机/);
});
