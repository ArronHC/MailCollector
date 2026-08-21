import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { z } from "zod";
import { hashSessionToken, readCookie } from "./auth.js";
import { config } from "./config.js";
import { MailDatabase } from "./database.js";
import { createDevicePairingProtectedRouter, createDevicePairingPublicRouter } from "./device-pairing-routes.js";
import { DevicePairingManager } from "./device-pairing.js";
import { RelayManager } from "./relay-manager.js";

type CoreServerModule = typeof import("./server.js");
type RequestListener = (request: IncomingMessage, response: ServerResponse) => void;

const coreModulePath = import.meta.url.endsWith(".ts") ? "./server.js" : "./server-core.js";
const { server } = await import(coreModulePath) as CoreServerModule;
const originalRequestListener = server.listeners("request")[0] as RequestListener | undefined;
if (!originalRequestListener) throw new Error("Mail Collector HTTP request listener is unavailable");

const pairingSecret = crypto
  .createHmac("sha256", config.encryptionKey)
  .update("mail-collector-device-pairing-v1")
  .digest();
const pairingManager = new DevicePairingManager(config.databasePath, pairingSecret, "");
const controlDatabase = new MailDatabase(config.databasePath);
const pairingPublicBaseUrl = process.env.PAIRING_PUBLIC_BASE_URL?.trim() || undefined;
const sessionCookieName = "mail_collector_session";
const runtimeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const relayManager = new RelayManager({
  dataDir: path.dirname(config.databasePath),
  runtimeDir,
  localPort: config.port,
  encryptionKey: config.encryptionKey
});

const relayConfigSchema = z.object({
  enabled: z.boolean(),
  serverAddr: z.string().trim().max(253),
  serverPort: z.coerce.number().int().min(1).max(65535).default(7000),
  remotePort: z.coerce.number().int().min(1).max(65535).default(23001),
  publicUrl: z.string().trim().max(2048),
  authToken: z.string().max(1024).optional()
});

function requireDesktopSession(request: express.Request, response: express.Response, next: express.NextFunction): void {
  const token = readCookie(request.header("cookie"), sessionCookieName);
  const user = token ? controlDatabase.getAppUserForSession(hashSessionToken(token)) : null;
  if (!user) {
    response.status(401).json({ error: "请先在桌面端登录" });
    return;
  }
  response.locals.authUser = user;
  next();
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

const pairingApp = express();
pairingApp.disable("x-powered-by");
pairingApp.use(express.json({ limit: "100kb" }));
pairingApp.use("/api/device-pairing", createDevicePairingPublicRouter(pairingManager));
pairingApp.use("/api/device-pairing", requireDesktopSession);
pairingApp.use(
  "/api/device-pairing",
  createDevicePairingProtectedRouter(pairingManager, { publicBaseUrl: pairingPublicBaseUrl })
);
pairingApp.use(controlErrorHandler);

const relayApp = express();
relayApp.disable("x-powered-by");
relayApp.use(express.json({ limit: "100kb" }));
relayApp.use("/api/relay", requireDesktopSession);
relayApp.get("/api/relay/status", (_request, response) => response.json(relayManager.status()));
relayApp.put("/api/relay/config", async (request, response, next) => {
  try {
    response.json(await relayManager.configure(relayConfigSchema.parse(request.body)));
  } catch (error) {
    next(error);
  }
});
relayApp.post("/api/relay/restart", async (_request, response, next) => {
  try {
    response.json(await relayManager.restart());
  } catch (error) {
    next(error);
  }
});
relayApp.post("/api/relay/test", async (_request, response, next) => {
  try {
    response.json(await relayManager.testPublic());
  } catch (error) {
    next(error);
  }
});
relayApp.use(controlErrorHandler);

function requestPath(request: IncomingMessage): string {
  try {
    return new URL(request.url ?? "/", "http://localhost").pathname;
  } catch {
    return request.url ?? "/";
  }
}

function headerValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function rejectInvalidDevice(response: ServerResponse): void {
  response.statusCode = 401;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify({ error: "设备凭证无效或已撤销" }));
}

server.removeAllListeners("request");
server.on("request", (request, response) => {
  const pathname = requestPath(request);
  if (pathname.startsWith("/api/device-pairing")) {
    pairingApp(request, response);
    return;
  }
  if (pathname.startsWith("/api/relay")) {
    relayApp(request, response);
    return;
  }

  const deviceToken = headerValue(request.headers["x-device-token"]);
  if (deviceToken) {
    const device = pairingManager.authorizeDevice(deviceToken);
    if (!device) {
      rejectInvalidDevice(response);
      return;
    }
    request.headers["x-api-key"] = config.apiKey;
    delete request.headers["x-device-token"];
  }

  originalRequestListener(request, response);
});

server.once("close", () => {
  relayManager.close();
  pairingManager.close();
  controlDatabase.close();
});
