import assert from "node:assert/strict";
import test from "node:test";
import { allowedRemoteOrigin } from "../src/remote-access.js";

test("allows loopback desktop origins only when remote clients are enabled", () => {
  assert.equal(allowedRemoteOrigin("http://127.0.0.1:43127", false, []), false);
  assert.equal(allowedRemoteOrigin("http://127.0.0.1:43127", true, []), true);
  assert.equal(allowedRemoteOrigin("http://localhost:5173", true, []), true);
  assert.equal(allowedRemoteOrigin("http://[::1]:5173", true, []), true);
});

test("allows configured HTTPS origins and rejects unrelated sites", () => {
  assert.equal(allowedRemoteOrigin("https://client.example.com", true, ["https://client.example.com/path"]), true);
  assert.equal(allowedRemoteOrigin("https://evil.example.com", true, ["https://client.example.com"]), false);
  assert.equal(allowedRemoteOrigin("http://client.example.com", true, ["http://client.example.com"]), false);
  assert.equal(allowedRemoteOrigin("not-a-url", true, []), false);
});
