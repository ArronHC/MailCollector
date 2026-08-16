import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { decryptSecret, encryptSecret } from "../src/crypto.js";

function legacyEncrypt(value: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((part) => part.toString("base64url")).join(".");
}

test("encrypts new secrets with an explicit version and decrypts them", () => {
  const key = crypto.randomBytes(32);
  const encrypted = encryptSecret("application-password", key);
  assert.match(encrypted, /^v1\./);
  assert.notEqual(encrypted, "application-password");
  assert.equal(decryptSecret(encrypted, key), "application-password");
});

test("continues to decrypt legacy unversioned secrets", () => {
  const key = crypto.randomBytes(32);
  const encrypted = legacyEncrypt("legacy-application-password", key);
  assert.equal(decryptSecret(encrypted, key), "legacy-application-password");
});

test("rejects a modified encrypted secret", () => {
  const key = crypto.randomBytes(32);
  const encrypted = encryptSecret("application-password", key);
  const [version, iv, tag, ciphertext] = encrypted.split(".");
  const modified = `${ciphertext[0] === "A" ? "B" : "A"}${ciphertext.slice(1)}`;
  assert.throws(() => decryptSecret(`${version}.${iv}.${tag}.${modified}`, key));
});

test("rejects unknown encrypted secret versions", () => {
  const key = crypto.randomBytes(32);
  const encrypted = encryptSecret("application-password", key).replace(/^v1\./, "v99.");
  assert.throws(() => decryptSecret(encrypted, key), /Invalid encrypted value/);
});
