import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Download, LoaderCircle, RefreshCw, X } from "lucide-react";
import { compareVersions, hasInstallableWindowsAssets, latestReleaseApiUrl, releaseVersion, type LatestRelease } from "../update";
import "../update-notice.css";

const dismissedKey = "mailCollectorDismissedUpdate";
const refreshIntervalMs = 6 * 60 * 60 * 1000;

function isTauriRuntime(): boolean {
  return Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

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
  const desktop = isTauriRuntime();
  const currentVersion = __MAIL_COLLECTOR_VERSION__;
  const latestVersion = release ? releaseVersion(release) : null;
  const updateAvailable = Boolean(latestVersion && compareVersions(currentVersion, latestVersion) < 0 && !release?.draft && !release?.prerelease);
  const installable = Boolean(desktop && latestVersion && release && hasInstallableWindowsAssets(release, latestVersion));

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

  async function install() {
    if (!installable) return;
    setInstalling(true);
    setError("");
    try {
      await invoke("install_update", { version: visibleVersion });
    } catch (failure) {
      setInstalling(false);
      setError(failure instanceof Error ? failure.message : "更新安装失败");
    }
  }

  function dismiss() {
    sessionStorage.setItem(dismissedKey, visibleVersion);
    setDismissed(visibleVersion);
  }

  return <aside className="update-notice" aria-live="polite">
    <button className="update-dismiss" type="button" aria-label="稍后提醒" onClick={dismiss}><X /></button>
    <div className="update-heading"><span>新版本可用</span><strong>v{visibleVersion}</strong></div>
    <p className="update-version">当前 v{currentVersion} · {visibleRelease.name || `Mail Collector v${visibleVersion}`}</p>
    <p className="update-summary">{releaseSummary(visibleRelease)}</p>
    {desktop
      ? <p className="update-mode">{installable ? "可直接在应用内下载，校验 SHA-256 后静默更新并重新打开。" : "此版本暂缺可验证的 Windows 安装资产，请稍后重新检查。"}</p>
      : <p className="update-mode">当前是浏览器 / 容器客户端。请由部署管理员更新服务镜像，完成后刷新页面即可。</p>}
    {error ? <p className="update-error">{error}</p> : null}
    <div className="update-actions">
      {desktop && installable ? <button className="update-primary" type="button" disabled={installing} onClick={() => void install()}>{installing ? <><LoaderCircle className="spinning" />正在下载并校验</> : <><Download />下载并安装</>}</button> : null}
      <button type="button" disabled={checking || installing} onClick={() => void check(true)}>{checking ? <LoaderCircle className="spinning" /> : <RefreshCw />}重新检查</button>
    </div>
  </aside>;
}
