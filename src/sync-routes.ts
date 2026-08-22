import express from "express";
import { z } from "zod";
import type { ClientSyncStore } from "./client-sync-store.js";

type User = { id: number };

const deviceSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
  platform: z.enum(["windows", "android", "web"])
});
const renameSchema = z.object({ name: z.string().trim().min(1).max(80) });

export function createSyncRouter(store: ClientSyncStore, getUser: (request: express.Request) => User | null) {
  const router = express.Router();
  router.use(express.json({ limit: "32kb" }));

  router.get("/api/devices", (request, response) => {
    const user = getUser(request);
    if (!user) return response.status(401).json({ error: "未登录" });
    response.json({ devices: store.listDevices(user.id) });
  });

  router.post("/api/devices/register", (request, response, next) => {
    try {
      const user = getUser(request);
      if (!user) return response.status(401).json({ error: "未登录" });
      const input = deviceSchema.parse(request.body);
      response.json({ device: store.upsertDevice(user.id, input) });
    } catch (error) {
      next(error);
    }
  });

  router.patch("/api/devices/:id", (request, response, next) => {
    try {
      const user = getUser(request);
      if (!user) return response.status(401).json({ error: "未登录" });
      const input = renameSchema.parse(request.body);
      const device = store.renameDevice(user.id, request.params.id, input.name);
      if (!device) return response.status(404).json({ error: "设备不存在" });
      response.json({ device });
    } catch (error) {
      next(error);
    }
  });

  router.delete("/api/devices/:id", (request, response) => {
    const user = getUser(request);
    if (!user) return response.status(401).json({ error: "未登录" });
    response.json({ revoked: store.revokeDevice(user.id, request.params.id) });
  });

  router.get("/api/sync/pull", (request, response) => {
    const user = getUser(request);
    if (!user) return response.status(401).json({ error: "未登录" });
    const deviceId = String(request.header("x-device-id") ?? "").trim();
    const after = Number(request.query.after ?? 0);
    const limit = Number(request.query.limit ?? 250);
    if (!deviceId) return response.status(400).json({ error: "缺少设备 ID" });
    response.json(store.pull(
      user.id,
      deviceId,
      Number.isFinite(after) && after >= 0 ? Math.floor(after) : 0,
      Number.isFinite(limit) ? Math.floor(limit) : 250
    ));
  });

  router.post("/api/sync/ack", (request, response) => {
    const user = getUser(request);
    if (!user) return response.status(401).json({ error: "未登录" });
    const deviceId = String(request.header("x-device-id") ?? "").trim();
    const revision = Number((request.body as { revision?: unknown })?.revision ?? 0);
    if (!deviceId || !Number.isFinite(revision) || revision < 0) {
      return response.status(400).json({ error: "同步游标无效" });
    }
    store.ack(user.id, deviceId, Math.floor(revision));
    response.json({ ok: true });
  });

  return router;
}
