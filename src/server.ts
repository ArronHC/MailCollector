import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";
import { z } from "zod";
import { createSessionToken, hashPassword, hashSessionToken, normalizeEmail, readCookie, verifyPassword } from "./auth.js";
import { config } from "./config.js";
import { encryptSecret } from "./crypto.js";
import { MailDatabase } from "./database.js";
import { ImapMailSyncer } from "./imap-syncer.js";
import { ImapIdleService } from "./imap-idle-service.js";
import { MailWorker } from "./mail-worker.js";
import { OAuthManager, type OAuthMailProvider } from "./oauth.js";
import { providers } from "./providers.js";
import { SmtpSender } from "./smtp-sender.js";
import { SyncService } from "./sync-service.js";

const accountSchema = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.email(),
  host: z.string().trim().min(1).max(253),
  port: z.coerce.number().int().min(1).max(65535),
  secure: z.boolean().default(true),
  username: z.string().trim().min(1).max(320),
  password: z.string().min(1).max(1000),
  mailbox: z.string().trim().min(1).max(255).default("INBOX")
});

const recipientsSchema = z.array(z.string().trim().email().max(320)).max(100);
const localContentShape = {
  to: recipientsSchema,
  cc: recipientsSchema,
  bcc: recipientsSchema,
  subject: z.string().max(998),
  body: z.string().max(80_000)
};
const draftCreateSchema = z.object({
  accountId: z.coerce.number().int().positive(),
  to: localContentShape.to.default([]),
  cc: localContentShape.cc.default([]),
  bcc: localContentShape.bcc.default([]),
  subject: localContentShape.subject.default(""),
  body: localContentShape.body.default("")
});
const draftUpdateSchema = z.object({
  to: localContentShape.to.optional(),
  cc: localContentShape.cc.optional(),
  bcc: localContentShape.bcc.optional(),
  subject: localContentShape.subject.optional(),
  body: localContentShape.body.optional()
}).refine((value) => Object.values(value).some((item) => item !== undefined), "至少提供一个更新字段");
const sendSchema = z.object({
  accountId: z.coerce.number().int().positive(),
  to: localContentShape.to.default([]),
  cc: localContentShape.cc.default([]),
  bcc: localContentShape.bcc.default([]),
  subject: localContentShape.subject,
  body: localContentShape.body
}).refine((value) => value.to.length + value.cc.length + value.bcc.length > 0, "至少提供一个收件人");
const messageActionsShape = {
  isRead: z.boolean().optional(),
  isStarred: z.boolean().optional(),
  folder: z.enum(["inbox", "archive", "trash", "spam"]).optional(),
  snoozedUntil: z.string().datetime({ offset: true }).nullable().optional(),
  labels: z.array(z.coerce.number().int().positive()).max(100).optional()
};
const messageActionsSchema = z.object(messageActionsShape)
  .refine((value) => Object.values(value).some((item) => item !== undefined), "至少提供一个更新字段");
const bulkMessageActionsSchema = z.object({
  ids: z.array(z.coerce.number().int().positive()).min(1).max(500),
  ...messageActionsShape
}).refine((value) => Object.entries(value).some(([key, item]) => key !== "ids" && item !== undefined), "至少提供一个更新字段");
const emailSchema = z.string().trim().max(320).pipe(z.email("请输入有效的邮箱地址"));
const passwordSchema = z.string().min(10).max(128);
const registrationSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  inviteCode: z.string().trim().min(1).max(200)
});
const loginSchema = z.object({ email: emailSchema, password: passwordSchema });

