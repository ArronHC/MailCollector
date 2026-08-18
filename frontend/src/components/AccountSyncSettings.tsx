import { useEffect, useState } from "react";
import { Check, Clipboard, Cloud, KeyRound, RefreshCw, Save } from "lucide-react";
import { api, type AccountSyncStatus } from "../api";

function formatSyncTime(value: string | null): string {
  if (!value) return "尚未同步";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : value;
}

export function AccountSyncSettings() {
  const [status, setStatus] = useState<AccountSyncStatus | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [relayUrl, setRelayUrl] = useState("");
  const [relayToken, setRelayToken] = useState("");
  const [syncKey, setSyncKey] = useState("");
  const [busy, setBusy] = useState<"load" | "save" | "key" | "sync" | null>("load");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const namespaceLocked = Boolean(status && status.lastCursor > 0);

  const applyStatus = (next: AccountSyncStatus) => {
    setStatus(next);
    setEnabled(next.enabled);
    setRelayUrl(next.relayUrl);
    setSyncKey(next.recoveryKey);
  };

  useEffect(() => {
    let cancelled = false;
    void api.accountSyncStatus()
      .then((next) => {
        if (!cancelled) applyStatus(next);
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!cancelled) setBusy(null);
      });
    return () => { cancelled = true; };
  }, []);

  const save = async () => {
    setBusy("save");
    setError("");
    setNotice("");
    try {
      const body: { enabled: boolean; relayUrl?: string; relayToken?: string; syncKey?: string } = { enabled };
      if (!namespaceLocked) {
        body.relayUrl = relayUrl.trim();
        body.syncKey = syncKey.trim();
      }
      if (relayToken.trim()) body.relayToken = relayToken.trim();
      const next = await api.configureAccountSync(body);
      applyStatus(next);
      setRelayToken("");
      setNotice(enabled ? "账户同步配置已保存" : "账户同步已关闭，本地邮箱不受影响");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  const ensureKey = async () => {
    setBusy("key");
    setError("");
    setNotice("");
    try {
      const result = await api.ensureAccountSyncRecoveryKey();
      applyStatus(result.status);
      setSyncKey(result.recoveryKey);
      setNotice("同步密钥已生成。请把它安全地复制到其他设备，不要发送给同步服务器。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  const copyKey = async () => {
    if (!syncKey) return;
    try {
      await navigator.clipboard.writeText(syncKey);
      setNotice("同步密钥已复制");
      setError("");
    } catch {
      setError("无法访问剪贴板，请手动复制同步密钥");
    }
  };

  const syncNow = async () => {
    setBusy("sync");
    setError("");
    setNotice("");
    try {
      const result = await api.syncAccounts();
      const next = await api.accountSyncStatus();
      applyStatus(next);
      setNotice(`同步完成：拉取 ${result.pulled}，上传 ${result.pushed}，删除 ${result.deleted}${result.conflicts ? `，处理 ${result.conflicts} 个冲突` : ""}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  return <section className="settings-section account-sync-section">
    <header><Cloud /><div><h3>账户同步</h3><p>只在设备之间同步邮箱账户配置和可续期凭据；邮件正文、附件、SQLite 与 IMAP 游标始终留在各设备本地。</p></div></header>

    {busy === "load" ? <p className="account-sync-muted">正在读取账户同步配置…</p> : <>
      <div className="setting-row"><div><strong>启用账户同步</strong><span>关闭后不会访问 relay，也不会影响本机已有邮箱。</span></div><div className="setting-control"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /></div></div>

      <div className="account-sync-fields">
        <label><span>同步服务器</span><input type="url" value={relayUrl} onChange={(event) => setRelayUrl(event.target.value)} placeholder="https://sync.example.com" autoComplete="off" disabled={namespaceLocked} title={namespaceLocked ? "已有同步历史，当前版本不支持直接切换 relay namespace" : undefined} /></label>
        <label><span>Relay Token</span><input type="password" value={relayToken} onChange={(event) => setRelayToken(event.target.value)} placeholder={status?.hasRelayToken ? "已保存，留空保持不变" : "粘贴 relay bearer token"} autoComplete="new-password" /></label>
        <label className="account-sync-key-field"><span>同步密钥 / Recovery Key</span><div><input type="text" value={syncKey} onChange={(event) => setSyncKey(event.target.value)} placeholder="mcsk1_…" spellCheck={false} autoComplete="off" disabled={namespaceLocked} title={namespaceLocked ? "已有同步历史，当前版本不支持直接轮换 Recovery Key" : undefined} /><button type="button" onClick={() => void copyKey()} disabled={!syncKey} title="复制同步密钥"><Clipboard /></button></div></label>
      </div>

      <div className="account-sync-actions">
        <button type="button" onClick={() => void ensureKey()} disabled={busy !== null || namespaceLocked}><KeyRound />{syncKey ? "显示/保留密钥" : "生成同步密钥"}</button>
        <button type="button" onClick={() => void save()} disabled={busy !== null}><Save />{busy === "save" ? "保存中…" : "保存配置"}</button>
        <button type="button" className="primary-action" onClick={() => void syncNow()} disabled={busy !== null || !status?.configured || !status.enabled}><RefreshCw />{busy === "sync" ? "同步中…" : "立即同步"}</button>
      </div>

      <div className="account-sync-state">
        <span><Check />{status?.configured ? "配置完整" : "尚未完成配置"}</span>
        <span>上次同步：{formatSyncTime(status?.lastSyncAt ?? null)}</span>
        <span>远端游标：{status?.lastCursor ?? 0}</span>
      </div>

      <p className="account-sync-security">同步服务器只保存加密 blob、revision 与 tombstone。Recovery Key 不会上传；更换设备时需要把同一个 Recovery Key 安全地带到新设备。{namespaceLocked ? " 已建立同步历史，当前版本锁定 relay URL 与 Recovery Key；Relay Token 仍可安全轮换。" : ""}</p>
      {status?.lastError ? <p className="account-sync-error">最近一次后台同步：{status.lastError}</p> : null}
      {notice ? <p className="account-sync-notice">{notice}</p> : null}
      {error ? <p className="account-sync-error">{error}</p> : null}
    </>}
  </section>;
}
