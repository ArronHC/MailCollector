import "dotenv/config";
import path from "node:path";

function integer(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function encryptionKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) {
    throw new Error("ENCRYPTION_KEY is required; see .env.example");
  }

  if (!/^[a-fA-F0-9]{64}$/.test(raw)) {
    throw new Error("ENCRYPTION_KEY must contain exactly 64 hexadecimal characters");
  }
  return Buffer.from(raw, "hex");
}

function requiredApiKey(): string {
  const value = process.env.API_KEY?.trim() ?? "";
  if (value.length < 24) {
    throw new Error("API_KEY is required and must contain at least 24 characters");
  }
  return value;
}

function requiredInviteCode(): string {
  const value = process.env.REGISTRATION_INVITE_CODE?.trim() ?? "";
  if (value.length < 12) {
    throw new Error("REGISTRATION_INVITE_CODE is required and must contain at least 12 characters");
  }
  return value;
}

function boolean(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

export const config = {
  port: integer("PORT", 3000),
  host: process.env.HOST?.trim() || "127.0.0.1",
  databasePath: path.resolve(process.env.DATABASE_PATH ?? "./data/mail-collector.db"),
  encryptionKey: encryptionKey(),
  apiKey: requiredApiKey(),
  registrationInviteCode: requiredInviteCode(),
  allowPrivateMailHosts: boolean("ALLOW_PRIVATE_MAIL_HOSTS", false),
  syncIntervalMinutes: integer("SYNC_INTERVAL_MINUTES", 5),
  initialSyncLimit: integer("INITIAL_SYNC_LIMIT", 100),
  maxMessageBytes: integer("MAX_MESSAGE_BYTES", 10 * 1024 * 1024)
};