const database = new MailDatabase(config.databasePath);
const oauthManager = new OAuthManager({
  encryptionKey: config.encryptionKey,
  databasePath: config.databasePath,
  port: config.port,
  googleClientId: config.googleOauthClientId,
  microsoftClientId: config.microsoftOauthClientId,
  redirectBaseUrl: config.oauthRedirectBaseUrl || undefined
});
const syncer = new ImapMailSyncer(config.encryptionKey, config.allowPrivateMailHosts, oauthManager);
const syncService = new SyncService(database, syncer, config.initialSyncLimit, config.maxMessageBytes, {
  backfillPageSize: config.backfillPageSize,
  reconcileLimit: config.reconcileMessageLimit,
  leaseMs: config.syncLeaseSeconds * 1000,
  maxAttempts: config.providerMaxAttempts,
  activeReconcileMinutes: config.activeReconcileMinutes,
  normalReconcileMinutes: config.normalReconcileMinutes,
  inactiveReconcileMinutes: config.inactiveReconcileMinutes,
  providerConcurrency: config.providerMaxConcurrency,
  bodyPrefetchPerAccount: config.bodyPrefetchPerAccount,
  bodyPrefetchPerDrain: config.bodyPrefetchPerDrain
});
const mailWorker = new MailWorker(database, syncService, config.syncLeaseSeconds * 1000);
const idleService = config.imapIdleEnabled ? new ImapIdleService(database, syncService, syncer, {
  scanIntervalMs: config.imapIdleScanSeconds * 1000,
  debounceMs: config.imapIdleDebounceMs,
  reconnectMaxMs: config.imapIdleReconnectMaxSeconds * 1000,
  startupConcurrency: config.providerMaxConcurrency
}) : null;
const smtpSender = new SmtpSender(config.encryptionKey, oauthManager);
const app = express();
const sessionCookieName = "mail_collector_session";
const sessionLifetimeMs = 30 * 24 * 60 * 60 * 1000;
const authAttempts = new Map<string, { count: number; resetAt: number }>();

app.disable("x-powered-by");
app.use(express.json({ limit: "100kb" }));
app.use((_request, response, next) => {
  response.set({
    "Content-Security-Policy": "default-src 'self'; connect-src 'self' https: http:; script-src 'self'; style-src 'self' 'unsafe-inline' https: http:; img-src 'self' data: cid: https: http:; font-src 'self' data: https: http:; media-src 'self' data: cid: https: http:; frame-src 'self' data: https: http:; object-src 'none'; base-uri 'self' https: http:; frame-ancestors 'none'; form-action 'self'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()"
  });
  next();
});

const expectedApiKey = Buffer.from(config.apiKey);
const expectedInviteCode = Buffer.from(config.registrationInviteCode);
const expectedDesktopShutdownToken = Buffer.from(process.env.DESKTOP_SHUTDOWN_TOKEN?.trim() ?? "");

function validSecret(value: string, expected: Buffer): boolean {
  const supplied = Buffer.from(value);
  return expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
}

function validApiKey(value: string): boolean {
  return validSecret(value, expectedApiKey);
}

function allowAuthAttempt(request: express.Request, response: express.Response): boolean {
  const key = request.ip || request.socket.remoteAddress || "unknown";
  const now = Date.now();
  const current = authAttempts.get(key);
  if (!current || current.resetAt <= now) {
    authAttempts.set(key, { count: 1, resetAt: now + 15 * 60_000 });
    return true;
  }
  if (current.count >= 10) {
    response.set("Retry-After", String(Math.ceil((current.resetAt - now) / 1000)));
    response.status(429).json({ error: "尝试次数过多，请稍后再试" });
    return false;
  }
  current.count += 1;
  return true;
}

function clearAuthAttempts(request: express.Request): void {
  authAttempts.delete(request.ip || request.socket.remoteAddress || "unknown");
}

function startAppSession(userId: number, request: express.Request, response: express.Response): void {
  const token = createSessionToken();
  const expires = new Date(Date.now() + sessionLifetimeMs);
  database.createAppSession(hashSessionToken(token), userId, expires.toISOString());
  response.cookie(sessionCookieName, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: request.secure,
    path: "/api",
    expires
  });
}

function clearAppSession(request: express.Request, response: express.Response): void {
  const token = readCookie(request.header("cookie"), sessionCookieName);
  if (token) database.deleteAppSession(hashSessionToken(token));
  response.clearCookie(sessionCookieName, { httpOnly: true, sameSite: "strict", secure: request.secure, path: "/api" });
}

function queryText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[character] ?? character));
}

function oauthAccountPreset(provider: OAuthMailProvider) {
  return provider === "google"
    ? { name: "Gmail", host: "imap.gmail.com", port: 993, secure: true, provider: "gmail" as const }
    : { name: "Outlook", host: "outlook.office365.com", port: 993, secure: true, provider: "microsoft" as const };
}

app.use("/api/auth", (_request, response, next) => {
  response.set("Cache-Control", "no-store");
  next();
});

