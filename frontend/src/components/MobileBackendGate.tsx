import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  getMobileBackendUrl,
  isNativeClient,
  setMobileBackendUrl,
  testMobileBackend
} from "../mobile-backend";

export function MobileBackendGate({ children }: { children: ReactNode }) {
  const nativeClient = useMemo(() => isNativeClient(), []);
  const [configured, setConfigured] = useState(() => !nativeClient || Boolean(getMobileBackendUrl()));
  const [url, setUrl] = useState(() => getMobileBackendUrl());
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);

  if (configured) return <>{children}</>;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setChecking(true);
    setError("");
    setStatus("正在连接 VPS…");
    try {
      const backend = await testMobileBackend(url);
      setMobileBackendUrl(backend);
      setStatus("连接成功");
      setConfigured(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法连接 Mail Collector VPS");
      setStatus("");
    } finally {
      setChecking(false);
    }
  }

  return <main className="mobile-backend-setup">
    <form className="mobile-backend-card" onSubmit={submit}>
      <div className="mobile-backend-logo">M</div>
      <h1>连接 Mail Collector</h1>
      <p>电脑和手机都是独立客户端。请输入长期在线的 VPS Mail Collector 地址，两端都会直接从这里同步邮箱状态。</p>
      <label>
        <span>VPS 地址</span>
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
      {status ? <div className="mobile-backend-status">{status}</div> : null}
      {error ? <div className="mobile-backend-error">{error}</div> : null}
      <button type="submit" disabled={checking || !url.trim()}>
        {checking ? "正在连接…" : "连接 VPS"}
      </button>
      <small>推荐使用 HTTPS。客户端会在本地缓存最近读取过的邮件，VPS 负责与邮件服务商持续同步。</small>
    </form>
  </main>;
}
