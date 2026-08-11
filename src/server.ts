import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";
import { z } from "zod";
import { createSessionToken, hashPassword, hashSessionToken, normalizeEmail, readCookie, verifyPassword } from "./auth.js";
import { config } from "./config.js";
import { decryptSecret, encryptSecret } from "./crypto.js";
import { MailDatabase } from "./database.js";
import { ImapMailSyncer } from "./imap-syncer.js";
import { ImapIdleService } from "./imap-idle-service.js";
import { MailWorker } from "./mail-worker.js";
import { providers } from "./providers.js";
import { allowedRemoteOrigin } from "./remote-access.js";
import { SmtpSender } from "./smtp-sender.js";
import { SyncService } from "./sync-service.js";
import type { MailAccount } from "./types.js";

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
const syncTimestampSchema = z.string().datetime({ offset: true });
const portableAccountSchema = accountSchema.extend({
  syncId: z.string().uuid(),
  enabled: z.boolean(),
  syncUpdatedAt: syncTimestampSchema
});
const configEnvelopeSchema = z.object({
  version: z.string().min(1),
  iv: z.string().min(1),
  ciphertext: z.string().min(1)
}).strict();
const configBundlePutSchema = z.object({
  baseRevision: z.coerce.number().int().min(0),
  envelope: configEnvelopeSchema
}).strict().refine((value) => Buffer.byteLength(JSON.stringify(value.envelope)) <= 512 * 1024, "配置包超过 512KB 限制");
const configLocalImportSchema = z.object({
  accounts: z.array(portableAccountSchema).max(100),
  tombstones: z.array(z.object({ syncId: z.string().uuid(), deletedAt: syncTimestampSchema }).strict()).max(100).default([])
}).strict().superRefine((value, context) => {
  const accountIds = new Set<string>();
  for (const [index, account] of value.accounts.entries()) {
    if (accountIds.has(account.syncId)) context.addIssue({ code: "custom", path: ["accounts", index, "syncId"], message: "syncId 重复" });
    accountIds.add(account.syncId);
  }
  const tombstoneIds = new Set<string>();
  for (const [index, tombstone] of value.tombstones.entries()) {
    if (tombstoneIds.has(tombstone.syncId)) context.addIssue({ code: "custom", path: ["tombstones", index, "syncId"], message: "syncId 重复" });
    tombstoneIds.add(tombstone.syncId);
  }
});

const database = new MailDatabase(config.databasePath);
const syncer = new ImapMailSyncer(config.encryptionKey, config.allowPrivateMailHosts);
const syncService = new SyncService(database, syncer, config.initialSyncLimit, config.maxMessageBytes, {
  backfillPageSize: config.backfillPageSize,
  reconcileLimit: config.reconcileMessageLimit,
  leaseMs: config.syncLeaseSeconds * 1000,
  maxAttempts: config.providerMaxAttempts,
  activeReconcileMinutes: config.activeReconcileMinutes,
  normalReconcileMinutes: config.normalReconcileMinutes,
  inactiveReconcileMinutes: config.inactiveReconcileMinutes,
  providerConcurrency: config.providerMaxConcurrency
});
const mailWorker = new MailWorker(database, syncService, config.syncLeaseSeconds * 1000);
const idleService = !config.configSyncOnly && config.imapIdleEnabled ? new ImapIdleService(database, syncService, syncer, {
  scanIntervalMs: config.imapIdleScanSeconds * 1000,
  debounceMs: config.imapIdleDebounceMs,
  reconnectMaxMs: config.imapIdleReconnectMaxSeconds * 1000,
  startupConcurrency: config.providerMaxConcurrency
}) : null;
const smtpSender = new SmtpSender(config.encryptionKey);
const app = express();
const sessionCookieName = "mail_collector_session";
const sessionLifetimeMs = 30 * 24 * 60 * 60 * 1000;
const authAttempts = new Map<string, { count: number; resetAt: number }>();

app.disable("x-powered-by");
if (config.trustedProxy) app.set("trust proxy", config.trustedProxy);
app.use((request, response, next) => {
  if (config.requireHttps && !request.secure) {
    response.status(426).json({ error: "此服务要求使用 HTTPS" });
    return;
  }
  next();
});
app.use("/api/config-bundle", express.json({ limit: "520kb" }));
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

