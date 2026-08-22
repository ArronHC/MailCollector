import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import express from "express";
import { z } from "zod";
import {
  createSessionToken,
  hashPassword,
  hashSessionToken,
  normalizeEmail,
  verifyPassword
} from "./auth.js";
import { config } from "./config.js";
import { MailDatabase } from "./database.js";

type CoreServerModule = typeof import("./server.js");
type RequestListener = (request: IncomingMessage, response: ServerResponse) => void;

const coreModulePath = import.meta.url.endsWith(".ts") ? "./server.js" : "./server-core.js";
const { server } = await import(coreModulePath) as CoreServerModule;
const originalRequestListener = server.listeners("request")[0] as RequestListener | undefined;
if (!originalRequestListener) throw new Error("Mail Collector HTTP request listener is unavailable");

const controlDatabase = new MailDatabase(config.databasePath);
const expectedApiKey = Buffer.from(config.apiKey);
const sessionLifetimeMs = 30 * 24 * 60 * 60 * 1000;
const nativeOrigins = new Set([
  "http://localhost",
  "https://localhost",
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost"
]);

const emailSchema = z.string().trim().max(320).pipe(z.email("请输入有效的邮箱地址"));
const passwordSchema = z.string().min(10).max(128);
const clientLoginSchema = z.object({ email: emailSchema, password: passwordSchema });
const clientRegistrationSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  inviteCode: z.string().trim().min(1).max(200)
});

function validSecret(value: string, expected: Buffer): boolean {
  const supplied = Buffer.from(value);
  return expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
}

function bearerToken(request: IncomingMessage | express.Request): string {
  const authorization = "header" in request
    ? request.header("authorization") ?? ""
    : Array.isArray(request.headers.authorization)
      ? request.headers.authorization[0] ?? ""
      : request.headers.authorization ?? "";
  return authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
}

function nativeSessionUser(request: IncomingMessage | express.Request) {
  const token = bearerToken(request);
  return token ? controlDatabase.getAppUserForSession(hashSessionToken(token)) : null;
}

function createNativeSession(userId: number): { token: string; expiresAt: string } {
  const token = createSessionToken();
  const expiresAt = new Date(Date.now() + sessionLifetimeMs).toISOString();
  controlDatabase.createAppSession(hashSessionToken(token), userId, expiresAt);
  return { token, expiresAt };
}

function applyNativeCors(request: IncomingMessage, response: ServerResponse): boolean {
  const origin = Array.isArray(request.headers.origin) ? request.headers.origin[0] : request.headers.origin;
  if (!origin || !nativeOrigins.has(origin)) return false;
  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Vary", "Origin");
  response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-API-Key");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  response.setHeader("Access-Control-Max-Age", "86400");
  return true;
}

function requestPath(request: IncomingMessage): string {
  try {
    return new URL(request.url ?? "/", "http://localhost").pathname;
  } catch {
    return request.url ?? "/";
  }
}

function controlErrorHandler(error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction): void {
  if (error instanceof z.ZodError) {
    response.status(400).json({ error: "请求参数不正确", details: error.issues });
    return;
  }
  const status = Number((error as { status?: number }).status ?? 0);
  const message = error instanceof Error ? error.message : "服务器错误";
  response.status(status >= 400 && status < 600 ? status : 500).json({ error: status >= 400 && status < 600 ? message : "服务器错误" });
}

const clientAuthApp = express();
clientAuthApp.disable("x-powered-by");
clientAuthApp.use(express.json({ limit: "32kb" }));

clientAuthApp.post("/api/client-auth/register", async (request, response, next) => {
  try {
    if (controlDatabase.hasAppUser()) return response.status(409).json({ error: "管理员账户已创建" });
    const input = clientRegistrationSchema.parse(request.body);
    if (!validSecret(input.inviteCode, Buffer.from(config.registrationInviteCode))) {
      return response.status(401).json({ error: "邀请码不正确" });
    }
    const user = controlDatabase.createAppUser(
      input.email,
      normalizeEmail(input.email),
      await hashPassword(input.password)
    );
    const session = createNativeSession(user.id);
    response.status(201).json({ user: { email: user.email }, ...session });
  } catch (error) {
    next(error);
  }
});

clientAuthApp.post("/api/client-auth/login", async (request, response, next) => {
  try {
    const input = clientLoginSchema.parse(request.body);
    const user = controlDatabase.getAppUserByEmail(normalizeEmail(input.email));
    if (!user) {
      await hashPassword(input.password);
      return response.status(401).json({ error: "邮箱或密码不正确" });
    }
    if (!await verifyPassword(input.password, user.passwordHash)) {
      return response.status(401).json({ error: "邮箱或密码不正确" });
    }
    const session = createNativeSession(user.id);
    response.json({ user: { email: user.email }, ...session });
  } catch (error) {
    next(error);
  }
});

clientAuthApp.get("/api/client-auth/session", (request, response) => {
  const user = nativeSessionUser(request);
  if (!user) return response.status(401).json({ error: "登录已过期" });
  response.json({ user: { email: user.email } });
});

clientAuthApp.post("/api/client-auth/logout", (request, response) => {
  const token = bearerToken(request);
  if (token) controlDatabase.deleteAppSession(hashSessionToken(token));
  response.status(204).end();
});

clientAuthApp.use(controlErrorHandler);

server.removeAllListeners("request");
server.on("request", (request, response) => {
  const nativeCors = applyNativeCors(request, response);
  if (request.method === "OPTIONS" && nativeCors) {
    response.statusCode = 204;
    response.end();
    return;
  }

  const pathname = requestPath(request);
  if (pathname.startsWith("/api/client-auth")) {
    clientAuthApp(request, response);
    return;
  }

  const token = bearerToken(request);
  if (token) {
    const user = controlDatabase.getAppUserForSession(hashSessionToken(token));
    if (!user) {
      response.statusCode = 401;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(JSON.stringify({ error: "登录已过期，请重新登录" }));
      return;
    }
    request.headers["x-api-key"] = config.apiKey;
    delete request.headers.authorization;
  }

  originalRequestListener(request, response);
});

server.once("close", () => {
  controlDatabase.close();
});
