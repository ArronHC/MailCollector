import crypto from "node:crypto";

export type SyncOperationType =
  | "read"
  | "unread"
  | "star"
  | "unstar"
  | "archive"
  | "trash"
  | "restore"
  | "label";

export type DevicePlatform = "windows" | "android" | "web";

export type SyncCursor = {
  deviceId: string;
  revision: number;
};

export type SyncOperation = {
  id: string;
  revision: number;
  deviceId: string;
  type: SyncOperationType;
  messageId: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type DeviceRecord = {
  id: string;
  name: string;
  platform: DevicePlatform;
  lastSeenAt: string;
  lastSyncRevision: number;
};

export function createDeviceId(): string {
  return crypto.randomUUID();
}

export function createOperationId(): string {
  return crypto.randomUUID();
}

export function createInitialCursor(deviceId: string): SyncCursor {
  return { deviceId, revision: 0 };
}

export function shouldApplyOperation(
  currentRevision: number,
  incomingRevision: number
): boolean {
  return incomingRevision > currentRevision;
}
