import test from "node:test";
import assert from "node:assert/strict";
import { relativeDetailTime } from "../frontend/src/data/mailData.js";

const now = Date.parse("2026-08-17T00:00:00.000Z");

test("relativeDetailTime shows just now under one minute", () => {
  assert.equal(relativeDetailTime("2026-08-16T23:59:30.000Z", now), "刚刚");
});

test("relativeDetailTime shows minutes under one hour", () => {
  assert.equal(relativeDetailTime("2026-08-16T23:57:00.000Z", now), "3 分钟前");
});

test("relativeDetailTime shows hours for same-day older mail", () => {
  assert.equal(relativeDetailTime("2026-08-16T21:00:00.000Z", now), "3 小时前");
});

test("relativeDetailTime omits future and day-old relative labels", () => {
  assert.equal(relativeDetailTime("2026-08-17T00:01:00.000Z", now), "");
  assert.equal(relativeDetailTime("2026-08-16T00:00:00.000Z", now), "");
});
