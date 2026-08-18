import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { LoaderCircle, X } from "lucide-react";
import { api, type OAuthMailProvider } from "../api";
import type { MailAccount, MailProvider } from "../data/mailData";
import { usePresence } from "./Ui";

interface AccountForm {
  provider: string;
  name: string;
  email: string;
  username: string;
  password: string;
  host: string;
  port: number;
  secure: boolean;
}

const emptyForm: AccountForm = { provider: "gmail", name: "Gmail", email: "", username: "", password: "", host: "imap.gmail.com", port: 993, secure: true };

interface AccountDialogProps {
  open: boolean;
  providers: MailProvider[];
  accounts: MailAccount[];
  busy: boolean;
  error: string;
  onClose: () => void;
  onSubmit: (form: AccountForm) => Promise<void>;
  onSync: (account: MailAccount) => Promise<void>;
  onToggle: (account: MailAccount) => Promise<void>;
  onDelete: (account: MailAccount) => Promise<void>;
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex='-1'])"));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function isTauriRuntime(): boolean {
  return Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

function oauthButtonLabel(provider: OAuthMailProvider): string {
  return provider === "google" ? "使用 Google 登录" : "使用 Microsoft 登录";
}

export function AccountDialog({ open, providers, accounts, busy, error, onClose, onSubmit, onSync, onToggle, onDelete }: AccountDialogProps) {
  const [form, setForm] = useState<AccountForm>(emptyForm);
  const [manualMode, setManualMode] = useState(false);
  const [oauthBusy, setOauthBusy] = useState(false);
  const [oauthError, setOauthError] = useState("");
  const presence = usePresence(open, 200);
  const dialogRef = useRef<HTMLElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const busyRef = useRef(busy);
  const onCloseRef = useRef(onClose);
  const oauthAttemptRef = useRef(0);
  busyRef.current = busy;
  onCloseRef.current = onClose;

  const selectedProvider = providers.find((provider) => provider.id === form.provider);
  const oauthProvider = selectedProvider?.oauthProvider ?? null;
  const oauthAvailable = Boolean(oauthProvider && selectedProvider?.oauthAvailable);

  useEffect(() => {
    if (open && providers.length && !providers.some((provider) => provider.id === form.provider)) {
      const provider = providers[0];
      if (provider) {
        setForm({ ...emptyForm, provider: provider.id, name: provider.name, host: provider.host, port: provider.port, secure: provider.secure });
        setManualMode(!provider.oauthAvailable);
      }
    }
  }, [open, providers, form.provider]);

  useEffect(() => {
    if (!open) {
      oauthAttemptRef.current += 1;
      setOauthBusy(false);
      setOauthError("");
      return;
    }
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => {
      const dialog = dialogRef.current;
      if (dialog) (focusableElements(dialog)[0] ?? dialog).focus();
    });
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = focusableElements(dialog);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", keydown);
      restoreFocusRef.current?.focus();
    };
  }, [open]);

  if (!presence.rendered) return null;

  function selectProvider(id: string) {
    const provider = providers.find((item) => item.id === id);
    if (provider) {
      setForm((current) => ({ ...current, provider: id, name: provider.id === "custom" ? current.name : provider.name.split(" /")[0] || provider.name, host: provider.host, port: provider.port, secure: provider.secure }));
      setManualMode(!provider.oauthAvailable);
      setOauthError("");
    }
  }

  async function openAuthorizationUrl(url: string): Promise<void> {
    if (isTauriRuntime()) {
      try {
        await invoke("open_external_url", { url });
        return;
      } catch {
        // Fall through to the browser implementation for local web development.
      }
    }
    const opened = window.open(url, "_blank", "noopener,noreferrer");
    if (!opened) throw new Error("浏览器阻止了授权页面，请允许弹出窗口后重试");
  }

  async function connectOAuth(provider: OAuthMailProvider) {
    const attempt = ++oauthAttemptRef.current;
    setOauthBusy(true);
    setOauthError("");
    try {
      const { flowId, authorizationUrl } = await api.startOAuth(provider);
      await openAuthorizationUrl(authorizationUrl);
      for (let index = 0; index < 300; index += 1) {
        await sleep(1200);
        if (oauthAttemptRef.current !== attempt) return;
        const status = await api.oauthFlow(flowId);
        if (status.status === "success") {
          window.location.reload();
          return;
        }
        if (status.status === "error") throw new Error(status.error || "OAuth 授权失败");
      }
      throw new Error("OAuth 授权等待超时，请重新尝试");
    } catch (oauthFailure) {
      if (oauthAttemptRef.current === attempt) setOauthError(oauthFailure instanceof Error ? oauthFailure.message : "OAuth 授权失败");
    } finally {
      if (oauthAttemptRef.current === attempt) setOauthBusy(false);
    }
  }

  return (
    <div className={`dialog-backdrop${presence.closing ? " closing" : ""}`} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <section ref={dialogRef} tabIndex={-1} className="account-dialog" role="dialog" aria-modal="true" aria-labelledby="account-dialog-title">
        <header><div><span>邮箱连接</span><h2 id="account-dialog-title">管理邮箱账户</h2></div><button className="icon-button" onClick={onClose} disabled={busy} aria-label="关闭"><X /></button></header>
        {accounts.length ? <div className="managed-accounts">{accounts.map((account) => <div className="managed-account" key={account.id}><div><strong>{account.name}</strong><span>{account.email}</span><small className={account.status}>{account.status === "syncing" ? "正在同步" : account.status === "backfilling" ? "正在同步历史邮件" : account.status === "reauth_required" ? "需要重新授权" : account.status === "error" || account.status === "degraded" ? account.lastError : account.status === "disabled" ? "已停用" : account.lastSyncAt ? `上次同步：${new Date(account.lastSyncAt).toLocaleString("zh-CN")}` : "尚未同步"}</small></div><div><button onClick={() => void onSync(account)} disabled={busy || oauthBusy || !account.enabled}>同步</button><button onClick={() => void onToggle(account)} disabled={busy || oauthBusy}>{account.enabled ? "停用" : "启用"}</button><button className="danger" onClick={() => void onDelete(account)} disabled={busy || oauthBusy}>删除</button></div></div>)}</div> : null}
        <form onSubmit={(event) => { event.preventDefault(); if (!oauthProvider || manualMode || !oauthAvailable) void onSubmit(form).then(() => setForm(emptyForm)).catch(() => {}); }}>
          <h3>添加新邮箱</h3>
          <label><span>邮箱服务商</span><select value={form.provider} onChange={(event) => selectProvider(event.target.value)}>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></label>

          {oauthProvider ? <div className="account-help">
            <strong>推荐：OAuth 安全登录</strong>
            <p>{oauthAvailable ? "不会把邮箱密码交给 Mail Collector；授权会在系统浏览器中完成，并使用可撤销的 OAuth 令牌连接 IMAP/SMTP。" : "当前构建尚未配置此服务商的 OAuth Client ID，可暂时使用应用密码 / 授权码。"}</p>
            <div className="managed-account-actions">
              <button type="button" className="dialog-primary" disabled={busy || oauthBusy || !oauthAvailable} onClick={() => { if (oauthProvider) void connectOAuth(oauthProvider); }}>{oauthBusy ? <><LoaderCircle className="spinning" />等待浏览器授权</> : oauthButtonLabel(oauthProvider)}</button>
              {oauthAvailable ? <button type="button" disabled={busy || oauthBusy} onClick={() => setManualMode((value) => !value)}>{manualMode ? "返回 OAuth 登录" : "改用应用密码"}</button> : null}
            </div>
          </div> : null}

          {(!oauthProvider || manualMode || !oauthAvailable) ? <>
            <div className="form-grid"><label><span>显示名称</span><input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label><label><span>邮箱地址</span><input required type="email" value={form.email} onChange={(event) => { const email = event.target.value; setForm((current) => ({ ...current, email, username: !current.username || current.username === current.email ? email : current.username })); }} /></label></div>
            <label><span>IMAP 用户名</span><input required value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} placeholder="通常为完整邮箱地址" /></label>
            <label><span>应用密码 / 授权码</span><input required type="password" autoComplete="new-password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} /></label>
            <div className="form-grid compact"><label><span>IMAP 服务器</span><input required value={form.host} onChange={(event) => setForm({ ...form, host: event.target.value })} /></label><label><span>端口</span><input required type="number" min="1" max="65535" value={form.port} onChange={(event) => setForm({ ...form, port: Number(event.target.value) })} /></label></div>
            <label className="secure-field"><input type="checkbox" checked={form.secure} onChange={(event) => setForm({ ...form, secure: event.target.checked })} /><span>使用 TLS 加密连接</span></label>
            <p className="account-help">iCloud 通常需要应用专用密码；QQ、网易邮箱请使用 IMAP 授权码。Gmail / Microsoft 仅建议在 OAuth 不可用时使用此兼容方式。</p>
          </> : <p className="account-help">点击上方登录按钮后会打开系统浏览器。授权完成后账户会自动加入，并开始首次同步。</p>}

          <footer><span className="dialog-error">{oauthError || error}</span>{(!oauthProvider || manualMode || !oauthAvailable) ? <button className="dialog-primary" type="submit" disabled={busy || oauthBusy}>{busy ? <><LoaderCircle className="spinning" />正在测试连接</> : "测试并添加"}</button> : null}</footer>
        </form>
      </section>
    </div>
  );
}

export type { AccountForm };
