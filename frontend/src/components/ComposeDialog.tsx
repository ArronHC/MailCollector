import { useEffect, useRef, useState } from "react";
import { ChevronDown, Maximize2, Minimize2, Send, Trash2, X } from "lucide-react";
import type { DraftContent, MailAccount } from "../data/mailData";
import { usePresence } from "./Ui";

export interface ComposeSeed {
  draftId?: number;
  accountId?: number;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: string;
}

function splitAddresses(value: string): string[] {
  return value.split(/[;,]/).map((item) => item.trim()).filter(Boolean);
}

interface ComposeDialogProps {
  open: boolean;
  accounts: MailAccount[];
  seed: ComposeSeed;
  busy: boolean;
  status: string;
  onClose: (content: DraftContent, draftId?: number, discard?: boolean) => void;
  onSend: (content: DraftContent, draftId?: number) => void;
}

export function ComposeDialog({ open, accounts, seed, busy, status, onClose, onSend }: ComposeDialogProps) {
  const [minimized, setMinimized] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [showCopies, setShowCopies] = useState(false);
  const [accountId, setAccountId] = useState(0);
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [bcc, setBcc] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const wasOpen = useRef(false);
  const presence = usePresence(open, 220);

  useEffect(() => {
    if (!open) {
      wasOpen.current = false;
      return;
    }
    if (wasOpen.current) return;
    wasOpen.current = true;
    const enabledAccounts = accounts.filter((account) => account.enabled);
    const seededAccount = seed.accountId ? enabledAccounts.find((account) => account.id === seed.accountId) : undefined;
    setAccountId(seededAccount?.id ?? enabledAccounts[0]?.id ?? 0);
    setTo(seed.to?.join(", ") ?? "");
    setCc(seed.cc?.join(", ") ?? "");
    setBcc(seed.bcc?.join(", ") ?? "");
    setSubject(seed.subject ?? "");
    setBody(seed.body ?? "");
    setShowCopies(Boolean(seed.cc?.length || seed.bcc?.length));
    setMinimized(false);
    setExpanded(false);
  }, [open, seed, accounts]);

  useEffect(() => {
    if (!open || !accountId) return;
    if (accounts.some((account) => account.id === accountId && account.enabled)) return;
    setAccountId(accounts.find((account) => account.enabled)?.id ?? 0);
  }, [open, accounts, accountId]);

  if (!presence.rendered) return null;
  const content: DraftContent = { accountId, to: splitAddresses(to), cc: splitAddresses(cc), bcc: splitAddresses(bcc), subject, body };
  const hasRecipient = content.to.length + content.cc.length + content.bcc.length > 0;
  const hasContent = Boolean(to || cc || bcc || subject || body);
  const close = (discard = false) => {
    if (busy) return;
    onClose(content, seed.draftId, discard);
  };

  return <section className={`compose-window${minimized ? " minimized" : ""}${expanded ? " expanded" : ""}${presence.closing ? " closing" : ""}`} aria-label="写邮件" aria-busy={busy}>
    <header onDoubleClick={() => { if (!busy) setMinimized((value) => !value); }}><strong>{seed.draftId ? "编辑草稿" : subject || "新邮件"}</strong><div><button disabled={busy} onClick={() => setMinimized((value) => !value)} aria-label={minimized ? "恢复" : "最小化"}>{minimized ? <ChevronDown /> : <Minimize2 />}</button><button disabled={busy} onClick={() => setExpanded((value) => !value)} aria-label="切换大窗口"><Maximize2 /></button><button disabled={busy} onClick={() => close()} aria-label="保存并关闭"><X /></button></div></header>
    {!minimized ? <><div className="compose-fields"><label><span>发件人</span><select disabled={busy} value={accountId} onChange={(event) => setAccountId(Number(event.target.value))}>{accounts.filter((account) => account.enabled).map((account) => <option key={account.id} value={account.id}>{account.name} &lt;{account.email}&gt;</option>)}</select></label><label><span>收件人</span><input disabled={busy} value={to} onChange={(event) => setTo(event.target.value)} placeholder="name@example.com" autoFocus /><button disabled={busy} type="button" onClick={() => setShowCopies((value) => !value)}>抄送/密送</button></label>{showCopies ? <><label><span>抄送</span><input disabled={busy} value={cc} onChange={(event) => setCc(event.target.value)} /></label><label><span>密送</span><input disabled={busy} value={bcc} onChange={(event) => setBcc(event.target.value)} /></label></> : null}<input disabled={busy} className="compose-subject" value={subject} onChange={(event) => setSubject(event.target.value)} placeholder="主题" /></div><textarea disabled={busy} className="compose-body" value={body} onChange={(event) => setBody(event.target.value)} placeholder="撰写邮件" /><footer><button className="send-button" disabled={busy || !accountId || !hasRecipient} onClick={() => onSend(content, seed.draftId)}><Send />{busy ? "正在发送" : "发送"}</button><span>{status || (!accountId ? "没有可用的发件账户" : hasContent ? "关闭时自动保存为草稿" : "")}</span><button disabled={busy} className="discard-button" onClick={() => close(true)} aria-label="舍弃草稿"><Trash2 /></button></footer></> : null}
  </section>;
}