app.use("/api", (request, response, next) => {
  const origin = request.header("origin");
  if (!allowedRemoteOrigin(origin, config.allowRemoteClients, config.allowedRemoteOrigins)) {
    next();
    return;
  }
  response.set({
    "Access-Control-Allow-Origin": origin!,
    "Access-Control-Allow-Headers": "Content-Type, X-API-Key",
    "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Max-Age": "600",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Vary": "Origin"
  });
  if (request.method === "OPTIONS") {
    response.status(204).end();
    return;
  }
  next();
});

app.use("/api", (request, response, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    const fetchSite = request.header("sec-fetch-site");
    const origin = request.header("origin");
    let crossOrigin = fetchSite === "cross-site";
    if (origin) {
      try {
        crossOrigin ||= new URL(origin).host !== request.header("host");
      } catch {
        crossOrigin = true;
      }
    }
    const permittedApiClient = allowedRemoteOrigin(origin, config.allowRemoteClients, config.allowedRemoteOrigins)
      && validApiKey(request.header("x-api-key") ?? "");
    if (crossOrigin && !permittedApiClient) {
      response.status(403).json({ error: "拒绝跨站请求" });
      return;
    }
  }
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

type PortableAccount = z.infer<typeof portableAccountSchema>;

function passwordMatches(account: MailAccount, password: string): boolean {
  try {
    return decryptSecret(account.encryptedPassword, config.encryptionKey) === password;
  } catch {
    return false;
  }
}

function connectionConfigurationChanged(account: MailAccount | null, input: PortableAccount): boolean {
  return !account
    || account.email !== input.email
    || account.host !== input.host
    || account.port !== input.port
    || account.secure !== input.secure
    || account.username !== input.username
    || account.mailbox !== input.mailbox
    || !passwordMatches(account, input.password);
}

function portableConfigurationMatches(account: MailAccount, input: PortableAccount): boolean {
  return account.name === input.name
    && account.email === input.email
    && account.host === input.host
    && account.port === input.port
    && account.secure === input.secure
    && account.username === input.username
    && account.mailbox === input.mailbox
    && account.enabled === input.enabled
    && passwordMatches(account, input.password);
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

app.use("/api/auth", (_request, response, next) => {
  if (config.configSyncOnly) {
    response.status(404).json({ error: "不存在" });
    return;
  }
  next();
});

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
  if (config.configSyncOnly) {
    response.status(404).json({ error: "不存在" });
    return;
  }
  const token = request.header("x-desktop-shutdown-token") ?? "";
  if (!expectedDesktopShutdownToken.length || !validSecret(token, expectedDesktopShutdownToken)) {
    response.status(404).json({ error: "不存在" });
    return;
  }
  response.status(204).end();
  setImmediate(() => void closeServer());
});

app.use("/api", (request, response, next) => {
  const apiPath = request.originalUrl.split("?", 1)[0]!;
  if (!config.configSyncOnly
    || apiPath === "/api/service"
    || apiPath === "/api/health"
    || apiPath === "/api/config-bundle") {
    next();
    return;
  }
  response.status(404).json({ error: "不存在" });
});

