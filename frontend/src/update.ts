export const releaseRepository = "ArronHC/MailCollector";
export const latestReleaseApiUrl = `https://api.github.com/repos/${releaseRepository}/releases/latest`;

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

export interface LatestRelease {
  tag_name: string;
  name: string | null;
  body: string | null;
  published_at: string | null;
  draft: boolean;
  prerelease: boolean;
  assets: ReleaseAsset[];
}

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

export function parseVersion(value: string): ParsedVersion | null {
  const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/i);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  return { major, minor, patch };
}

export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return 0;
  if (a.major !== b.major) return a.major > b.major ? 1 : -1;
  if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1;
  if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1;
  return 0;
}

export function releaseVersion(release: LatestRelease): string | null {
  const parsed = parseVersion(release.tag_name);
  return parsed ? `${parsed.major}.${parsed.minor}.${parsed.patch}` : null;
}

export function expectedWindowsInstaller(version: string): string {
  return `Mail.Collector_${version}_x64-setup.exe`;
}

export function hasInstallableWindowsAssets(release: LatestRelease, version: string): boolean {
  const installer = expectedWindowsInstaller(version);
  const names = new Set(release.assets.map((asset) => asset.name));
  return names.has(installer) && names.has(`${installer}.sha256`);
}