app.get("/api/auth/status", (_request, response) => response.json({ registered: database.hasAppUser() }));
app.get("/api/service", (_request, response) => response.json({ ok: true, service: "mail-collector", version: config.serviceVersion }));

app.post("/api/auth/register", async (request, response, next) => {
  try {
    if (!allowAuthAttempt(request, response)) return;
    if (database.hasAppUser()) return response.status(409).json({ error: "管理员账户已创建" });
    const input = registrationSchema.parse(request.body);
    if (!validSecret(input.inviteCode, expectedInviteCode)) return response.status(401).json({ error: "邀请码不正确" });
    const passwordHash = await hashPassword(input.password);
    let user;
    try {
      user = database.createAppUser(input.email, normalizeEmail(input.email), passwordHash);
    } catch (error) {
      if (database.hasAppUser()) return response.status(409).json({ error: "管理员账户已创建" });
      throw error;
    }
    startAppSession(user.id, request, response);
    clearAuthAttempts(request);
    response.status(201).json({ user: { email: user.email } });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/login", async (request, response, next) => {
  try {
    if (!allowAuthAttempt(request, response)) return;
    const input = loginSchema.parse(request.body);
    const user = database.getAppUserByEmail(normalizeEmail(input.email));
    if (!user) {
      await hashPassword(input.password);
      return response.status(401).json({ error: "邮箱或密码不正确" });
    }
    if (!await verifyPassword(input.password, user.passwordHash)) return response.status(401).json({ error: "邮箱或密码不正确" });
    startAppSession(user.id, request, response);
    clearAuthAttempts(request);
    response.json({ user: { email: user.email } });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/logout", (request, response) => {
  clearAppSession(request, response);
  response.status(204).end();
});

app.post("/api/desktop/shutdown", (request, response) => {
  const token = request.header("x-desktop-shutdown-token") ?? "";
  if (!expectedDesktopShutdownToken.length || !validSecret(token, expectedDesktopShutdownToken)) {
    response.status(404).json({ error: "不存在" });
    return;
  }
  response.status(204).end();
  setImmediate(() => void closeServer());
});

app.get("/", async (request, response, next) => {
  const state = queryText(request.query.state);
  const code = queryText(request.query.code);
  const providerError = queryText(request.query.error);
  const providerErrorDescription = queryText(request.query.error_description);
  if (!state || (!code && !providerError)) {
    next();
    return;
  }

  let flowId = "";
  let syncId = "";
  try {
    const completed = await oauthManager.completeCallback(state, code, providerError, providerErrorDescription);
    flowId = completed.flowId;
    const credential = completed.credential;
    if (database.listAccounts().some((account) => account.email.toLowerCase() === credential.email.toLowerCase())) {
      throw Object.assign(new Error("该邮箱已经添加"), { status: 409 });
    }
    const preset = oauthAccountPreset(credential.provider);
    syncId = crypto.randomUUID();
    const syncUpdatedAt = new Date().toISOString();
    oauthManager.saveCredential(syncId, credential);
    const candidate = {
      id: 0,
      syncId,
      syncUpdatedAt,
      name: preset.name,
      email: credential.email,
      host: preset.host,
      port: preset.port,
      secure: preset.secure,
      username: credential.email,
      encryptedPassword: oauthManager.marker(credential.provider),
      mailbox: "INBOX",
      provider: preset.provider,
      enabled: true,
      uidValidity: null,
      lastUid: 0,
      lastSyncAt: null,
      lastSuccessfulSyncAt: null,
      lastReconcileAt: null,
      lastEventAt: null,
      lastError: null,
      syncErrorCount: 0,
      syncState: "idle" as const,
      nextSyncAt: null,
      backfillCursor: null,
      backfillStatus: "pending" as const,
      createdAt: syncUpdatedAt
    };
    await syncer.testConnection(candidate);
    const account = database.createAccount({
      syncId: candidate.syncId,
      syncUpdatedAt: candidate.syncUpdatedAt,
      name: candidate.name,
      email: candidate.email,
      host: candidate.host,
      port: candidate.port,
      secure: candidate.secure,
      username: candidate.username,
      encryptedPassword: candidate.encryptedPassword,
      mailbox: candidate.mailbox,
      provider: candidate.provider,
      enabled: candidate.enabled
    });
    database.enqueueJob(account.id, "initial", 1, "oauth_account_created");
    idleService?.refresh();
    oauthManager.markFlowSuccess(flowId, account.id);
    response.type("html").send("<!doctype html><meta charset=\"utf-8\"><title>Mail Collector</title><style>body{font-family:system-ui;margin:48px;line-height:1.6;color:#1f2937}main{max-width:560px;margin:auto}h1{font-size:24px}</style><main><h1>邮箱已连接</h1><p>授权完成，可以关闭这个浏览器页面并返回 Mail Collector。</p></main>");
  } catch (error) {
    if (syncId) oauthManager.deleteCredential(syncId);
    const message = error instanceof Error ? error.message : "OAuth 授权失败";
    if (flowId) oauthManager.markFlowError(flowId, message);
    const status = Number((error as { status?: number }).status ?? 400);
    response.status(status >= 400 && status < 600 ? status : 400).type("html").send(`<!doctype html><meta charset="utf-8"><title>Mail Collector</title><style>body{font-family:system-ui;margin:48px;line-height:1.6;color:#1f2937}main{max-width:620px;margin:auto}h1{font-size:24px;color:#b42318}</style><main><h1>邮箱连接失败</h1><p>${escapeHtml(message)}</p><p>请关闭此页面并返回 Mail Collector 重试。</p></main>`);
  }
});

app.use("/api", (request, response, next) => {
  const token = readCookie(request.header("cookie"), sessionCookieName);
  if (token) {
    const user = database.getAppUserForSession(hashSessionToken(token));
    if (user) {
      response.locals.authUser = user;
      next();
      return;
    }
  }

  if (!validApiKey(request.header("x-api-key") ?? "")) {
    response.status(401).json({ error: "未授权" });
    return;
  }
  next();
});

app.get("/api/auth/session", (_request, response) => {
  const user = response.locals.authUser as { email: string } | undefined;
  response.json({ user: { email: user?.email ?? "API Key" }, legacy: !user });
});
app.get("/api/health", (_request, response) => response.json({ ok: true, service: "mail-collector", version: config.serviceVersion }));

app.get("/api/providers", (_request, response) => response.json({ providers: providers.map((provider) => {
  const oauthProvider: OAuthMailProvider | null = provider.id === "gmail" ? "google" : provider.id === "outlook" ? "microsoft" : null;
  return { ...provider, oauthProvider, oauthAvailable: oauthProvider ? oauthManager.available(oauthProvider) : false };
}) }));
app.get("/api/accounts", (_request, response) => response.json({ accounts: database.listPublicAccounts(syncService.syncingIds) }));

app.post("/api/oauth/:provider/start", (request, response, next) => {
  try {
    const provider = z.enum(["google", "microsoft"]).parse(request.params.provider);
    response.json(oauthManager.start(provider));
  } catch (error) {
    next(error);
  }
});

app.get("/api/oauth/flows/:flowId", (request, response, next) => {
  try {
    const flowId = z.string().uuid().parse(request.params.flowId);
    response.json(oauthManager.flowStatus(flowId));
  } catch (error) {
    next(error);
  }
});

app.post("/api/accounts", async (request, response, next) => {
  try {
    const input = accountSchema.parse(request.body);
    const syncId = crypto.randomUUID();
    const syncUpdatedAt = new Date().toISOString();
    const candidate = {
      id: 0,
      syncId,
      syncUpdatedAt,
      name: input.name,
      email: input.email,
      host: input.host,
      port: input.port,
      secure: input.secure,
      username: input.username,
      encryptedPassword: encryptSecret(input.password, config.encryptionKey),
      mailbox: input.mailbox,
      provider: input.host.toLowerCase() === "imap.gmail.com" ? "gmail" as const : input.host.toLowerCase() === "outlook.office365.com" ? "microsoft" as const : "imap" as const,
      enabled: true,
      uidValidity: null,
      lastUid: 0,
      lastSyncAt: null,
      lastSuccessfulSyncAt: null,
      lastReconcileAt: null,
      lastEventAt: null,
      lastError: null,
      syncErrorCount: 0,
      syncState: "idle" as const,
      nextSyncAt: null,
      backfillCursor: null,
      backfillStatus: "pending" as const,
      createdAt: syncUpdatedAt
    };
    await syncer.testConnection(candidate);
    const account = database.createAccount({
      syncId: candidate.syncId,
      syncUpdatedAt: candidate.syncUpdatedAt,
      name: candidate.name,
      email: candidate.email,
      host: candidate.host,
      port: candidate.port,
      secure: candidate.secure,
      username: candidate.username,
      encryptedPassword: candidate.encryptedPassword,
      mailbox: candidate.mailbox,
      provider: candidate.provider,
      enabled: candidate.enabled
    });
    database.enqueueJob(account.id, "initial", 1, "account_created");
    idleService?.refresh();
    response.status(201).json({ account: database.listPublicAccounts(syncService.syncingIds).find((item) => item.id === account.id) });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/accounts/:id", (request, response, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(request.params.id);
    const enabled = z.object({ enabled: z.boolean() }).parse(request.body).enabled;
    if (!database.getAccount(id)) return response.status(404).json({ error: "邮箱不存在" });
    database.setAccountEnabled(id, enabled);
    if (enabled) syncService.triggerAccount(id, "account_reenabled");
    idleService?.refresh();
    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/accounts/:id", (request, response, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(request.params.id);
    if (syncService.syncingIds.has(id)) return response.status(409).json({ error: "邮箱正在同步，请稍后删除" });
    const account = database.getAccount(id);
    if (!account || !database.deleteAccount(id)) return response.status(404).json({ error: "邮箱不存在" });
    oauthManager.deleteCredential(account.syncId);
    idleService?.refresh();
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.post("/api/accounts/:id/sync", async (request, response, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(request.params.id);
    response.json(await syncService.syncAccount(id));
  } catch (error) {
    next(error);
  }
});

app.post("/api/accounts/:id/sync-events", (request, response, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(request.params.id);
    if (!database.getAccount(id)) return response.status(404).json({ error: "邮箱不存在" });
    syncService.triggerAccount(id, "provider_event");
    response.status(202).json({ queued: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/sync", async (_request, response, next) => {
  try {
    const result = await syncService.syncAll();
    response.json({ ok: result.failed.length === 0, ...result });
  } catch (error) {
    next(error);
  }
});

app.post("/api/classify", (request, response, next) => {
  try {
    const { accountId } = z.object({ accountId: z.coerce.number().int().positive().optional() }).parse(request.body ?? {});
    if (accountId && !database.getAccount(accountId)) return response.status(404).json({ error: "邮箱不存在" });
    response.json({ ok: true, ...database.autoClassifyMessages(accountId) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/messages", (request, response, next) => {
  try {
    const input = z.object({
      view: z.enum(["inbox", "archive", "trash", "spam", "snoozed", "sent", "drafts", "all"]).default("inbox"),
      label: z.string().trim().min(1).max(80).optional(),
      accountId: z.coerce.number().int().positive().optional(),
      accountIds: z.string().regex(/^\d+(,\d+)*$/).transform((value) => value.split(",").map(Number)).optional(),
      query: z.string().trim().max(200).optional(),
      readState: z.enum(["read", "unread"]).optional(),
      starred: z.enum(["true", "false"]).transform((value) => value === "true").optional(),
      limit: z.coerce.number().int().min(1).max(100).default(40),
      offset: z.coerce.number().int().min(0).default(0)
    }).parse(request.query);
    response.json(database.listMessages(input));
  } catch (error) {
    next(error);
  }
});

app.get("/api/messages/:id", (request, response, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(request.params.id);
    const message = database.getMessage(id) as { bodyStatus?: string } | null;
    if (!message) return response.status(404).json({ error: "邮件不存在" });
    if (message.bodyStatus === "not_fetched" || message.bodyStatus === "failed") {
      void syncService.fetchMessageBody(id).catch((error) => console.error(error));
    }
    response.json({ message });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/messages/:id", (request, response, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(request.params.id);
    const actions = messageActionsSchema.parse(request.body);
    if (!database.updateMessages([id], actions).updated) return response.status(404).json({ error: "邮件不存在" });
    response.json({ ok: true, message: database.getMessage(id) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/messages/bulk", (request, response, next) => {
  try {
    const { ids, ...actions } = bulkMessageActionsSchema.parse(request.body);
    response.json({ ok: true, ...database.updateMessages(ids, actions) });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/messages/:id", (request, response, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(request.params.id);
    if (!database.deleteMessage(id)) return response.status(404).json({ error: "邮件不存在" });
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.get("/api/labels", (_request, response) => response.json({ labels: database.listLabels() }));

app.post("/api/labels", (request, response, next) => {
  try {
    const { name } = z.object({ name: z.string().trim().min(1).max(80) }).parse(request.body);
    response.status(201).json({ label: database.createLabel(name) });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/labels/:id", (request, response, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(request.params.id);
    const result = database.deleteLabel(id);
    if (result === "missing") return response.status(404).json({ error: "标签不存在" });
    if (result === "protected") return response.status(409).json({ error: "默认标签不能删除" });
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.post("/api/drafts", (request, response, next) => {
  try {
    response.status(201).json({ draft: database.createDraft(draftCreateSchema.parse(request.body)) });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/drafts/:id", (request, response, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(request.params.id);
    const draft = database.updateDraft(id, draftUpdateSchema.parse(request.body));
    if (!draft) return response.status(404).json({ error: "草稿不存在" });
    response.json({ draft });
  } catch (error) {
    next(error);
  }
});

app.post("/api/send", async (request, response, next) => {
  try {
    const input = sendSchema.parse(request.body);
    const account = database.getAccount(input.accountId);
    if (!account) return response.status(404).json({ error: "邮箱不存在" });
    if (!account.enabled) return response.status(409).json({ error: "邮箱已停用" });
    const delivery = await smtpSender.send(account, input);
    const message = database.createSentMessage(input, delivery.messageId, delivery.sentAt);
    response.status(201).json({ message });
  } catch (error) {
    next(error);
  }
});

app.post("/api/drafts/:id/send", async (request, response, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(request.params.id);
    const draft = database.getDraft(id);
    if (!draft) return response.status(404).json({ error: "草稿不存在" });
    const input = sendSchema.parse(draft);
    const account = database.getAccount(input.accountId);
    if (!account) return response.status(404).json({ error: "邮箱不存在" });
    if (!account.enabled) return response.status(409).json({ error: "邮箱已停用" });
    const delivery = await smtpSender.send(account, input);
    const message = database.convertDraftToSent(id, delivery.messageId, delivery.sentAt);
    response.json({ message });
  } catch (error) {
    next(error);
  }
});

const publicDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
app.use(express.static(publicDirectory));
app.get("/{*path}", (_request, response) => response.sendFile(path.join(publicDirectory, "index.html")));

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  if (error instanceof z.ZodError) {
    response.status(400).json({ error: "请求参数不正确", details: error.issues });
    return;
  }
  const message = error instanceof Error ? error.message : "服务器错误";
  console.error(error);
  const explicitStatus = Number((error as { status?: number }).status ?? 0);
  const status = explicitStatus >= 400 && explicitStatus < 600 ? explicitStatus
    : message.includes("不存在") ? 404
    : message.includes("正在同步") || message.includes("已存在") || message.includes("已停用") ? 409
    : message.includes("不支持 IMAP 主机") || message.includes("不允许连接") || message.includes("没有可用地址") ? 400
    : 500;
  response.status(status).json({ error: status === 500 ? "服务器错误" : message });
});

export const server = app.listen(config.port, config.host, () => {
  console.log(`Mail Collector is running at http://${config.host}:${config.port}`);
});

let schedulerTimer: NodeJS.Timeout | null = null;
let workerTimer: NodeJS.Timeout | null = null;
syncService.scheduleDueAccounts();
idleService?.start();
schedulerTimer = setInterval(() => syncService.scheduleDueAccounts(), config.syncIntervalMinutes * 60_000);
schedulerTimer.unref();
workerTimer = setInterval(() => void mailWorker.drain(), config.workerIntervalSeconds * 1000);
workerTimer.unref();
void mailWorker.drain();

let closePromise: Promise<void> | null = null;

export function closeServer(): Promise<void> {
  if (closePromise) return closePromise;
  closePromise = (async () => {
    if (schedulerTimer) clearInterval(schedulerTimer);
    if (workerTimer) clearInterval(workerTimer);
    await idleService?.stop();
    syncService.stop();
    await mailWorker.stop();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    database.close();
  })();
  return closePromise;
}

if (!process.versions.electron) {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void closeServer().finally(() => process.exit(0));
    });
  }
}