app.use("/api/config-bundle", (request, response, next) => {
  if (!validApiKey(request.header("x-api-key") ?? "")) {
    response.status(401).json({ error: "未授权" });
    return;
  }
  next();
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

app.get("/api/config-bundle", (_request, response) => response.json(database.getConfigBundle()));

app.put("/api/config-bundle", (request, response, next) => {
  try {
    const input = configBundlePutSchema.parse(request.body);
    const result = database.compareAndSwapConfigBundle(input.baseRevision, input.envelope);
    if (!result.ok) return response.status(409).json({ error: "配置包版本冲突", currentRevision: result.currentRevision });
    response.json({ revision: result.revision });
  } catch (error) {
    next(error);
  }
});

app.use("/api", (_request, response, next) => {
  if (!config.configSyncOnly) {
    next();
    return;
  }
  response.status(404).json({ error: "不存在" });
});

app.get("/api/config-local/export", (_request, response) => {
  response.json({
    accounts: database.listAccounts().map((account) => ({
      syncId: account.syncId,
      name: account.name,
      email: account.email,
      host: account.host,
      port: account.port,
      secure: account.secure,
      username: account.username,
      password: decryptSecret(account.encryptedPassword, config.encryptionKey),
      mailbox: account.mailbox,
      enabled: account.enabled,
      syncUpdatedAt: account.syncUpdatedAt
    }))
  });
});

app.post("/api/config-local/import", async (request, response, next) => {
  try {
    const input = configLocalImportSchema.parse(request.body);
    const counts = { created: 0, updated: 0, unchanged: 0, stale: 0, disabled: 0, tombstonesIgnored: 0, queued: 0 };
    const prepared: Array<{
      input: PortableAccount;
      existing: MailAccount | null;
      encryptedPassword: string;
      mailSettingsChanged: boolean;
    }> = [];

    for (const accountInput of input.accounts) {
      const existing = database.getAccountBySyncId(accountInput.syncId);
      const incomingTime = Date.parse(accountInput.syncUpdatedAt);
      const existingTime = existing ? Date.parse(existing.syncUpdatedAt) : 0;
      if (existing && incomingTime <= existingTime) {
        if (incomingTime === existingTime && portableConfigurationMatches(existing, accountInput)) counts.unchanged += 1;
        else counts.stale += 1;
        continue;
      }
      const encryptedPassword = encryptSecret(accountInput.password, config.encryptionKey);
      const mailSettingsChanged = connectionConfigurationChanged(existing, accountInput);
      prepared.push({ input: accountInput, existing, encryptedPassword, mailSettingsChanged });
    }

    let refreshIdle = false;
    for (const item of prepared) {
      const result = database.upsertSyncedAccount({
        syncId: item.input.syncId,
        name: item.input.name,
        email: item.input.email,
        host: item.input.host,
        port: item.input.port,
        secure: item.input.secure,
        username: item.input.username,
        encryptedPassword: item.encryptedPassword,
        mailbox: item.input.mailbox,
        enabled: item.input.enabled,
        syncUpdatedAt: item.input.syncUpdatedAt
      });
      counts[result.status] += 1;
      if (result.status === "created" || result.status === "updated") refreshIdle = true;
      const enabledAgain = Boolean(item.existing && !item.existing.enabled && result.account.enabled);
      if (result.account.enabled && (result.status === "created" || result.status === "updated")
        && (result.status === "created" || result.connectionChanged || item.mailSettingsChanged || enabledAgain)) {
        const jobType = result.status === "created" || result.connectionChanged || result.account.uidValidity === null ? "initial" : "reconcile";
        database.enqueueJob(result.account.id, jobType, jobType === "initial" ? 1 : 3, "config_import");
        counts.queued += 1;
      }
    }

    for (const tombstone of input.tombstones) {
      const result = database.applyAccountTombstone(tombstone.syncId, tombstone.deletedAt);
      if (result === "applied") {
        counts.disabled += 1;
        refreshIdle = true;
      } else {
        counts.tombstonesIgnored += 1;
      }
    }
    if (refreshIdle) idleService?.refresh();
    response.json(counts);
  } catch (error) {
    next(error);
  }
});

app.get("/api/providers", (_request, response) => response.json({ providers }));
app.get("/api/accounts", (_request, response) => response.json({ accounts: database.listPublicAccounts(syncService.syncingIds) }));

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
    if (!database.deleteAccount(id)) return response.status(404).json({ error: "邮箱不存在" });
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

app.get("/api/messages/:id", async (request, response, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(request.params.id);
    let message = database.getMessage(id) as { bodyStatus?: string } | null;
    if (!message) return response.status(404).json({ error: "邮件不存在" });
    if (message.bodyStatus === "not_fetched" || message.bodyStatus === "failed") {
      await syncService.fetchMessageBody(id).catch((error) => console.error(error));
      message = database.getMessage(id) as { bodyStatus?: string } | null;
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
  const status = message.includes("不存在") ? 404
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
if (!config.configSyncOnly) {
  syncService.scheduleDueAccounts();
  idleService?.start();
  schedulerTimer = setInterval(() => syncService.scheduleDueAccounts(), config.syncIntervalMinutes * 60_000);
  schedulerTimer.unref();
  workerTimer = setInterval(() => void mailWorker.drain(), config.workerIntervalSeconds * 1000);
  workerTimer.unref();
  void mailWorker.drain();
}

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
