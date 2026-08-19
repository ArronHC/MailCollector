import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { getMobileBackendUrl, isNativeMobile, setMobileBackendUrl, testMobileBackend } from "../mobile-backend";

export function MobileBackendGate({ children }: { children: ReactNode }) {
  const nativeMobile = useMemo(() => isNativeMobile(), []);
  const [configured, setConfigured] = useState(() => !nativeMobile || Boolean(getMobileBackendUrl()));
  const [url, setUrl] = useState(() => getMobileBackendUrl());
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);

  if (configured) return <>{children}</>;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setChecking(true);
    setError("");
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

  return <main className="mobile-backend-setup">
    <form className="mobile-backend-card" onSubmit={submit}>
      <div className="mobile-backend-logo">M</div>
      <h1>连接 Mail Collector</h1>
      <p>手机版需要连接一台正在运行 Mail Collector 服务的电脑或服务器。</p>
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
      {error ? <div className="mobile-backend-error">{error}</div> : null}
      <button type="submit" disabled={checking || !url.trim()}>{checking ? "正在连接…" : "连接并进入邮箱"}</button>
      <small>也支持局域网地址，例如 http://192.168.1.10:3000</small>
    </form>
  </main>;
}
