import { useEffect, useState } from "react";
import { CheckCircle2, HardDrive, LoaderCircle, Server, ShieldCheck, TriangleAlert } from "lucide-react";
import { backend, type BackendSettings } from "../api";
import { Modal } from "./Ui";

export function BackendSettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [mode, setMode] = useState<BackendSettings["mode"]>("local");
  const [serverUrl, setServerUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
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
      const result = await backend.test(settings, apiKey);
      await backend.save(settings, apiKey, remember);
      setStatus({ tone: "success", text: `连接成功${result.version ? `，服务器版本 ${result.version}` : ""}。正在切换...` });
      window.setTimeout(() => window.location.reload(), 500);
    } catch (error) {
      setStatus({ tone: "error", text: error instanceof Error ? error.message : "连接服务器失败" });
      setBusy(false);
    }
  }

  return <Modal open={open} title="数据与同步" onClose={onClose} className="backend-settings-modal">
    <div className="backend-settings">
      <p className="backend-intro">选择邮件数据实际保存和同步的位置。远端模式下，所有设备连接同一个自托管 Mail Collector 服务。</p>
      <div className="backend-mode-grid">
        <button className={mode === "local" ? "active" : ""} onClick={() => { if (mode !== "local") { setApiKey(""); setKeyTarget(""); } setMode("local"); setStatus(null); }}><HardDrive /><span><strong>本机模式</strong><small>连接当前设备内置的本地后端</small></span></button>
        <button className={mode === "remote" ? "active" : ""} onClick={() => { if (mode !== "remote") { setApiKey(""); setKeyTarget(""); } setMode("remote"); setRemember(false); setStatus(null); }}><Server /><span><strong>自托管服务器</strong><small>多台设备共用服务器上的邮件数据</small></span></button>
      </div>
      {mode === "remote" ? <div className="backend-fields">
        <label><span>服务器地址</span><input value={serverUrl} onChange={(event) => { const value = event.target.value; if (apiKey && keyTarget && origin(value) !== keyTarget) { setApiKey(""); setKeyTarget(""); } setServerUrl(value); }} placeholder="https://mail.example.com" autoComplete="url" /></label>
        <label><span>API Key</span><input type="password" value={apiKey} onChange={(event) => { setApiKey(event.target.value); setKeyTarget(origin(serverUrl)); }} placeholder="服务器环境变量 API_KEY" autoComplete="current-password" /></label>
        <label className="backend-remember"><input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} /><span>在此设备记住 API Key</span></label>
        <p className="backend-security"><ShieldCheck /> 非本机地址必须使用 HTTPS。记住密钥会将其保存在当前应用的本地 WebView 存储中。</p>
      </div> : <div className="backend-local-note"><HardDrive /><span>桌面版会继续使用自动启动的本地 sidecar 和当前设备数据库。</span></div>}
      {status ? <div className={`backend-status ${status.tone}`}>{status.tone === "success" ? <CheckCircle2 /> : <TriangleAlert />}<span>{status.text}</span></div> : null}
      <footer><button onClick={onClose} disabled={busy}>取消</button><button className="primary-action" onClick={() => void apply()} disabled={busy}>{busy ? <LoaderCircle className="spinning" /> : null}{busy ? "正在测试" : "测试并应用"}</button></footer>
    </div>
  </Modal>;
}
