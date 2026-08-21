import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  finishApprovedPairing,
  pairingServiceUrl,
  pollDevicePairing,
  requestDevicePairing
} from "../device-pairing";
import { getMobileBackendUrl, isNativeMobile, setMobileBackendUrl, testMobileBackend } from "../mobile-backend";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function MobileBackendGate({ children }: { children: ReactNode }) {
  const nativeMobile = useMemo(() => isNativeMobile(), []);
  const [configured, setConfigured] = useState(() => !nativeMobile || Boolean(getMobileBackendUrl()));
  const [mode, setMode] = useState<"pair" | "direct">("pair");
  const [url, setUrl] = useState(() => getMobileBackendUrl() || pairingServiceUrl());
  const [code, setCode] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);

  if (configured) return <>{children}</>;

  async function submitDirect(event: FormEvent) {
    event.preventDefault();
    setChecking(true);
    setError("");
    setStatus("");
    try {
      const backend = await testMobileBackend(url);
      setMobileBackendUrl(backend);
      setConfigured(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法连接 Mail Collector 服务");
    } finally {
      setChecking(false);
    }
  }

  async function submitPairing(event: FormEvent) {
    event.preventDefault();
    setChecking(true);
    setError("");
    setStatus("正在提交配对请求…");
    try {
      const session = await requestDevicePairing(url, code);
      setStatus("请求已发送，请在电脑上批准此设备…");
      const deadline = Date.parse(session.expiresAt);
      while (Date.now() < deadline) {
        await delay(1500);
        const result = await pollDevicePairing(session);
        if (result.status === "approved") {
          await finishApprovedPairing(result);
          setStatus("配对成功");
          setConfigured(true);
          return;
        }
        if (result.status === "rejected") throw new Error("电脑已拒绝此配对请求");
        if (result.status === "expired") throw new Error("配对码已过期，请重新生成");
      }
      throw new Error("配对码已过期，请重新生成");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "设备配对失败");
      setStatus("");
    } finally {
      setChecking(false);
    }
  }

  return <main className="mobile-backend-setup">
    <form className="mobile-backend-card" onSubmit={mode === "pair" ? submitPairing : submitDirect}>
      <div className="mobile-backend-logo">M</div>
      <h1>连接 Mail Collector</h1>
      <p>{mode === "pair" ? "在电脑端设置中生成配对码，即可安全连接并继承同步配置。" : "直接连接一台正在运行 Mail Collector 服务的电脑或服务器。"}</p>
      <div className="mobile-backend-modes">
        <button type="button" className={mode === "pair" ? "active" : ""} onClick={() => setMode("pair")} disabled={checking}>配对码</button>
        <button type="button" className={mode === "direct" ? "active" : ""} onClick={() => setMode("direct")} disabled={checking}>直接连接</button>
      </div>
      <label>
        <span>服务地址</span>
        <input
          autoCapitalize="none"
          autoCorrect="off"
          inputMode="url"
          placeholder="https://mail.example.com"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          disabled={checking}
        />
      </label>
      {mode === "pair" ? <label>
        <span>6 位配对码</span>
        <input
          autoCapitalize="none"
          autoCorrect="off"
          inputMode="numeric"
          maxLength={6}
          placeholder="123456"
          value={code}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
          disabled={checking}
        />
      </label> : null}
      {status ? <div className="mobile-backend-status">{status}</div> : null}
      {error ? <div className="mobile-backend-error">{error}</div> : null}
      <button type="submit" disabled={checking || !url.trim() || (mode === "pair" && code.length !== 6)}>
        {checking ? (mode === "pair" ? "等待电脑批准…" : "正在连接…") : (mode === "pair" ? "请求配对" : "连接并进入邮箱")}
      </button>
      <small>{mode === "pair" ? "配对码有效期为 5 分钟。" : "也支持局域网地址，例如 http://192.168.1.10:3000"}</small>
    </form>
  </main>;
}