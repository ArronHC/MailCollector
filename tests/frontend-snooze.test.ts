import assert from "node:assert/strict";
import test from "node:test";
import { snoozeDate } from "../frontend/src/data/snooze.ts";

test("later today stays in the future before 18:00", () => {
  const now = new Date(2026, 7, 17, 10, 30, 0, 0);
  const result = snoozeDate("later_today", now);
  assert.equal(result.getFullYear(), 2026);
  assert.equal(result.getMonth(), 7);
  assert.equal(result.getDate(), 17);
  assert.equal(result.getHours(), 18);
  assert.ok(result.getTime() > now.getTime());
});

test("later today rolls to tomorrow morning after 18:00", () => {
  const now = new Date(2026, 7, 17, 20, 0, 0, 0);
  const result = snoozeDate("later_today", now);
  assert.equal(result.getDate(), 18);
  assert.equal(result.getHours(), 8);
  assert.ok(result.getTime() > now.getTime());
});

test("tomorrow is next day at 08:00", () => {
  const now = new Date(2026, 7, 17, 10, 30, 0, 0);
  const result = snoozeDate("tomorrow", now);
  assert.equal(result.getDate(), 18);
  assert.equal(result.getHours(), 8);
});

test("next monday always advances to a future Monday", () => {
  const monday = new Date(2026, 7, 17, 10, 30, 0, 0);
  const result = snoozeDate("next_monday", monday);
  assert.equal(result.getDay(), 1);
  assert.equal(result.getDate(), 24);
  assert.equal(result.getHours(), 8);
  assert.ok(result.getTime() > monday.getTime());
});
