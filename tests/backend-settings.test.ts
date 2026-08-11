import assert from "node:assert/strict";
import test from "node:test";
import { normalizeBackendSettings } from "../frontend/src/backend-settings.js";

test("normalizes local and HTTPS backend settings", () => {
  assert.deepEqual(normalizeBackendSettings({ mode: "local", serverUrl: "https://ignored.example.com" }), { mode: "local", serverUrl: "" });
  assert.deepEqual(normalizeBackendSettings({ mode: "remote", serverUrl: " https://mail.example.com/ " }), { mode: "remote", serverUrl: "https://mail.example.com" });
  assert.deepEqual(normalizeBackendSettings({ mode: "remote", serverUrl: "http://127.0.0.1:3000" }), { mode: "remote", serverUrl: "http://127.0.0.1:3000" });
});

test("rejects insecure or ambiguous remote backend URLs", () => {
  assert.throws(() => normalizeBackendSettings({ mode: "remote", serverUrl: "http://mail.example.com" }), /HTTPS/);
  assert.throws(() => normalizeBackendSettings({ mode: "remote", serverUrl: "https://mail.example.com/path" }), /只能包含/);
  assert.throws(() => normalizeBackendSettings({ mode: "remote", serverUrl: "not-a-url" }), /格式/);
});
