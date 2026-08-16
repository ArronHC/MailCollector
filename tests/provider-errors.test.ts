import assert from "node:assert/strict";
import test from "node:test";
import { classifyProviderError, parseRetryAfterMs, retryDelayMs } from "../src/provider-errors.js";

test("parses Retry-After delta seconds", () => {
  assert.equal(parseRetryAfterMs("120", 1_000), 120_000);
  assert.equal(parseRetryAfterMs(" 1.5 ", 1_000), 1_500);
});

test("parses Retry-After HTTP dates", () => {
  const now = Date.parse("2026-08-17T00:00:00Z");
  assert.equal(parseRetryAfterMs("Mon, 17 Aug 2026 00:02:00 GMT", now), 120_000);
  assert.equal(parseRetryAfterMs("Mon, 17 Aug 2026 00:00:00 GMT", now), 0);
});

test("ignores malformed Retry-After values", () => {
  assert.equal(parseRetryAfterMs(undefined), null);
  assert.equal(parseRetryAfterMs("not-a-date"), null);
});

test("rate-limited errors preserve Retry-After for scheduling", () => {
  const error = Object.assign(new Error("Too many requests"), {
    status: 429,
    response: { headers: { "retry-after": "3" } }
  });
  const classified = classifyProviderError(error);
  assert.equal(classified.kind, "rate_limited");
  assert.equal(classified.retryable, true);
  assert.equal(classified.retryAfterMs, 3_000);
  assert.equal(retryDelayMs(1, classified.retryAfterMs, () => 0), 3_000);
});
