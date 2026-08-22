import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RelayManager } from "../src/relay-manager.js";

function relayInput(overrides: Partial<Parameters<RelayManager["configure"]>[0]> = {}) {
  return {
    enabled: false,
    serverAddr: "relay.example.com",
    serverPort: 7000,
    remotePort: 23001,
    publicUrl: "https://mail.example.com",
    ...overrides
  };
}

test("VPS relay token is encrypted at rest and survives blank updates", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mail-collector-vps-relay-"));
  const manager = new RelayManager({
    dataDir: directory,
    runtimeDir: directory,
    localPort: 31234,
    encryptionKey: crypto.randomBytes(32)
  });
  const token = "relay-token-that-must-never-be-written-in-plaintext";
  try {
    const first = await manager.configure(relayInput({ authToken: token }));
    assert.equal(first.enabled, false);
    assert.equal(first.hasAuthToken, true);
    assert.equal(first.publicUrl, "https://mail.example.com");

    const settingsPath = path.join(directory, "relay-settings.json");
    const persisted = fs.readFileSync(settingsPath, "utf8");
    assert.equal(persisted.includes(token), false);
    const parsed = JSON.parse(persisted) as { encryptedAuthToken?: string };
    assert.ok(parsed.encryptedAuthToken);
    assert.notEqual(parsed.encryptedAuthToken, token);

    const second = await manager.configure(relayInput({ authToken: undefined }));
    assert.equal(second.hasAuthToken, true);
    assert.equal(fs.readFileSync(settingsPath, "utf8").includes(token), false);
  } finally {
    manager.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("enabled VPS relay requires an HTTPS public origin", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mail-collector-vps-relay-https-"));
  const manager = new RelayManager({
    dataDir: directory,
    runtimeDir: directory,
    localPort: 31234,
    encryptionKey: crypto.randomBytes(32)
  });
  try {
    await assert.rejects(
      manager.configure(relayInput({
        enabled: true,
        publicUrl: "http://mail.example.com",
        authToken: "relay-token-for-validation-tests"
      })),
      /必须使用 HTTPS/
    );
  } finally {
    manager.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("enabled VPS relay server address is host-only", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mail-collector-vps-relay-host-"));
  const manager = new RelayManager({
    dataDir: directory,
    runtimeDir: directory,
    localPort: 31234,
    encryptionKey: crypto.randomBytes(32)
  });
  try {
    await assert.rejects(
      manager.configure(relayInput({
        enabled: true,
        serverAddr: "https://relay.example.com:7000",
        authToken: "relay-token-for-validation-tests"
      })),
      /只填写主机名或 IP/
    );
  } finally {
    manager.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
