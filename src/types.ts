export interface MailAccount {
  id: number;
  name: string;
  email: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  encryptedPassword: string;
  mailbox: string;
  enabled: boolean;
  uidValidity: string | null;
  lastUid: number;
  lastSyncAt: string | null;
  lastError: string | null;
  createdAt: string;
}

export interface PublicMailAccount extends Omit<MailAccount, "encryptedPassword"> {
  status: "ready" | "syncing" | "error" | "disabled";
  messageCount: number;
  unreadCount: number;
}

export interface ParsedMessage {
  uid: number;
  messageId: string | null;
  subject: string;
  fromName: string | null;
  fromAddress: string | null;
  toText: string | null;
  receivedAt: string;
  textBody: string | null;
  htmlBody: string | null;
  snippet: string;
  hasAttachments: boolean;
  isRead: boolean;
  size: number;
  bodyStatus: "complete" | "too_large" | "parse_error";
  bodyError: string | null;
}

export type MessageFolder = "inbox" | "archive" | "trash" | "spam";
export type MessageKind = "received" | "draft" | "sent";
export type MessageView = MessageFolder | "snoozed" | "sent" | "drafts" | "all";

export interface MessageLabel {
  id: number;
  name: string;
  builtIn: boolean;
}

export interface MessageActions {
  isRead?: boolean;
  isStarred?: boolean;
  folder?: MessageFolder;
  snoozedUntil?: string | null;
  labels?: number[];
}

export interface LocalMessageContent {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
}

export interface DraftInput extends LocalMessageContent {
  accountId: number;
}

export interface SyncResult {
  messages: ParsedMessage[];
  readStates: Array<{ uid: number; isRead: boolean }>;
  lastUid: number;
  uidValidity: string;
}

export interface MailSyncer {
  testConnection(account: MailAccount): Promise<void>;
  sync(account: MailAccount, initialLimit: number, maxMessageBytes: number): Promise<SyncResult>;
}
