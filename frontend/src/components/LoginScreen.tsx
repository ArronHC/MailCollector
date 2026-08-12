import { useEffect, useState } from "react";
import { ArrowRight, AtSign, Eye, EyeOff, Inbox, KeyRound, LockKeyhole, ShieldCheck, Sparkles, TicketCheck, UserPlus } from "lucide-react";
import { CollectorMark } from "./BrandIcons";

type AuthMode = "login" | "register" | "key";

interface LoginScreenProps {
  registered: boolean;
  onSignIn: (email: string, password: string) => Promise<void>;
  onRegister: (email: string, password: string, inviteCode: string) => Promise<void>;
  onKeySignIn: (key: string) => Promise<void>;
}

export function LoginScreen({ registered, onSignIn, onRegister, onKeySignIn }: LoginScreenProps) {
  const [mode, setMode] = useState<AuthMode>(registered ? "login" : "register");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [accessKey, setAccessKey] = useState("");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setMode(registered ? "login" : "register");
    setError("");
  }, [registered]);

  const canSubmit = mode === "key"
    ? Boolean(accessKey.trim())
    : mode === "register"
      ? Boolean(email.trim() && password.length >= 10 && confirmation && inviteCode.trim())
      : Boolean(email.trim() && password);

  function switchMode(next: AuthMode) {
    setMode(next);
    setVisible(false);
    setError("");
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit || busy) return;
    if (mode === "register" && password !== confirmation) {
      setError("两次输入的密码不一致");
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (mode === "register") await onRegister(email, password, inviteCode);
      else if (mode === "key") await onKeySignIn(accessKey);
      else await onSignIn(email, password);
    } catch (authError) {
      const message = authError instanceof Error ? authError.message : mode === "register" ? "注册失败" : "登录失败";
      setError(message === "未授权" ? "启动密钥不正确，请重新输入" : message);
    } finally {
      setBusy(false);
    }
  }

  const content = mode === "register"
    ? { icon: <UserPlus />, kicker: "邀请注册", title: "创建本地管理员", description: "使用邮箱和有效邀请码创建唯一的本地登录账户。", action: busy ? "正在创建" : "创建并进入" }
    : mode === "key"
      ? { icon: <KeyRound />, kicker: "兼容登录", title: "使用启动密钥", description: "输入服务启动时配置的 API Key。密钥仅保存在当前浏览器会话中。", action: busy ? "正在验证" : "使用密钥进入" }
      : { icon: <LockKeyhole />, kicker: "欢迎回来", title: "进入你的邮件空间", description: "使用注册邮箱和密码登录本地管理员账户。", action: busy ? "正在登录" : "进入收件箱" };

  return <main className="login-page">
    <section className="login-story">
      <div className="login-brand"><CollectorMark /><span>Mail Collector</span></div>
      <div className="login-copy">
        <span className="login-eyebrow"><Sparkles /> 一个安静的收件空间</span>
        <h1>所有邮箱，<br />自然汇聚在一起。</h1>
        <p>减少切换，保留专注。邮件、草稿与标签都清晰呈现。</p>
      </div>
      <div className="login-features">
        <div><Inbox /><span><strong>统一收件箱</strong><small>集中浏览多个邮箱账户</small></span></div>
        <div><ShieldCheck /><span><strong>本地优先</strong><small>凭据加密保存在你的设备</small></span></div>
      </div>
      <div className="login-orbit orbit-one" /><div className="login-orbit orbit-two" />
    </section>
    <section className="login-panel">
      <form className="login-card" onSubmit={submit}>
        <div className="login-card-icon">{content.icon}</div>
        <span className="login-kicker">{content.kicker}</span>
        <h2>{content.title}</h2>
        <p>{content.description}</p>
        <div className="login-fields">
          {mode !== "key" ? <label className="login-field"><span>邮箱</span><div><AtSign /><input required type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" autoComplete="email" autoFocus /></div></label> : null}
          {mode !== "key" ? <label className="login-field"><span>密码</span><div><LockKeyhole /><input type={visible ? "text" : "password"} value={password} onChange={(event) => setPassword(event.target.value)} placeholder={mode === "register" ? "至少 10 个字符" : "输入密码"} autoComplete={mode === "register" ? "new-password" : "current-password"} autoFocus={mode === "login"} /><button type="button" onClick={() => setVisible((value) => !value)} aria-label={visible ? "隐藏密码" : "显示密码"}>{visible ? <EyeOff /> : <Eye />}</button></div></label> : null}
          {mode === "register" ? <label className="login-field"><span>确认密码</span><div><LockKeyhole /><input type={visible ? "text" : "password"} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder="再次输入密码" autoComplete="new-password" /></div></label> : null}
          {mode === "register" ? <label className="login-field"><span>邀请码</span><div><TicketCheck /><input type="password" value={inviteCode} onChange={(event) => setInviteCode(event.target.value)} placeholder="输入管理员提供的邀请码" autoComplete="off" /></div></label> : null}
          {mode === "key" ? <label className="login-field"><span>启动密钥</span><div><KeyRound /><input type={visible ? "text" : "password"} value={accessKey} onChange={(event) => setAccessKey(event.target.value)} placeholder="输入 API Key" autoComplete="current-password" autoFocus /><button type="button" onClick={() => setVisible((value) => !value)} aria-label={visible ? "隐藏密钥" : "显示密钥"}>{visible ? <EyeOff /> : <Eye />}</button></div></label> : null}
        </div>
        <div className={`login-error${error ? " visible" : ""}`} aria-live="polite">{error}</div>
        <button className="login-submit" type="submit" disabled={!canSubmit || busy}><span>{content.action}</span><ArrowRight /></button>
        <div className="login-alternatives">
          {mode === "login" ? <button type="button" onClick={() => switchMode("key")}>使用启动密钥登录</button> : null}
          {mode === "key" && registered ? <button type="button" onClick={() => switchMode("login")}>使用管理员账户登录</button> : null}
          {mode === "key" && !registered ? <button type="button" onClick={() => switchMode("register")}>返回首次注册</button> : null}
          {mode === "register" ? <button type="button" onClick={() => switchMode("key")}>暂时使用启动密钥登录</button> : null}
        </div>
        <footer><ShieldCheck /> {mode === "register" ? "邀请码验证通过后注册，完成后关闭新账户注册" : "安全连接至本地邮件服务"}</footer>
      </form>
    </section>
  </main>;
}
