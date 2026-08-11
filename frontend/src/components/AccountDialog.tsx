import { useEffect, useState } from "react";
import { LoaderCircle, X } from "lucide-react";
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

export function AccountDialog({ open, providers, accounts, busy, error, onClose, onSubmit, onSync, onToggle, onDelete }: AccountDialogProps) {
  const [form, setForm] = useState<AccountForm>(emptyForm);
  const presence = usePresence(open, 200);

  useEffect(() => {
    if (open && providers.length && !providers.some((provider) => provider.id === form.provider)) {
      const provider = providers[0];
      if (provider) setForm({ ...emptyForm, provider: provider.id, name: provider.name, host: provider.host, port: provider.port, secure: provider.secure });
    }
  }, [open, providers, form.provider]);

  if (!presence.rendered) return null;
  function selectProvider(id: string) {
    const provider = providers.find((item) => item.id === id);
    if (provider) setForm((current) => ({ ...current, provider: id, name: provider.id === "custom" ? current.name : provider.name.split(" /")[0] || provider.name, host: provider.host, port: provider.port, secure: provider.secure }));
  }
  return (
    <div className={`dialog-backdrop${presence.closing ? " closing" : ""}`} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <section className="account-dialog" role="dialog" aria-modal="true" aria-labelledby="account-dialog-title">
        <header><div><span>邮箱连接</span><h2 id="account-dialog-title">管理邮箱账户</h2></div><button className="icon-button" onClick={onClose} disabled={busy} aria-label="关闭"><X /></button></header>
        {accounts.length ? <div className="managed-accounts">{accounts.map((account) => <div className="managed-account" key={account.id}><div><strong>{account.name}</strong><span>{account.email}</span><small className={account.status}>{account.status === "syncing" ? "正在同步" : account.status === "error" ? account.lastError : account.status === "disabled" ? "已停用" : account.lastSyncAt ? `上次同步：${new Date(account.lastSyncAt).toLocaleString("zh-CN")}` : "尚未同步"}</small></div><div><button onClick={() => void onSync(account)} disabled={busy || !account.enabled}>同步</button><button onClick={() => void onToggle(account)} disabled={busy}>{account.enabled ? "停用" : "启用"}</button><button className="danger" onClick={() => void onDelete(account)} disabled={busy}>删除</button></div></div>)}</div> : null}
        <form onSubmit={(event) => { event.preventDefault(); void onSubmit(form).then(() => setForm(emptyForm)).catch(() => {}); }}>
          <h3>添加新邮箱</h3>
          <label><span>邮箱服务商</span><select value={form.provider} onChange={(event) => selectProvider(event.target.value)}>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></label>
          <div className="form-grid"><label><span>显示名称</span><input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label><label><span>邮箱地址</span><input required type="email" value={form.email} onChange={(event) => { const email = event.target.value; setForm((current) => ({ ...current, email, username: !current.username || current.username === current.email ? email : current.username })); }} /></label></div>
          <label><span>IMAP 用户名</span><input required value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} placeholder="通常为完整邮箱地址" /></label>
          <label><span>应用密码 / 授权码</span><input required type="password" autoComplete="new-password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} /></label>
          <div className="form-grid compact"><label><span>IMAP 服务器</span><input required value={form.host} onChange={(event) => setForm({ ...form, host: event.target.value })} /></label><label><span>端口</span><input required type="number" min="1" max="65535" value={form.port} onChange={(event) => setForm({ ...form, port: Number(event.target.value) })} /></label></div>
          <label className="secure-field"><input type="checkbox" checked={form.secure} onChange={(event) => setForm({ ...form, secure: event.target.checked })} /><span>使用 TLS 加密连接</span></label>
          <p className="account-help">Gmail、iCloud 通常需要应用专用密码；QQ、网易邮箱请使用 IMAP 授权码。</p>
          <footer><span className="dialog-error">{error}</span><button className="dialog-primary" type="submit" disabled={busy}>{busy ? <><LoaderCircle className="spinning" />正在测试连接</> : "测试并添加"}</button></footer>
        </form>
      </section>
    </div>
  );
}

export type { AccountForm };
