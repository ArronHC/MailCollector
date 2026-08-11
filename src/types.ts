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
  provider: MailProviderKind;
  enabled: boolean;
  uidValidity: string | null;
  lastUid: number;
  lastSyncAt: string | null;
  lastSuccessfulSyncAt: string | null;
  lastReconcileAt: string | null;
  lastEventAt: string | null;
  lastError: string | null;
  syncErrorCount: number;
  syncState: AccountSyncState;
  nextSyncAt: string | null;
  backfillCursor: number | null;
  backfillStatus: BackfillStatus;
  createdAt: string;
}

export interface PublicMailAccount extends Omit<MailAccount, "encryptedPassword"> {
  status: "ready" | "syncing" | "error" | "disabled" | "degraded" | "reauth_required" | "backfilling";
  messageCount: number;
  unreadCount: number;
}

export interface ParsedMessage {
  uid: number;
  providerMessageId: string;
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
  bodyStatus: BodySyncStatus;
  bodyError: string | null;
}

export type MessageFolder = "inbox" | "archive" | "trash" | "spam";
export type MessageKind = "received" | "draft" | "sent";
export type MessageView = MessageFolder | "snoozed" | "sent" | "drafts" | "all";
export type MailProviderKind = "gmail" | "microsoft" | "imap";
export type AccountSyncState = "idle" | "initial_sync" | "syncing" | "backfilling" | "degraded" | "reauth_required" | "error";
export type BackfillStatus = "pending" | "running" | "complete" | "failed";
export type BodySyncStatus = "not_fetched" | "fetching" | "fetched" | "failed";

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
  remoteStates: Array<{ uid: number; isRead: boolean; isStarred: boolean }>;
  lastUid: number;
  uidValidity: string;
  backfillCursor?: number | null;
  reconcileWindow?: { minUid: number; presentUids: number[] };
}

export interface BackfillResult {
  messages: ParsedMessage[];
  remoteStates: Array<{ uid: number; isRead: boolean; isStarred: boolean }>;
  nextCursor: number | null;
  complete: boolean;
  oldestReceivedAt: string | null;
}

export type MailOperationType = "mark_read" | "mark_unread" | "star" | "unstar";

export interface MailOperation {
  id: number;
  accountId: number;
  messageId: number;
  uid: number;
  uidValidity: string;
  operation: MailOperationType;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
}

export interface MailProvider {
  testConnection(account: MailAccount): Promise<void>;
  initialSync(account: MailAccount, initialLimit: number, signal?: AbortSignal): Promise<SyncResult>;
  incrementalSync(account: MailAccount, reconcileLimit: number, signal?: AbortSignal): Promise<SyncResult>;
  reconcile(account: MailAccount, reconcileLimit: number, signal?: AbortSignal): Promise<SyncResult>;
  backfill(account: MailAccount, beforeUid: number, pageSize: number, signal?: AbortSignal): Promise<BackfillResult>;
  fetchBody(account: MailAccount, uid: number, uidValidity: string, maxMessageBytes: number, signal?: AbortSignal): Promise<Pick<ParsedMessage, "textBody" | "htmlBody" | "snippet" | "hasAttachments" | "size" | "bodyStatus" | "bodyError">>;
  performOperation(account: MailAccount, operation: MailOperation, signal?: AbortSignal): Promise<void>;
  createSubscription(account: MailAccount): Promise<null>;
  renewSubscription(account: MailAccount): Promise<null>;
  watch(account: MailAccount, onEvent: (reason: "exists" | "expunge" | "flags") => void, signal: AbortSignal, onReady?: () => void): Promise<void>;
}

/** @deprecated Implement MailProvider for new adapters. */
export interface MailSyncer {
  testConnection(account: MailAccount): Promise<void>;
  sync(account: MailAccount, initialLimit: number, maxMessageBytes: number): Promise<SyncResult>;
}
