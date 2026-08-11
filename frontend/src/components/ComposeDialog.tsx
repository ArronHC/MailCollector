import { useEffect, useState } from "react";
import { ChevronDown, Maximize2, Minimize2, Send, Trash2, X } from "lucide-react";
import type { DraftContent, MailAccount, MailDetail } from "../data/mailData";
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
  const presence = usePresence(open, 220);

  useEffect(() => {
    if (!open) return;
    setAccountId(seed.accountId ?? accounts.find((account) => account.enabled)?.id ?? accounts[0]?.id ?? 0);
    setTo(seed.to?.join(", ") ?? "");
    setCc(seed.cc?.join(", ") ?? "");
    setBcc(seed.bcc?.join(", ") ?? "");
    setSubject(seed.subject ?? "");
    setBody(seed.body ?? "");
    setShowCopies(Boolean(seed.cc?.length || seed.bcc?.length));
    setMinimized(false);
  }, [open, seed, accounts]);

  if (!presence.rendered) return null;
  const content: DraftContent = { accountId, to: splitAddresses(to), cc: splitAddresses(cc), bcc: splitAddresses(bcc), subject, body };
  const hasContent = Boolean(to || cc || bcc || subject || body);
  return <section className={`compose-window${minimized ? " minimized" : ""}${expanded ? " expanded" : ""}${presence.closing ? " closing" : ""}`} aria-label="写邮件">
    <header onDoubleClick={() => setMinimized((value) => !value)}><strong>{seed.draftId ? "编辑草稿" : subject || "新邮件"}</strong><div><button onClick={() => setMinimized((value) => !value)} aria-label={minimized ? "恢复" : "最小化"}>{minimized ? <ChevronDown /> : <Minimize2 />}</button><button onClick={() => setExpanded((value) => !value)} aria-label="切换大窗口"><Maximize2 /></button><button onClick={() => onClose(content, seed.draftId)} aria-label="保存并关闭"><X /></button></div></header>
    {!minimized ? <><div className="compose-fields"><label><span>发件人</span><select value={accountId} onChange={(event) => setAccountId(Number(event.target.value))}>{accounts.filter((account) => account.enabled).map((account) => <option key={account.id} value={account.id}>{account.name} &lt;{account.email}&gt;</option>)}</select></label><label><span>收件人</span><input value={to} onChange={(event) => setTo(event.target.value)} placeholder="name@example.com" autoFocus /><button onClick={() => setShowCopies((value) => !value)}>抄送/密送</button></label>{showCopies ? <><label><span>抄送</span><input value={cc} onChange={(event) => setCc(event.target.value)} /></label><label><span>密送</span><input value={bcc} onChange={(event) => setBcc(event.target.value)} /></label></> : null}<input className="compose-subject" value={subject} onChange={(event) => setSubject(event.target.value)} placeholder="主题" /></div><textarea className="compose-body" value={body} onChange={(event) => setBody(event.target.value)} placeholder="撰写邮件" /><footer><button className="send-button" disabled={busy || !accountId || !content.to.length} onClick={() => onSend(content, seed.draftId)}><Send />{busy ? "正在发送" : "发送"}</button><span>{status || (hasContent ? "关闭时自动保存为草稿" : "")}</span><button className="discard-button" onClick={() => onClose(content, seed.draftId, true)} aria-label="舍弃草稿"><Trash2 /></button></footer></> : null}
  </section>;
}
