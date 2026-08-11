import assert from "node:assert/strict";
import test from "node:test";
import { assertAllowedMailHost, isKnownProviderMailHost, isPublicIpAddress } from "../src/network-security.js";

test("blocks loopback, private, link-local, and reserved mail addresses", async () => {
  for (const address of ["127.0.0.1", "10.0.0.1", "169.254.1.1", "192.168.1.1", "::1", "fc00::1", "fe80::1"]) {
    assert.equal(isPublicIpAddress(address), false, address);
    await assert.rejects(assertAllowedMailHost(address, false), /不允许连接/);
  }
});

test("allows public addresses and an explicit private-network override", async () => {
  assert.equal(isPublicIpAddress("8.8.8.8"), true);
  assert.equal(isPublicIpAddress("2606:4700:4700::1111"), true);
  await assert.doesNotReject(assertAllowedMailHost("127.0.0.1", true));
});

test("allows proxy fake-IP DNS only for built-in TLS mail providers", async () => {
  assert.equal(isKnownProviderMailHost("imap.gmail.com"), true);
  assert.equal(isKnownProviderMailHost("mail.internal.example"), false);
  await assert.doesNotReject(assertAllowedMailHost("imap.gmail.com", false, true));
  await assert.rejects(assertAllowedMailHost("127.0.0.1", false, true), /不允许连接/);
});
