import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { classifyMail, type AutoCategory, type ClassifiableMessage } from "./mail-classifier.js";
import type {
  DraftInput,
  LocalMessageContent,
  MailAccount,
  MessageActions,
  MessageKind,
  MessageLabel,
  MessageView,
  ParsedMessage,
  PublicMailAccount,
  SyncResult
} from "./types.js";

type AccountRow = {
  id: number;
  name: string;
  email: string;
  host: string;
  port: number;
  secure: number;
  username: string;
  encrypted_password: string;
  mailbox: string;
  enabled: number;
  uid_validity: string | null;
  last_uid: number;
  last_sync_at: string | null;
  last_error: string | null;
  created_at: string;
};

type AppUserRow = {
  id: number;
  email: string;
  normalized_email: string;
  password_hash: string;
  created_at: string;
};

export type AppUser = {
  id: number;
  email: string;
  normalizedEmail: string;
  passwordHash: string;
  createdAt: string;
};

export class MailDatabase {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  hasAppUser(): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM app_users WHERE id = 1").get());
  }

  getAppUserByEmail(normalizedEmail: string): AppUser | null {
    const row = this.db.prepare("SELECT * FROM app_users WHERE normalized_email = ?").get(normalizedEmail) as AppUserRow | undefined;
    return row ? this.mapAppUser(row) : null;
  }

  createAppUser(email: string, normalizedEmail: string, passwordHash: string): AppUser {
    this.db.prepare(`
      INSERT INTO app_users (id, email, normalized_email, password_hash)
      VALUES (1, ?, ?, ?)
    `).run(email, normalizedEmail, passwordHash);
    return this.getAppUserByEmail(normalizedEmail)!;
  }

  createAppSession(tokenHash: string, userId: number, expiresAt: string): void {
    this.db.prepare(`
      INSERT INTO app_sessions (token_hash, user_id, expires_at)
      VALUES (?, ?, ?)
    `).run(tokenHash, userId, expiresAt);
  }

  getAppUserForSession(tokenHash: string, now = new Date().toISOString()): AppUser | null {
    this.db.prepare("DELETE FROM app_sessions WHERE expires_at <= ?").run(now);
    const row = this.db.prepare(`
      SELECT app_users.*
      FROM app_sessions
      JOIN app_users ON app_users.id = app_sessions.user_id
      WHERE app_sessions.token_hash = ? AND app_sessions.expires_at > ?
    `).get(tokenHash, now) as AppUserRow | undefined;
    return row ? this.mapAppUser(row) : null;
  }

  deleteAppSession(tokenHash: string): void {
    this.db.prepare("DELETE FROM app_sessions WHERE token_hash = ?").run(tokenHash);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        host TEXT NOT NULL,
        port INTEGER NOT NULL,
        secure INTEGER NOT NULL DEFAULT 1,
        username TEXT NOT NULL,
        encrypted_password TEXT NOT NULL,
        mailbox TEXT NOT NULL DEFAULT 'INBOX',
        enabled INTEGER NOT NULL DEFAULT 1,
        uid_validity TEXT,
        last_uid INTEGER NOT NULL DEFAULT 0,
        last_sync_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        uid INTEGER NOT NULL,
        message_id TEXT,
        subject TEXT NOT NULL DEFAULT '',
        from_name TEXT,
        from_address TEXT,
        to_text TEXT,
        received_at TEXT NOT NULL,
        text_body TEXT,
        html_body TEXT,
        snippet TEXT NOT NULL DEFAULT '',
        has_attachments INTEGER NOT NULL DEFAULT 0,
        is_read INTEGER NOT NULL DEFAULT 1,
        is_starred INTEGER NOT NULL DEFAULT 0,
        size INTEGER NOT NULL DEFAULT 0,
        body_status TEXT NOT NULL DEFAULT 'complete',
        body_error TEXT,
        folder TEXT NOT NULL DEFAULT 'inbox' CHECK(folder IN ('inbox', 'archive', 'trash', 'spam')),
        snoozed_until TEXT,
        kind TEXT NOT NULL DEFAULT 'received' CHECK(kind IN ('received', 'draft', 'sent')),
        cc_text TEXT,
        bcc_text TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(account_id, uid)
      );

      CREATE INDEX IF NOT EXISTS messages_received_at_idx ON messages(received_at DESC);
      CREATE INDEX IF NOT EXISTS messages_account_id_idx ON messages(account_id);

      CREATE TABLE IF NOT EXISTS app_users (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        email TEXT NOT NULL,
        normalized_email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS app_sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS app_sessions_expires_at_idx ON app_sessions(expires_at);
    `);

    const appUserColumns = this.db.prepare("PRAGMA table_info(app_users)").all() as Array<{ name: string }>;
    if (appUserColumns.some((column) => column.name === "username") && !appUserColumns.some((column) => column.name === "email")) {
      this.db.exec("ALTER TABLE app_users RENAME COLUMN username TO email");
      this.db.exec("ALTER TABLE app_users RENAME COLUMN normalized_username TO normalized_email");
    }

    this.addColumnIfMissing("accounts", "uid_validity", "TEXT");
    this.addColumnIfMissing("messages", "body_status", "TEXT NOT NULL DEFAULT 'complete'");
    this.addColumnIfMissing("messages", "body_error", "TEXT");
    this.addColumnIfMissing("messages", "is_read", "INTEGER NOT NULL DEFAULT 1");
    this.addColumnIfMissing("messages", "is_starred", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("messages", "folder", "TEXT NOT NULL DEFAULT 'inbox'");
    this.addColumnIfMissing("messages", "snoozed_until", "TEXT");
    this.addColumnIfMissing("messages", "kind", "TEXT NOT NULL DEFAULT 'received'");
    this.addColumnIfMissing("messages", "cc_text", "TEXT");
    this.addColumnIfMissing("messages", "bcc_text", "TEXT");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS labels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        built_in INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS message_labels (
        message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
        PRIMARY KEY (message_id, label_id)
      );

      CREATE INDEX IF NOT EXISTS messages_folder_idx ON messages(folder, received_at DESC);
      CREATE INDEX IF NOT EXISTS messages_kind_idx ON messages(kind, received_at DESC);
      CREATE INDEX IF NOT EXISTS messages_snoozed_until_idx ON messages(snoozed_until);
      CREATE INDEX IF NOT EXISTS message_labels_label_id_idx ON message_labels(label_id, message_id);

      INSERT OR IGNORE INTO labels (name, built_in) VALUES ('工作', 1), ('个人', 1), ('订阅', 1);
    `);
    this.addColumnIfMissing("messages", "auto_label_id", "INTEGER REFERENCES labels(id)");
  }

  private addColumnIfMissing(table: "accounts" | "messages", column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((item) => item.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  createAccount(input: Omit<MailAccount, "id" | "uidValidity" | "lastUid" | "lastSyncAt" | "lastError" | "createdAt">): MailAccount {
    const result = this.db.prepare(`
      INSERT INTO accounts (name, email, host, port, secure, username, encrypted_password, mailbox, enabled)
      VALUES (@name, @email, @host, @port, @secure, @username, @encryptedPassword, @mailbox, @enabled)
    `).run({ ...input, secure: Number(input.secure), enabled: Number(input.enabled) });
    return this.getAccount(Number(result.lastInsertRowid))!;
  }

  getAccount(id: number): MailAccount | null {
    const row = this.db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as AccountRow | undefined;
    return row ? this.mapAccount(row) : null;
  }

  listAccounts(): MailAccount[] {
    return (this.db.prepare("SELECT * FROM accounts ORDER BY created_at DESC, id DESC").all() as AccountRow[])
      .map((row) => this.mapAccount(row));
  }

  listPublicAccounts(syncingIds: Set<number>): PublicMailAccount[] {
    const counts = new Map((this.db.prepare(`
      SELECT account_id AS accountId, COUNT(*) AS messageCount,
        SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) AS unreadCount
      FROM messages
      WHERE kind = 'received'
      GROUP BY account_id
    `).all() as Array<{ accountId: number; messageCount: number; unreadCount: number }>).map((row) => [row.accountId, row]));
    return this.listAccounts().map(({ encryptedPassword: _password, ...account }) => ({
      ...account,
      status: !account.enabled ? "disabled" : syncingIds.has(account.id) ? "syncing" : account.lastError ? "error" : "ready",
      messageCount: counts.get(account.id)?.messageCount ?? 0,
      unreadCount: counts.get(account.id)?.unreadCount ?? 0
    }));
  }

  deleteAccount(id: number): boolean {
    return this.db.prepare("DELETE FROM accounts WHERE id = ?").run(id).changes > 0;
  }

  setAccountEnabled(id: number, enabled: boolean): void {
    this.db.prepare("UPDATE accounts SET enabled = ? WHERE id = ?").run(Number(enabled), id);
  }

  markSyncError(id: number, error: string): void {
    this.db.prepare("UPDATE accounts SET last_sync_at = ?, last_error = ? WHERE id = ?")
      .run(new Date().toISOString(), error.slice(0, 1000), id);
  }

  saveMessages(accountId: number, messages: ParsedMessage[]): number {
    const insert = this.messageInsertStatement();
    const transaction = this.db.transaction((items: ParsedMessage[]) => {
      let inserted = 0;
      for (const message of items) {
        const result = insert.run({
          accountId,
          ...message,
          hasAttachments: Number(message.hasAttachments),
          isRead: Number(message.isRead)
        });
        inserted += result.changes;
        if (result.changes) this.applyAutoClassification(Number(result.lastInsertRowid), message);
      }
      return inserted;
    });
    return transaction(messages);
  }

  commitSync(accountId: number, result: SyncResult): { inserted: number; mailboxReset: boolean } {
    const insert = this.messageInsertStatement();
    const transaction = this.db.transaction(() => {
      const account = this.getAccount(accountId);
      if (!account) throw new Error("邮箱不存在");
      const mailboxReset = account.uidValidity !== null && account.uidValidity !== result.uidValidity;
      if (mailboxReset) {
        this.db.prepare("DELETE FROM messages WHERE account_id = ? AND kind = 'received'").run(accountId);
      }

      let inserted = 0;
      for (const message of result.messages) {
        const insertedMessage = insert.run({ accountId, ...message, hasAttachments: Number(message.hasAttachments), isRead: Number(message.isRead) });
        inserted += insertedMessage.changes;
        if (insertedMessage.changes) this.applyAutoClassification(Number(insertedMessage.lastInsertRowid), message);
      }
      const updateReadState = this.db.prepare("UPDATE messages SET is_read = ? WHERE account_id = ? AND uid = ? AND kind = 'received'");
      for (const state of result.readStates) {
        updateReadState.run(Number(state.isRead), accountId, state.uid);
      }
      this.db.prepare(`
        UPDATE accounts
        SET uid_validity = ?, last_uid = ?, last_sync_at = ?, last_error = NULL
        WHERE id = ?
      `).run(result.uidValidity, result.lastUid, new Date().toISOString(), accountId);
      return { inserted, mailboxReset };
    });
    return transaction();
  }

  private messageInsertStatement(): Database.Statement {
    return this.db.prepare(`
      INSERT INTO messages (
        account_id, uid, message_id, subject, from_name, from_address, to_text,
        received_at, text_body, html_body, snippet, has_attachments, is_read, size,
        body_status, body_error
      ) VALUES (
        @accountId, @uid, @messageId, @subject, @fromName, @fromAddress, @toText,
        @receivedAt, @textBody, @htmlBody, @snippet, @hasAttachments, @isRead, @size,
        @bodyStatus, @bodyError
      )
      ON CONFLICT(account_id, uid) DO NOTHING
    `);
  }

  listMessages(input: {
    view?: MessageView;
    label?: string;
    accountId?: number;
    accountIds?: number[];
    query?: string;
    readState?: "read" | "unread";
    starred?: boolean;
    limit: number;
    offset: number;
  }): { messages: unknown[]; total: number } {
    const conditions: string[] = [];
    const parameters: Record<string, unknown> = { limit: input.limit, offset: input.offset, now: new Date().toISOString() };
    switch (input.view ?? "inbox") {
      case "inbox":
        conditions.push("m.kind = 'received'", "m.folder = 'inbox'", "(m.snoozed_until IS NULL OR m.snoozed_until <= @now)");
        break;
      case "archive":
      case "trash":
      case "spam":
        conditions.push("m.kind = 'received'", "m.folder = @view");
        parameters.view = input.view;
        break;
      case "snoozed":
        conditions.push("m.kind = 'received'", "m.snoozed_until > @now");
        break;
      case "sent":
        conditions.push("m.kind = 'sent'");
        break;
      case "drafts":
        conditions.push("m.kind = 'draft'");
        break;
      case "all":
        break;
    }
    if (input.accountId) {
      conditions.push("m.account_id = @accountId");
      parameters.accountId = input.accountId;
    }
    if (input.accountIds?.length) {
      const placeholders = input.accountIds.map((id, index) => {
        const key = `accountId${index}`;
        parameters[key] = id;
        return `@${key}`;
      });
      conditions.push(`m.account_id IN (${placeholders.join(", ")})`);
    }
    if (input.query) {
      conditions.push("(m.subject LIKE @query OR m.from_name LIKE @query OR m.from_address LIKE @query OR m.to_text LIKE @query OR m.snippet LIKE @query OR m.text_body LIKE @query)");
      parameters.query = `%${input.query}%`;
    }
    if (input.readState) conditions.push(`m.is_read = ${input.readState === "read" ? 1 : 0}`);
    if (input.starred !== undefined) conditions.push(`m.is_starred = ${input.starred ? 1 : 0}`);
    if (input.label) {
      if (/^\d+$/.test(input.label)) {
        conditions.push("EXISTS (SELECT 1 FROM message_labels ml WHERE ml.message_id = m.id AND ml.label_id = @labelId)");
        parameters.labelId = Number(input.label);
      } else {
        conditions.push("EXISTS (SELECT 1 FROM message_labels ml JOIN labels l ON l.id = ml.label_id WHERE ml.message_id = m.id AND l.name = @labelName COLLATE NOCASE)");
        parameters.labelName = input.label;
      }
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db.prepare(`
      SELECT m.id, m.account_id AS accountId, a.name AS accountName, a.email AS accountEmail,
        m.subject, m.from_name AS fromName, m.from_address AS fromAddress, m.to_text AS toText,
        m.received_at AS receivedAt, m.snippet, m.has_attachments AS hasAttachments,
        m.is_read AS isRead, m.is_starred AS isStarred, m.size,
        m.body_status AS bodyStatus, m.folder, m.snoozed_until AS snoozedUntil, m.kind
      FROM messages m JOIN accounts a ON a.id = m.account_id
      ${where}
      ORDER BY m.received_at DESC, m.id DESC
      LIMIT @limit OFFSET @offset
    `).all(parameters) as Array<Record<string, unknown> & { id: number }>;
    const labels = this.labelsForMessageIds(rows.map((row) => row.id));
    const messages = rows.map((row) => ({
      ...row,
      hasAttachments: Boolean(row.hasAttachments),
      isRead: Boolean(row.isRead),
      isStarred: Boolean(row.isStarred),
      labels: labels.get(row.id) ?? []
    }));
    const total = (this.db.prepare(`SELECT COUNT(*) AS total FROM messages m JOIN accounts a ON a.id = m.account_id ${where}`).get(parameters) as { total: number }).total;
    return { messages, total };
  }

  getMessage(id: number): unknown | null {
    const row = this.db.prepare(`
      SELECT m.id, m.account_id AS accountId, a.name AS accountName, a.email AS accountEmail,
        m.message_id AS messageId, m.subject, m.from_name AS fromName,
        m.from_address AS fromAddress, m.to_text AS toText, m.received_at AS receivedAt,
        m.cc_text AS ccText, m.bcc_text AS bccText,
        m.text_body AS textBody, m.html_body AS htmlBody, m.snippet,
        m.has_attachments AS hasAttachments, m.is_read AS isRead, m.is_starred AS isStarred, m.size, m.body_status AS bodyStatus,
        m.body_error AS bodyError, m.folder, m.snoozed_until AS snoozedUntil, m.kind
      FROM messages m JOIN accounts a ON a.id = m.account_id
      WHERE m.id = ?
    `).get(id) as any;
    if (!row) return null;
    return {
      ...row,
      hasAttachments: Boolean(row.hasAttachments),
      isRead: Boolean(row.isRead),
      isStarred: Boolean(row.isStarred),
      labels: this.labelsForMessageIds([id]).get(id) ?? [],
      to: this.addressList(row.toText),
      cc: this.addressList(row.ccText),
      bcc: this.addressList(row.bccText)
    };
  }

  setMessageRead(id: number, isRead: boolean): boolean {
    return this.updateMessages([id], { isRead }).updated > 0;
  }

  setMessageStarred(id: number, isStarred: boolean): boolean {
    return this.updateMessages([id], { isStarred }).updated > 0;
  }

  updateMessages(ids: number[], actions: MessageActions): { updated: number; missingIds: number[] } {
    const uniqueIds = [...new Set(ids)];
    const transaction = this.db.transaction(() => {
      const placeholders = uniqueIds.map(() => "?").join(", ");
      const existingIds = uniqueIds.length
        ? (this.db.prepare(`SELECT id FROM messages WHERE id IN (${placeholders})`).all(...uniqueIds) as Array<{ id: number }>).map((row) => row.id)
        : [];
      const existingSet = new Set(existingIds);
      const missingIds = uniqueIds.filter((id) => !existingSet.has(id));

      if (actions.labels !== undefined) this.assertLabelsExist(actions.labels);
      const assignments: string[] = [];
      const values: unknown[] = [];
      if (actions.isRead !== undefined) {
        assignments.push("is_read = ?");
        values.push(Number(actions.isRead));
      }
      if (actions.isStarred !== undefined) {
        assignments.push("is_starred = ?");
        values.push(Number(actions.isStarred));
      }
      if (actions.folder !== undefined) {
        assignments.push("folder = ?");
        values.push(actions.folder);
      }
      if (actions.snoozedUntil !== undefined) {
        assignments.push("snoozed_until = ?");
        values.push(actions.snoozedUntil);
      }
      if (assignments.length && existingIds.length) {
        const existingPlaceholders = existingIds.map(() => "?").join(", ");
        this.db.prepare(`UPDATE messages SET ${assignments.join(", ")} WHERE id IN (${existingPlaceholders})`).run(...values, ...existingIds);
      }
      if (actions.labels !== undefined && existingIds.length) {
        const existingPlaceholders = existingIds.map(() => "?").join(", ");
        this.db.prepare(`UPDATE messages SET auto_label_id = NULL WHERE id IN (${existingPlaceholders})`).run(...existingIds);
        this.db.prepare(`DELETE FROM message_labels WHERE message_id IN (${existingPlaceholders})`).run(...existingIds);
        const insert = this.db.prepare("INSERT INTO message_labels (message_id, label_id) VALUES (?, ?)");
        for (const messageId of existingIds) {
          for (const labelId of [...new Set(actions.labels)]) insert.run(messageId, labelId);
        }
      }
      return { updated: existingIds.length, missingIds };
    });
    return transaction();
  }

  deleteMessage(id: number): boolean {
    return this.db.prepare("DELETE FROM messages WHERE id = ?").run(id).changes > 0;
  }

  listLabels(): Array<MessageLabel & { messageCount: number }> {
    return (this.db.prepare(`
      SELECT l.id, l.name, l.built_in AS builtIn, COUNT(ml.message_id) AS messageCount
      FROM labels l LEFT JOIN message_labels ml ON ml.label_id = l.id
      GROUP BY l.id
      ORDER BY l.built_in DESC, l.name COLLATE NOCASE
    `).all() as Array<{ id: number; name: string; builtIn: number; messageCount: number }>).map((row) => ({
      ...row,
      builtIn: Boolean(row.builtIn)
    }));
  }

  autoClassifyMessages(accountId?: number): { classified: number; changed: number; unchanged: number; unclassified: number; byLabel: Record<AutoCategory, number> } {
    const rows = this.db.prepare(`
      SELECT id, subject, from_name AS fromName, from_address AS fromAddress,
        to_text AS toText, text_body AS textBody, snippet
      FROM messages
      WHERE kind = 'received' ${accountId ? "AND account_id = ?" : ""}
    `).all(...(accountId ? [accountId] : [])) as Array<ClassifiableMessage & { id: number }>;
    const result = { classified: 0, changed: 0, unchanged: 0, unclassified: 0, byLabel: { 工作: 0, 个人: 0, 订阅: 0 } };
    const transaction = this.db.transaction(() => {
      for (const row of rows) {
        const status = this.applyAutoClassification(row.id, row);
        if (status.category) {
          result.classified += 1;
          result.byLabel[status.category] += 1;
        } else {
          result.unclassified += 1;
        }
        if (status.changed) result.changed += 1; else result.unchanged += 1;
      }
    });
    transaction();
    return result;
  }

  createLabel(name: string): MessageLabel {
    try {
      const result = this.db.prepare("INSERT INTO labels (name) VALUES (?)").run(name);
      return { id: Number(result.lastInsertRowid), name, builtIn: false };
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE")) throw new Error("标签已存在");
      throw error;
    }
  }

  deleteLabel(id: number): "deleted" | "missing" | "protected" {
    const label = this.db.prepare("SELECT built_in AS builtIn FROM labels WHERE id = ?").get(id) as { builtIn: number } | undefined;
    if (!label) return "missing";
    if (label.builtIn) return "protected";
    this.db.prepare("DELETE FROM labels WHERE id = ?").run(id);
    return "deleted";
  }

  createDraft(input: DraftInput): unknown {
    return this.createLocalMessage(input.accountId, "draft", input);
  }

  updateDraft(id: number, input: Partial<LocalMessageContent>): unknown | null {
    const assignments: string[] = [];
    const values: unknown[] = [];
    if (input.to !== undefined) { assignments.push("to_text = ?"); values.push(input.to.join(", ")); }
    if (input.cc !== undefined) { assignments.push("cc_text = ?"); values.push(input.cc.join(", ")); }
    if (input.bcc !== undefined) { assignments.push("bcc_text = ?"); values.push(input.bcc.join(", ")); }
    if (input.subject !== undefined) { assignments.push("subject = ?"); values.push(input.subject); }
    if (input.body !== undefined) {
      assignments.push("text_body = ?", "snippet = ?", "size = ?");
      values.push(input.body, this.snippet(input.body), Buffer.byteLength(input.body));
    }
    assignments.push("received_at = ?");
    values.push(new Date().toISOString());
    const result = this.db.prepare(`UPDATE messages SET ${assignments.join(", ")} WHERE id = ? AND kind = 'draft'`).run(...values, id);
    return result.changes ? this.getMessage(id) : null;
  }

  createSentMessage(input: DraftInput, messageId: string | null, sentAt = new Date().toISOString()): unknown {
    return this.createLocalMessage(input.accountId, "sent", input, messageId, sentAt);
  }

  convertDraftToSent(id: number, messageId: string | null, sentAt = new Date().toISOString()): unknown | null {
    const result = this.db.prepare(`
      UPDATE messages
      SET kind = 'sent', folder = 'archive', message_id = ?, received_at = ?, is_read = 1, snoozed_until = NULL
      WHERE id = ? AND kind = 'draft'
    `).run(messageId, sentAt, id);
    return result.changes ? this.getMessage(id) : null;
  }

  getDraft(id: number): (LocalMessageContent & { id: number; accountId: number }) | null {
    const row = this.db.prepare(`
      SELECT id, account_id AS accountId, to_text AS toText, cc_text AS ccText,
        bcc_text AS bccText, subject, text_body AS body
      FROM messages WHERE id = ? AND kind = 'draft'
    `).get(id) as { id: number; accountId: number; toText: string | null; ccText: string | null; bccText: string | null; subject: string; body: string | null } | undefined;
    return row ? {
      id: row.id,
      accountId: row.accountId,
      to: this.addressList(row.toText),
      cc: this.addressList(row.ccText),
      bcc: this.addressList(row.bccText),
      subject: row.subject,
      body: row.body ?? ""
    } : null;
  }

  private createLocalMessage(accountId: number, kind: Exclude<MessageKind, "received">, input: LocalMessageContent, messageId: string | null = null, receivedAt = new Date().toISOString()): unknown {
    const transaction = this.db.transaction(() => {
      const account = this.getAccount(accountId);
      if (!account) throw new Error("邮箱不存在");
      const minimum = this.db.prepare("SELECT MIN(uid) AS uid FROM messages WHERE account_id = ?").get(accountId) as { uid: number | null };
      const uid = Math.min(-1, (minimum.uid ?? 0) - 1);
      const result = this.db.prepare(`
        INSERT INTO messages (
          account_id, uid, message_id, subject, from_name, from_address, to_text, cc_text, bcc_text,
          received_at, text_body, snippet, is_read, size, folder, kind
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'archive', ?)
      `).run(
        accountId, uid, messageId, input.subject, account.name, account.email,
        input.to.join(", "), input.cc.join(", "), input.bcc.join(", "), receivedAt,
        input.body, this.snippet(input.body), Buffer.byteLength(input.body), kind
      );
      return Number(result.lastInsertRowid);
    });
    return this.getMessage(transaction());
  }

  private applyAutoClassification(messageId: number, message: ClassifiableMessage): { category: AutoCategory | null; changed: boolean } {
    const category = classifyMail(message);
    const stored = this.db.prepare("SELECT auto_label_id AS autoLabelId FROM messages WHERE id = ?").get(messageId) as { autoLabelId: number | null } | undefined;
    if (!stored) return { category, changed: false };
    const label = category
      ? this.db.prepare("SELECT id FROM labels WHERE name = ? COLLATE NOCASE").get(category) as { id: number } | undefined
      : undefined;
    const nextLabelId = label?.id ?? null;
    if (stored.autoLabelId === nextLabelId) return { category, changed: false };
    if (stored.autoLabelId) this.db.prepare("DELETE FROM message_labels WHERE message_id = ? AND label_id = ?").run(messageId, stored.autoLabelId);
    if (nextLabelId) this.db.prepare("INSERT OR IGNORE INTO message_labels (message_id, label_id) VALUES (?, ?)").run(messageId, nextLabelId);
    this.db.prepare("UPDATE messages SET auto_label_id = ? WHERE id = ?").run(nextLabelId, messageId);
    return { category, changed: true };
  }

  private assertLabelsExist(labelIds: number[]): void {
    const uniqueIds = [...new Set(labelIds)];
    if (!uniqueIds.length) return;
    const placeholders = uniqueIds.map(() => "?").join(", ");
    const count = (this.db.prepare(`SELECT COUNT(*) AS count FROM labels WHERE id IN (${placeholders})`).get(...uniqueIds) as { count: number }).count;
    if (count !== uniqueIds.length) throw new Error("标签不存在");
  }

  private labelsForMessageIds(messageIds: number[]): Map<number, MessageLabel[]> {
    const result = new Map<number, MessageLabel[]>();
    if (!messageIds.length) return result;
    const placeholders = messageIds.map(() => "?").join(", ");
    const rows = this.db.prepare(`
      SELECT ml.message_id AS messageId, l.id, l.name, l.built_in AS builtIn
      FROM message_labels ml JOIN labels l ON l.id = ml.label_id
      WHERE ml.message_id IN (${placeholders})
      ORDER BY l.built_in DESC, l.name COLLATE NOCASE
    `).all(...messageIds) as Array<{ messageId: number; id: number; name: string; builtIn: number }>;
    for (const row of rows) {
      const labels = result.get(row.messageId) ?? [];
      labels.push({ id: row.id, name: row.name, builtIn: Boolean(row.builtIn) });
      result.set(row.messageId, labels);
    }
    return result;
  }

  private addressList(value: string | null): string[] {
    return value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
  }

  private snippet(body: string): string {
    return body.replace(/\s+/g, " ").trim().slice(0, 240);
  }

  private mapAccount(row: AccountRow): MailAccount {
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      host: row.host,
      port: row.port,
      secure: Boolean(row.secure),
      username: row.username,
      encryptedPassword: row.encrypted_password,
      mailbox: row.mailbox,
      enabled: Boolean(row.enabled),
      uidValidity: row.uid_validity,
      lastUid: row.last_uid,
      lastSyncAt: row.last_sync_at,
      lastError: row.last_error,
      createdAt: row.created_at
    };
  }

  private mapAppUser(row: AppUserRow): AppUser {
    return {
      id: row.id,
      email: row.email,
      normalizedEmail: row.normalized_email,
      passwordHash: row.password_hash,
      createdAt: row.created_at
    };
  }
}
