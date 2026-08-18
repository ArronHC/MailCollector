import assert from "node:assert/strict";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { OAuthManager } from "../src/oauth.js";
import type { MailAccount } from "../src/types.js";

function manager(googleClientId = "google-public-client", microsoftClientId = "microsoft-public-client") {
  return new OAuthManager({
    encryptionKey: crypto.randomBytes(32),
    databasePath: path.join(os.tmpdir(), `mail-collector-oauth-${crypto.randomUUID()}.db`),
    port: 43210,
    googleClientId,
    microsoftClientId
  });
}

test("Google OAuth starts an authorization-code PKCE flow without a client secret", () => {
  const oauth = manager();
  const { flowId, authorizationUrl } = oauth.start("google");
  const url = new URL(authorizationUrl);

  assert.match(flowId, /^[0-9a-f-]{36}$/i);
  assert.equal(url.origin, "https://accounts.google.com");
  assert.equal(url.pathname, "/o/oauth2/v2/auth");
  assert.equal(url.searchParams.get("client_id"), "google-public-client");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:43210");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.ok(url.searchParams.get("code_challenge"));
  assert.ok(url.searchParams.get("state"));
  assert.ok(url.searchParams.get("nonce"));
  assert.match(url.searchParams.get("scope") ?? "", /https:\/\/mail\.google\.com\//);
  assert.equal(url.searchParams.has("client_secret"), false);
});

test("Microsoft OAuth uses the native-app localhost callback and mail protocol scopes", () => {
  const oauth = manager();
  const { authorizationUrl } = oauth.start("microsoft");
  const url = new URL(authorizationUrl);

  assert.equal(url.origin, "https://login.microsoftonline.com");
  assert.equal(url.pathname, "/common/oauth2/v2.0/authorize");
  assert.equal(url.searchParams.get("client_id"), "microsoft-public-client");
  assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:43210");
  const scope = url.searchParams.get("scope") ?? "";
  assert.match(scope, /IMAP\.AccessAsUser\.All/);
  assert.match(scope, /SMTP\.Send/);
  assert.match(scope, /offline_access/);
});

test("OAuth markers are encrypted and distinguish OAuth accounts from legacy passwords", () => {
  const oauth = manager();
  const marker = oauth.marker("google");
  const account = { encryptedPassword: marker } as MailAccount;
  assert.doesNotMatch(marker, /oauth-v1:google/);
  assert.equal(oauth.providerForAccount(account), "google");
  assert.equal(oauth.providerForAccount({ encryptedPassword: "not-encrypted" } as MailAccount), null);
});

test("OAuth is disabled cleanly when a provider client ID is not configured", () => {
  const oauth = manager("", "microsoft-public-client");
  assert.equal(oauth.available("google"), false);
  assert.equal(oauth.available("microsoft"), true);
  assert.throws(() => oauth.start("google"), (error: unknown) => {
    const value = error as Error & { status?: number };
    return value.status === 503 && /Google OAuth Client ID/.test(value.message);
  });
});
