import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { decryptSecret, encryptSecret } from "../src/crypto.js";

test("encrypts and decrypts a secret", () => {
  const key = crypto.randomBytes(32);
  const encrypted = encryptSecret("application-password", key);
  assert.notEqual(encrypted, "application-password");
  assert.equal(decryptSecret(encrypted, key), "application-password");
});

test("rejects a modified encrypted secret", () => {
  const key = crypto.randomBytes(32);
  const encrypted = encryptSecret("application-password", key);
  const [iv, tag, ciphertext] = encrypted.split(".");
  const modified = `${ciphertext[0] === "A" ? "B" : "A"}${ciphertext.slice(1)}`;
  assert.throws(() => decryptSecret(`${iv}.${tag}.${modified}`, key));
});
