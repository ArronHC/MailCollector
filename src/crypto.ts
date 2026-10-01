import crypto from "node:crypto";

const CURRENT_SECRET_VERSION = "v1";

function decryptAesGcm(ivValue: string, tagValue: string, encryptedValue: string, key: Buffer): string {
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivValue, "base64url")
  );
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedValue, "base64url")),
    decipher.final()
  ]).toString("utf8");
}

export function encryptSecret(value: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [CURRENT_SECRET_VERSION, iv, tag, encrypted].map((part) => Buffer.isBuffer(part) ? part.toString("base64url") : part).join(".");
}

export function decryptSecret(value: string, key: Buffer): string {
  const parts = value.split(".");

  if (parts.length === 3) {
    // Legacy format used before ciphertexts carried an explicit version.
    return decryptAesGcm(parts[0]!, parts[1]!, parts[2]!, key);
  }

  if (parts.length !== 4 || parts[0] !== CURRENT_SECRET_VERSION) {
    throw new Error("Invalid encrypted value");
  }

  return decryptAesGcm(parts[1]!, parts[2]!, parts[3]!, key);
}
