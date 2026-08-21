import { useEffect, useState } from "react";
import { api, type RelayStatus } from "../api";

function relayStateLabel(status: RelayStatus | null): string {
  if (!status) return "正在读取…";
  if (!status.available) return "当前运行时未包含 FRP";
  if (!status.configured) return "尚未配置";
  if (!status.enabled) return "已停用";
  if (status.publicReachable) return `公网可用${status.lastProbeLatencyMs !== null ? ` · ${status.lastProbeLatencyMs} ms` : ""}`;
  if (status.tunnelConnected) return "隧道已连接 · 等待 HTTPS 入口";
  if (status.processRunning) return "FRP 正在连接 VPS";
  return "未连接";
}

export function VpsRelaySettings() {
  const [status, setStatus] = useState<RelayStatus | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [serverAddr, setServerAddr] = useState("");
  const [serverPort, setServerPort] = useState("7000");
  const [remotePort, setRemotePort] = useState("23001");
  const [publicUrl, setPublicUrl] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function applyStatus(next: RelayStatus) {
    setStatus(next);
    setEnabled(next.enabled);
    setServerAddr(next.serverAddr);
    setServerPort(String(next.serverPort));
    setRemotePort(String(next.remotePort));
    setPublicUrl(next.publicUrl);
  }

  async function refresh() {
    try {
      applyStatus(await api.relayStatus());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法读取 VPS Relay 状态");
    }
  }

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (enabled) void api.relayStatus().then(applyStatus).catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [enabled]);

  async function save() {
    setBusy(true);
    setError("");
    try {
      const next = await api.configureRelay({
        enabled,
        serverAddr,
        serverPort: Number(serverPort),
        remotePort: Number(remotePort),
        publicUrl,
        authToken: authToken.trim() || undefined
      });
      applyStatus(next);
      setAuthToken("");
      if (enabled) {
        try {
          applyStatus(await api.testRelay());
        } catch (reason) {
          await refresh();
          setError(reason instanceof Error ? reason.message : "Relay 已保存，但公网入口暂时不可达");
        }
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法保存 VPS Relay 配置");
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setError("");
    try {
      applyStatus(await api.testRelay());
    } catch (reason) {
      await refresh();
      setError(reason instanceof Error ? reason.message : "公网入口测试失败");
    } finally {
      setBusy(false);
    }
  }

  return <section className="settings-section">
    <header><div><h3>VPS Relay</h3><p>让桌面端主动连接你的 VPS，手机只访问固定 HTTPS 地址，不开放 Windows 本机端口。</p></div></header>
    <div className="setting-row">
      <div><strong>启用中转</strong><span>{relayStateLabel(status)}</span></div>
      <div className="setting-control"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /></div>
    </div>
    <div className="pairing-offer">
      <label><span>VPS 地址</span><input autoCapitalize="none" autoCorrect="off" value={serverAddr} onChange={(event) => setServerAddr(event.target.value)} placeholder="relay.example.com 或 VPS IP" /></label>
      <label><span>FRP 服务端口</span><input inputMode="numeric" value={serverPort} onChange={(event) => setServerPort(event.target.value.replace(/\D/g, ""))} placeholder="7000" /></label>
      <label><span>Relay 远端端口</span><input inputMode="numeric" value={remotePort} onChange={(event) => setRemotePort(event.target.value.replace(/\D/g, ""))} placeholder="23001" /></label>
      <label><span>手机 HTTPS 地址</span><input autoCapitalize="none" autoCorrect="off" inputMode="url" value={publicUrl} onChange={(event) => setPublicUrl(event.target.value)} placeholder="https://mail.example.com" /></label>
      <label><span>Relay Token</span><input type="password" autoComplete="new-password" value={authToken} onChange={(event) => setAuthToken(event.target.value)} placeholder={status?.hasAuthToken ? "已安全保存，留空保持不变" : "与 frps 配置中的 auth.token 相同"} /></label>
      <small>VPS 上建议让 frps 的代理端口只监听 127.0.0.1，再由 Nginx / Caddy 把 HTTPS 域名反代到此远端端口。</small>
    </div>
    <div className="setting-row">
      <div><strong>连接控制</strong><span>保存后会自动启动并随 Mail Collector 退出；断线时 frpc 会持续重连。</span></div>
      <div className="setting-control pairing-actions">
        <button type="button" onClick={() => void test()} disabled={busy || !status?.enabled || !status.configured}>测试公网入口</button>
        <button type="button" className="primary-action" onClick={() => void save()} disabled={busy}>{busy ? "处理中…" : "保存并应用"}</button>
      </div>
    </div>
    {status?.lastError ? <div className="mobile-backend-error">{status.lastError}</div> : null}
    {error ? <div className="mobile-backend-error">{error}</div> : null}
  </section>;
}
