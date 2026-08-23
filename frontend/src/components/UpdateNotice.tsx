import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Download, LoaderCircle, RefreshCw, X } from "lucide-react";
import {
  capacitorBridge,
  clientPlatform,
  compareVersions,
  hasInstallableAndroidAssets,
  hasInstallableWindowsAssets,
  latestReleaseApiUrl,
  releaseVersion,
  type LatestRelease
} from "../update";
import "../update-notice.css";

const dismissedKey = "mailCollectorDismissedUpdate";
const refreshIntervalMs = 6 * 60 * 60 * 1000;

function releaseSummary(release: LatestRelease): string {
  const line = release.body
    ?.split("\n")
    .map((value) => value.trim())
    .find((value) => value && !value.startsWith("#"));
  return (line?.replace(/^[-*]\s*/, "") || "包含新的功能改进和问题修复。").slice(0, 140);
}

async function fetchLatestRelease(): Promise<LatestRelease> {
  const response = await fetch(latestReleaseApiUrl, {
    cache: "no-store",
    headers: { Accept: "application/vnd.github+json" }
  });
  if (!response.ok) throw new Error(`无法检查更新 (${response.status})`);
  return response.json() as Promise<LatestRelease>;
}

export function UpdateNotice() {
  const [release, setRelease] = useState<LatestRelease | null>(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState("");
  const [dismissed, setDismissed] = useState("");
  const lastCheckedAt = useRef(0);
  const platform = clientPlatform();
  const currentVersion = __MAIL_COLLECTOR_VERSION__;
  const latestVersion = release ? releaseVersion(release) : null;
  const updateAvailable = Boolean(latestVersion && compareVersions(currentVersion, latestVersion) < 0 && !release?.draft && !release?.prerelease);
  const installable = Boolean(release && latestVersion && (
    (platform === "windows" && hasInstallableWindowsAssets(release, latestVersion))
    || (platform === "android" && hasInstallableAndroidAssets(release, latestVersion))
  ));

  const check = useCallback(async (force = false) => {
    if (!force && Date.now() - lastCheckedAt.current < refreshIntervalMs) return;
    setChecking(true);
    setError("");
    try {
      const next = await fetchLatestRelease();
      lastCheckedAt.current = Date.now();
      setRelease(next);
      const nextVersion = releaseVersion(next);
      setDismissed(nextVersion && sessionStorage.getItem(dismissedKey) === nextVersion ? nextVersion : "");
    } catch (failure) {
      if (force) setError(failure instanceof Error ? failure.message : "无法检查更新");
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void check(true);
    const focus = () => { void check(); };
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
  }, [check]);

  const visibleRelease = release;
  const visibleVersion = latestVersion;
  if (!updateAvailable || !visibleRelease || !visibleVersion || dismissed === visibleVersion) return null;
  const updateRelease: LatestRelease = visibleRelease;
  const updateVersion: string = visibleVersion;

  async function install() {
    if (!installable) return;
    setInstalling(true);
    setError("");
    try {
      if (platform === "windows") {
        await invoke("install_update", { version: updateVersion });
        return;
      }
      if (platform === "android") {
        const bridge = capacitorBridge();
        if (!bridge?.nativePromise) throw new Error("当前 Android 客户端不支持应用内更新，请先安装一次新版客户端");
        await bridge.nativePromise("AppUpdate", "downloadAndInstall", { version: updateVersion });
        setInstalling(false);
      }
    } catch (failure) {
      setInstalling(false);
      setError(failure instanceof Error ? failure.message : "更新安装失败");
    }
  }

  function dismiss() {
    sessionStorage.setItem(dismissedKey, updateVersion);
    setDismissed(updateVersion);
  }

  const updateMode = platform === "windows"
    ? (installable ? "可在应用内下载、校验 SHA-256、静默升级并重新打开。" : "此版本暂缺可验证的 Windows 更新包，请稍后重新检查。")
    : platform === "android"
      ? (installable ? "可在应用内下载并校验，随后由 Android 系统确认覆盖安装。" : "此版本暂缺可验证的 Android 更新包，请稍后重新检查。")
      : "网页与 VPS 容器使用服务端版本，无需下载安装客户端更新包。";

  return <aside className="update-notice" aria-live="polite">
    <button className="update-dismiss" type="button" aria-label="稍后提醒" onClick={dismiss}><X /></button>
    <div className="update-heading"><span>新版本可用</span><strong>v{updateVersion}</strong></div>
    <p className="update-version">当前 v{currentVersion} · {updateRelease.name || `Mail Collector v${updateVersion}`}</p>
    <p className="update-summary">{releaseSummary(updateRelease)}</p>
    <p className="update-mode">{updateMode}</p>
    {error ? <p className="update-error">{error}</p> : null}
    <div className="update-actions">
      {installable ? <button className="update-primary" type="button" disabled={installing} onClick={() => void install()}>{installing ? <><LoaderCircle className="spinning" />正在下载并校验</> : <><Download />应用内更新</>}</button> : null}
      <button type="button" disabled={checking || installing} onClick={() => void check(true)}>{checking ? <LoaderCircle className="spinning" /> : <RefreshCw />}重新检查</button>
    </div>
  </aside>;
}
