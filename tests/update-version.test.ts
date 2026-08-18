import assert from "node:assert/strict";
import test from "node:test";
import { compareVersions, expectedWindowsInstaller, hasInstallableWindowsAssets, parseVersion, releaseVersion, type LatestRelease } from "../frontend/src/update.js";

test("parseVersion accepts release tags and semantic versions", () => {
  assert.deepEqual(parseVersion("v0.9.0"), { major: 0, minor: 9, patch: 0 });
  assert.deepEqual(parseVersion("1.2.3"), { major: 1, minor: 2, patch: 3 });
  assert.deepEqual(parseVersion("2.0.1+build.5"), { major: 2, minor: 0, patch: 1 });
  assert.equal(parseVersion("latest"), null);
});

test("compareVersions compares numeric semantic version parts", () => {
  assert.equal(compareVersions("0.8.0", "0.9.0"), -1);
  assert.equal(compareVersions("1.10.0", "1.9.9"), 1);
  assert.equal(compareVersions("v2.0.0", "2.0.0"), 0);
});

test("release helpers require installer and checksum assets", () => {
  const version = "0.9.0";
  const installer = expectedWindowsInstaller(version);
  const release: LatestRelease = {
    tag_name: `v${version}`,
    name: "Mail Collector v0.9.0",
    body: null,
    published_at: "2026-08-18T00:00:00Z",
    draft: false,
    prerelease: false,
    assets: [
      { name: installer, browser_download_url: "https://example.test/setup.exe", size: 1 },
      { name: `${installer}.sha256`, browser_download_url: "https://example.test/setup.exe.sha256", size: 64 }
    ]
  };
  assert.equal(releaseVersion(release), version);
  assert.equal(hasInstallableWindowsAssets(release, version), true);
  release.assets.pop();
  assert.equal(hasInstallableWindowsAssets(release, version), false);
});
