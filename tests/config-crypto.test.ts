import assert from "node:assert/strict";
import test from "node:test";
import { decryptConfig, encryptConfig } from "../frontend/src/config-crypto.js";

test("encrypts cloud configuration with an administrator-provided key", async () => {
  const key = "12".repeat(32);
  const value = { accounts: [{ email: "user@example.com", password: "secret" }] };
  const first = await encryptConfig(value, key);
  const second = await encryptConfig(value, key);
  assert.notEqual(first.iv, second.iv);
  assert.notEqual(first.ciphertext, second.ciphertext);
  assert.deepEqual(await decryptConfig(first, key), value);
  await assert.rejects(() => decryptConfig(first, "34".repeat(32)), /密钥不正确/);
  await assert.rejects(() => decryptConfig({ ...first, ciphertext: `${first.ciphertext.slice(0, -1)}A` }, key), /配置已损坏/);
});

test("rejects malformed administrator sync keys", async () => {
  await assert.rejects(() => encryptConfig({}, "short"), /64 位十六进制/);
});
