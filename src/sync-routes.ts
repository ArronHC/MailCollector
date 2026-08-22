import express from "express";
import type { ClientSyncStore } from "./client-sync-store.js";

type User = { id: number };

export function createSyncRouter(store: ClientSyncStore, getUser: (request: express.Request) => User | null) {
  const router = express.Router();

  router.use(express.json({ limit: "32kb" }));

  router.get("/api/devices", (request, response) => {
    const user = getUser(request);
    if (!user) return response.status(401).json({ error: "未登录" });
    response.json({ devices: store.listDevices(user.id) });
  });

  router.post("/api/devices/register", (request, response) => {
    const user = getUser(request);
    if (!user) return response.status(401).json({ error: "未登录" });
    const { id, name, platform } = request.body as { id?: string; name?: string; platform?: "windows" | "android" | "web" };
    if (!id || !name || !platform) return response.status(400).json({ error: "设备信息不完整" });
    response.json({ device: store.upsertDevice(user.id, { id, name, platform }) });
  });

  router.post("/api/devices/:id/revoke", (request, response) => {
    const user = getUser(request);
    if (!user) return response.status(401).json({ error: "未登录" });
    response.json({ revoked: store.revokeDevice(user.id, request.params.id) });
  });

  router.get("/api/sync/pull", (request, response) => {
    const user = getUser(request);
    if (!user) return response.status(401).json({ error: "未登录" });
    const deviceId = String(request.headers["x-device-id"] ?? "");
    const after = Number(request.query.after ?? 0);
    if (!deviceId) return response.status(400).json({ error: "缺少设备 ID" });
    response.json(store.pull(user.id, deviceId, Number.isFinite(after) ? after : 0));
  });

  return router;
}
