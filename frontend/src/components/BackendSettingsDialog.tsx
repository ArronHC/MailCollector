import { useEffect, useState } from "react";
import { CheckCircle2, HardDrive, LoaderCircle, Server, ShieldCheck, TriangleAlert } from "lucide-react";
import { backend, type BackendSettings } from "../api";
import { decryptConfig, generateConfigKey } from "../config-crypto";
import { syncCloudConfiguration } from "../config-sync";
import { Modal } from "./Ui";

export function BackendSettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [mode, setMode] = useState<BackendSettings["mode"]>("local");
  const [serverUrl, setServerUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [syncKey, setSyncKey] = useState("");
  const [remember, setRemember] = useState(false);
  const [keyTarget, setKeyTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    const current = backend.current();
    setMode(current.mode);
    setServerUrl(current.serverUrl);
    setApiKey(backend.apiKey());
    setSyncKey(backend.syncKey());
    setKeyTarget(current.mode === "remote" ? current.serverUrl : "");
    setRemember(backend.remembered());
    setStatus(null);
  }, [open]);

  function origin(value: string): string {
    try { return new URL(value.trim()).origin; } catch { return value.trim(); }
  }

  async function apply() {
    if (busy) return;
    setBusy(true);
    setStatus(null);
    try {
      const settings = backend.normalize({ mode, serverUrl });
      const result = await backend.test(settings, apiKey, syncKey);
      if (settings.mode === "remote") {
        const cloud = await backend.cloudBundle(settings, apiKey);
        if (cloud.envelope) await decryptConfig(cloud.envelope, syncKey);
      }
      await backend.save(settings, apiKey, syncKey, remember);
      const synced = settings.mode === "remote" ? await syncCloudConfiguration() : { changed: 0 };
      setStatus({ tone: "success", text: settings.mode === "remote" ? `配置同步成功${result.version ? `，服务器版本 ${result.version}` : ""}${synced.changed ? `，本机更新 ${synced.changed} 个账户` : ""}。正在刷新...` : "已关闭云配置同步。正在刷新..." });
      window.setTimeout(() => window.location.reload(), 500);
    } catch (error) {
      const message = error instanceof Error ? error.message : typeof error === "string" ? error : "连接服务器失败";
      setStatus({ tone: "error", text: message });
      setBusy(false);
    }
  }

  return <Modal open={open} title="数据与同步" onClose={onClose} className="backend-settings-modal">
    <div className="backend-settings">
      <p className="backend-intro">邮件内容始终保存在本机并由当前设备同步。云端只保存经过端到端加密的邮箱连接配置。</p>
      <div className="backend-mode-grid">
        <button className={mode === "local" ? "active" : ""} onClick={() => { if (mode !== "local") { setApiKey(""); setSyncKey(""); setKeyTarget(""); } setMode("local"); setStatus(null); }}><HardDrive /><span><strong>仅本机</strong><small>配置和邮件都只保存在当前设备</small></span></button>
        <button className={mode === "remote" ? "active" : ""} onClick={() => { if (mode !== "remote") { setApiKey(""); setSyncKey(""); setKeyTarget(""); } setMode("remote"); setRemember(false); setStatus(null); }}><Server /><span><strong>加密配置同步</strong><small>云端仅保存账户配置密文</small></span></button>
      </div>
      {mode === "remote" ? <div className="backend-fields">
        <label><span>服务器地址</span><input value={serverUrl} onChange={(event) => { const value = event.target.value; if (apiKey && keyTarget && origin(value) !== keyTarget) { setApiKey(""); setSyncKey(""); setKeyTarget(""); } setServerUrl(value); }} placeholder="https://mail.example.com" autoComplete="url" /></label>
        <label><span>API Key</span><input type="password" value={apiKey} onChange={(event) => { setApiKey(event.target.value); setKeyTarget(origin(serverUrl)); }} placeholder="服务器环境变量 API_KEY" autoComplete="current-password" /></label>
        <label><span>管理员同步密钥</span><div className="backend-key-row"><input value={syncKey} onChange={(event) => setSyncKey(event.target.value)} placeholder="64 位十六进制密钥" autoComplete="off" spellCheck={false} /><button type="button" onClick={() => setSyncKey(generateConfigKey())}>生成</button></div></label>
        <label className="backend-remember"><input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} /><span>在此设备记住 API Key 和同步密钥</span></label>
        <p className="backend-security"><ShieldCheck /> 同步密钥只在客户端用于 AES-256-GCM 加解密，不会发送到服务器。所有设备必须填写同一密钥。</p>
      </div> : <div className="backend-local-note"><HardDrive /><span>邮件与邮箱配置都保存在当前设备，不使用云端同步。</span></div>}
      {status ? <div className={`backend-status ${status.tone}`}>{status.tone === "success" ? <CheckCircle2 /> : <TriangleAlert />}<span>{status.text}</span></div> : null}
      <footer><button onClick={onClose} disabled={busy}>取消</button><button className="primary-action" onClick={() => void apply()} disabled={busy}>{busy ? <LoaderCircle className="spinning" /> : null}{busy ? "正在同步" : mode === "remote" ? "连接并同步" : "应用"}</button></footer>
    </div>
  </Modal>;
}
