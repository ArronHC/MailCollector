import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { createSessionToken, hashPassword, hashSessionToken, normalizeEmail, readCookie, verifyPassword } from "../src/auth.js";
import { MailDatabase } from "../src/database.js";

test("hashes passwords and rejects incorrect credentials", async () => {
  const encoded = await hashPassword("correct horse battery staple");
  assert.match(encoded, /^scrypt\$/);
  assert.equal(await verifyPassword("correct horse battery staple", encoded), true);
  assert.equal(await verifyPassword("incorrect password", encoded), false);
  assert.equal(await verifyPassword("anything", "invalid"), false);
});

test("normalizes email addresses and handles session cookies", () => {
  assert.equal(normalizeEmail("  Ａrron.User@Example.COM  "), "arron.user@example.com");
  assert.equal(readCookie("theme=dark; mail_collector_session=abc%20123; other=value", "mail_collector_session"), "abc 123");
  assert.equal(readCookie(undefined, "mail_collector_session"), "");
  const token = createSessionToken();
  assert.ok(token.length >= 40);
  assert.equal(hashSessionToken(token), hashSessionToken(token));
  assert.notEqual(hashSessionToken(token), token);
});

test("stores one administrator and expiring sessions", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mail-collector-auth-"));
  const database = new MailDatabase(path.join(directory, "test.db"));
  try {
    assert.equal(database.hasAppUser(), false);
    const passwordHash = await hashPassword("a sufficiently long password");
    const user = database.createAppUser("Arron@example.com", normalizeEmail("Arron@example.com"), passwordHash);
    assert.equal(database.hasAppUser(), true);
    assert.equal(database.getAppUserByEmail("arron@example.com")?.email, "Arron@example.com");
    assert.throws(() => database.createAppUser("other@example.com", "other@example.com", passwordHash));

    const activeToken = hashSessionToken(createSessionToken());
    database.createAppSession(activeToken, user.id, new Date(Date.now() + 60_000).toISOString());
    assert.equal(database.getAppUserForSession(activeToken)?.id, user.id);
    database.deleteAppSession(activeToken);
    assert.equal(database.getAppUserForSession(activeToken), null);

    const expiredToken = hashSessionToken(createSessionToken());
    database.createAppSession(expiredToken, user.id, new Date(Date.now() - 1_000).toISOString());
    assert.equal(database.getAppUserForSession(expiredToken), null);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("migrates legacy administrator columns to email fields", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mail-collector-auth-migration-"));
  const databasePath = path.join(directory, "test.db");
  const legacyDatabase = new Database(databasePath);
  legacyDatabase.exec(`
    CREATE TABLE app_users (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      username TEXT NOT NULL,
      normalized_username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO app_users (id, username, normalized_username, password_hash)
    VALUES (1, 'legacy@example.com', 'legacy@example.com', 'legacy-hash');
  `);
  legacyDatabase.close();

  const database = new MailDatabase(databasePath);
  try {
    assert.equal(database.getAppUserByEmail("legacy@example.com")?.email, "legacy@example.com");
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
