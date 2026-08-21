import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import express from "express";
import { hashSessionToken, readCookie } from "./auth.js";
import { config } from "./config.js";
import { MailDatabase } from "./database.js";
import { createDevicePairingProtectedRouter, createDevicePairingPublicRouter } from "./device-pairing-routes.js";
import { DevicePairingManager } from "./device-pairing.js";

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
const pairingAuthDatabase = new MailDatabase(config.databasePath);
const pairingPublicBaseUrl = process.env.PAIRING_PUBLIC_BASE_URL?.trim() || undefined;
const sessionCookieName = "mail_collector_session";

const pairingApp = express();
pairingApp.disable("x-powered-by");
pairingApp.use(express.json({ limit: "100kb" }));
pairingApp.use("/api/device-pairing", createDevicePairingPublicRouter(pairingManager));
pairingApp.use("/api/device-pairing", (request, response, next) => {
  const token = readCookie(request.header("cookie"), sessionCookieName);
  const user = token ? pairingAuthDatabase.getAppUserForSession(hashSessionToken(token)) : null;
  if (!user) {
    response.status(401).json({ error: "请先登录后再管理配对设备" });
    return;
  }
  response.locals.authUser = user;
  next();
});
pairingApp.use(
  "/api/device-pairing",
  createDevicePairingProtectedRouter(pairingManager, { publicBaseUrl: pairingPublicBaseUrl })
);
pairingApp.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  const status = Number((error as { status?: number }).status ?? 0);
  const message = error instanceof Error ? error.message : "服务器错误";
  response.status(status >= 400 && status < 600 ? status : 500).json({ error: status >= 400 && status < 600 ? message : "服务器错误" });
});

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
  if (requestPath(request).startsWith("/api/device-pairing")) {
    pairingApp(request, response);
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
  pairingManager.close();
  pairingAuthDatabase.close();
});
