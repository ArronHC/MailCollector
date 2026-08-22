import crypto from "node:crypto";
import express from "express";
import { z } from "zod";
import { DevicePairingManager } from "./device-pairing.js";

const pairingCodeSchema = z.string().transform((value) => value.replace(/\D/g, "")).pipe(z.string().length(6));
const publicKeySchema = z.string().min(40).max(2048);
const encryptedBundleSchema = z.string().min(20).max(16_000);
const deviceIdSchema = z.string().uuid();
const deviceTokenHashSchema = z.string().regex(/^[a-f0-9]{64}$/i);

const joinSchema = z.object({
  code: pairingCodeSchema,
  deviceName: z.string().trim().min(1).max(120),
  platform: z.string().trim().min(1).max(40),
  requesterPublicKey: publicKeySchema
});

const pollSchema = z.object({
  joinToken: z.string().min(32).max(256)
});

const approveSchema = z.object({
  deviceId: deviceIdSchema,
  deviceTokenHash: deviceTokenHashSchema,
  approverPublicKey: publicKeySchema,
  encryptedBundle: encryptedBundleSchema
});

function userIdFromLocals(response: express.Response): number {
  const user = response.locals.authUser as { id?: number } | undefined;
  if (!user?.id) throw Object.assign(new Error("当前登录状态不能管理设备"), { status: 401 });
  return user.id;
}

export function createDevicePairingPublicRouter(manager: DevicePairingManager): express.Router {
  const router = express.Router();

  router.use((_request, response, next) => {
    response.set("Cache-Control", "no-store");
    next();
  });

  router.post("/join", (request, response, next) => {
    try {
      const input = joinSchema.parse(request.body);
      response.status(202).json(manager.request(input));
    } catch (error) {
      next(error);
    }
  });

  router.post("/:pairingId/poll", (request, response, next) => {
    try {
      const pairingId = z.string().uuid().parse(request.params.pairingId);
      const { joinToken } = pollSchema.parse(request.body);
      response.json(manager.poll(pairingId, joinToken));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export function createDevicePairingProtectedRouter(
  manager: DevicePairingManager,
  options: { publicBaseUrl?: string } = {}
): express.Router {
  const router = express.Router();

  router.use((_request, response, next) => {
    response.set("Cache-Control", "no-store");
    next();
  });

  router.post("/create", (request, response, next) => {
    try {
      const userId = userIdFromLocals(response);
      const created = manager.create(userId);
      const requestBaseUrl = `${request.protocol}://${request.get("host") ?? ""}`.replace(/\/$/, "");
      response.status(201).json({
        ...created,
        publicBaseUrl: options.publicBaseUrl?.replace(/\/$/, "") || requestBaseUrl
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/pending", (_request, response, next) => {
    try {
      response.json({ requests: manager.pending(userIdFromLocals(response)) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/:pairingId/approve", (request, response, next) => {
    try {
      const pairingId = z.string().uuid().parse(request.params.pairingId);
      response.status(201).json({ device: manager.approve(userIdFromLocals(response), pairingId, approveSchema.parse(request.body)) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/:pairingId/reject", (request, response, next) => {
    try {
      const pairingId = z.string().uuid().parse(request.params.pairingId);
      manager.reject(userIdFromLocals(response), pairingId);
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.get("/devices", (_request, response, next) => {
    try {
      response.json({ devices: manager.listDevices(userIdFromLocals(response)) });
    } catch (error) {
      next(error);
    }
  });

  router.delete("/devices/:deviceId", (request, response, next) => {
    try {
      const deviceId = deviceIdSchema.parse(request.params.deviceId);
      manager.revokeDevice(userIdFromLocals(response), deviceId);
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export function generateDeviceCredential(): { deviceId: string; deviceToken: string; deviceTokenHash: string } {
  const deviceId = crypto.randomUUID();
  const deviceToken = crypto.randomBytes(32).toString("base64url");
  const deviceTokenHash = crypto.createHash("sha256").update(deviceToken).digest("hex");
  return { deviceId, deviceToken, deviceTokenHash };
}
