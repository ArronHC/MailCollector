export const providers = [
  { id: "gmail", name: "Gmail", host: "imap.gmail.com", port: 993, secure: true },
  { id: "outlook", name: "Outlook / Microsoft 365", host: "outlook.office365.com", port: 993, secure: true },
  { id: "icloud", name: "iCloud Mail", host: "imap.mail.me.com", port: 993, secure: true },
  { id: "qq", name: "QQ 邮箱", host: "imap.qq.com", port: 993, secure: true },
  { id: "163", name: "网易 163", host: "imap.163.com", port: 993, secure: true },
  { id: "126", name: "网易 126", host: "imap.126.com", port: 993, secure: true },
  { id: "custom", name: "其他 IMAP", host: "", port: 993, secure: true }
] as const;
