import { Archive, ArrowLeft, Clock3, ExternalLink, Inbox, Mail, MailOpen, Maximize2, Minimize2, MoreVertical, MoveRight, Printer, Reply, Star, Tag, Trash2, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import type { MailDetail, MailLabel, MessageActions, MessageFolder } from "../data/mailData";
import { formatDetailTime, messageSource, sourceNames } from "../data/mailData";
import { MenuButton, Popover } from "./Ui";

function ToolButton({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick?: () => void; children: React.ReactNode }) {
  return <button className="icon-button reader-tool interactive" aria-label={label} title={label} disabled={disabled} onClick={onClick}>{children}</button>;
}

function SnoozeOptions({ close, onAction }: { close: () => void; onAction: (date: string) => void }) {
  const at = (days: number, hour: number) => { const value = new Date(); value.setDate(value.getDate() + days); value.setHours(hour, 0, 0, 0); return value.toISOString(); };
  return <><div className="menu-heading">延后到</div><MenuButton icon={<Clock3 />} label="今天晚些时候" detail="18:00" onClick={() => { onAction(at(0, 18)); close(); }} /><MenuButton icon={<Clock3 />} label="明天" detail="08:00" onClick={() => { onAction(at(1, 8)); close(); }} /><MenuButton icon={<Clock3 />} label="下周" detail="周一 08:00" onClick={() => { const now = new Date(); onAction(at(((8 - now.getDay()) % 7) || 7, 8)); close(); }} /></>;
}

function MoveOptions({ close, onMove }: { close: () => void; onMove: (folder: MessageFolder) => void }) {
  return <><div className="menu-heading">移动到</div><MenuButton icon={<Inbox />} label="收件箱" onClick={() => { onMove("inbox"); close(); }} /><MenuButton icon={<Archive />} label="归档" onClick={() => { onMove("archive"); close(); }} /><MenuButton icon={<TriangleAlert />} label="垃圾邮件" onClick={() => { onMove("spam"); close(); }} /><MenuButton icon={<Trash2 />} label="垃圾箱" onClick={() => { onMove("trash"); close(); }} /></>;
}

export function MailReaderToolbar({ mail, labels, expanded, onBack, onAction, onDelete, onPrint, onToggleExpanded, onOpenWindow }: { mail: MailDetail | null; labels: MailLabel[]; expanded: boolean; onBack: () => void; onAction: (actions: MessageActions) => void; onDelete: () => void; onPrint: () => void; onToggleExpanded: () => void; onOpenWindow: () => void }) {
  const disabled = !mail;
  return <div className="reader-toolbar"><div className="reader-toolbar-main"><ToolButton label="返回" onClick={onBack}><ArrowLeft /></ToolButton><ToolButton label="归档" disabled={disabled} onClick={() => onAction({ folder: "archive", snoozedUntil: null })}><Archive /></ToolButton><ToolButton label={mail?.folder === "trash" ? "永久删除" : "移至垃圾箱"} disabled={disabled} onClick={onDelete}><Trash2 /></ToolButton><ToolButton label={mail?.isRead ? "标记未读" : "标记已读"} disabled={disabled} onClick={() => onAction({ isRead: !mail?.isRead })}>{mail?.isRead ? <Mail /> : <MailOpen />}</ToolButton><Popover trigger={() => <ToolButton label="延后" disabled={disabled}><Clock3 /></ToolButton>}>{(close) => <SnoozeOptions close={close} onAction={(snoozedUntil) => onAction({ folder: "inbox", snoozedUntil })} />}</Popover><Popover trigger={() => <ToolButton label="移动" disabled={disabled}><MoveRight /></ToolButton>}>{(close) => <MoveOptions close={close} onMove={(folder) => onAction({ folder, snoozedUntil: null })} />}</Popover><Popover trigger={() => <ToolButton label="更多" disabled={disabled}><MoreVertical /></ToolButton>}>{(close) => <><MenuButton icon={<Star />} label={mail?.isStarred ? "取消星标" : "添加星标"} onClick={() => { onAction({ isStarred: !mail?.isStarred }); close(); }} /><MenuButton icon={<TriangleAlert />} label="标记为垃圾邮件" onClick={() => { onAction({ folder: "spam", snoozedUntil: null }); close(); }} /><div className="menu-separator" /><div className="menu-heading">标签</div><MenuButton icon={<Tag />} label="清除标签" onClick={() => { onAction({ labels: [] }); close(); }} />{labels.map((label) => <MenuButton key={label.id} icon={<Tag />} label={label.name} onClick={() => { onAction({ labels: [label.id] }); close(); }} />)}</>}</Popover></div><div className="reader-toolbar-side"><ToolButton label="打印" disabled={disabled} onClick={onPrint}><Printer /></ToolButton><ToolButton label={expanded ? "退出全屏" : "全屏阅读"} disabled={disabled} onClick={onToggleExpanded}>{expanded ? <Minimize2 /> : <Maximize2 />}</ToolButton><ToolButton label="在新窗口中打开" disabled={disabled} onClick={onOpenWindow}><ExternalLink /></ToolButton></div></div>;
}

export function SenderInfo({ mail, onStar, onReply }: { mail: MailDetail; onStar: () => void; onReply: () => void }) {
  const [details, setDetails] = useState(false);
  const sender = mail.kind === "sent" || mail.kind === "draft" ? mail.accountName : mail.fromName || mail.fromAddress || "未知发件人";
  const initial = sender.trim().slice(0, 1).toUpperCase();
  const source = messageSource(mail);
  return <div className="sender-info"><div className="google-avatar">{initial}</div><div className="sender-copy"><div className="sender-first-line"><strong>{sender}</strong>{mail.fromAddress ? <span className="sender-address">&lt;{mail.fromAddress}&gt;</span> : null}<span className="from-source">来自 <b>{sourceNames[source]}</b></span></div><button className="recipient interactive" onClick={() => setDetails((value) => !value)}>收件人：{mail.toText || mail.accountEmail} <span className={details ? "rotated" : ""}>⌄</span></button>{details ? <div className="recipient-details"><dl><div><dt>发件人</dt><dd>{mail.fromAddress || mail.accountEmail}</dd></div><div><dt>收件人</dt><dd>{mail.to.join(", ") || mail.toText || mail.accountEmail}</dd></div>{mail.cc.length ? <div><dt>抄送</dt><dd>{mail.cc.join(", ")}</dd></div> : null}<div><dt>日期</dt><dd>{new Date(mail.receivedAt).toLocaleString("zh-CN")}</dd></div></dl></div> : null}</div><div className="sender-actions"><time>{formatDetailTime(mail.receivedAt)}</time><button className={`interactive${mail.isStarred ? "active" : ""}`} onClick={onStar} aria-label="切换星标"><Star fill={mail.isStarred ? "currentColor" : "none"} /></button><button className="interactive" aria-label="回复" onClick={onReply}><Reply /></button><Popover align="right" trigger={() => <button className="interactive" aria-label="更多"><MoreVertical /></button>}>{(close) => <><MenuButton icon={<Reply />} label="回复" onClick={() => { onReply(); close(); }} /><MenuButton icon={<Printer />} label="打印" onClick={() => { window.print(); close(); }} /></>}</Popover></div></div>;
}

function folderName(mail: MailDetail): string {
  if (mail.kind === "sent") return "已发送";
  if (mail.kind === "draft") return "草稿";
  return { inbox: "收件箱", archive: "已归档", trash: "垃圾箱", spam: "垃圾邮件" }[mail.folder];
}

export function MailHeader({ mail, onStar, onReply }: { mail: MailDetail; onStar: () => void; onReply: () => void }) {
  return <div className="mail-reader-header"><div className="reader-title"><h2>{mail.subject || "(无主题)"}</h2></div><div className="reader-context"><span>{folderName(mail)}</span>{mail.labels.map((label) => <span className="reader-label" key={label.id}>{label.name}</span>)}</div><SenderInfo mail={mail} onStar={onStar} onReply={onReply} /></div>;
}

function messageDocument(html: string): string {
  const securityHead = `<meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; connect-src 'none'; object-src 'none'; img-src data: cid:; style-src 'unsafe-inline'; font-src data:; media-src data: cid:; frame-src 'none'; form-action 'none'; base-uri 'none'">`;
  if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b[^>]*>/i, (head) => `${head}${securityHead}`);
  if (/<html\b[^>]*>/i.test(html)) return html.replace(/<html\b[^>]*>/i, (root) => `${root}<head><meta charset="utf-8">${securityHead}</head>`);
  return `<!doctype html><html><head><meta charset="utf-8">${securityHead}</head><body>${html}</body></html>`;
}

export function RealEmailContent({ mail }: { mail: MailDetail }) {
  if (mail.bodyStatus !== "fetched") return <div className="real-email-card body-unavailable"><strong>{mail.bodyStatus === "fetching" ? "正在获取邮件正文" : mail.bodyStatus === "not_fetched" ? "邮件正文尚未下载" : "邮件正文获取失败"}</strong><p>{mail.bodyError || mail.snippet || "暂无可显示的正文。"}</p></div>;
  if (mail.htmlBody) return <div className="real-email-card"><iframe className="message-frame" sandbox="allow-popups" srcDoc={messageDocument(mail.htmlBody)} title="邮件正文" /></div>;
  return <div className="real-email-card plain-message">{mail.textBody || mail.snippet || "这封邮件没有可显示的正文。"}</div>;
}

export function EmailFooter({ mail }: { mail: MailDetail }) {
  return <footer className="email-footer"><p>收至 {mail.accountEmail}</p><p>{new Date(mail.receivedAt).toLocaleString("zh-CN")}</p><p>{mail.hasAttachments ? "此邮件包含附件，当前版本暂不提供附件下载。" : "Mail Collector 邮件客户端"}</p></footer>;
}

interface ReaderProps { mail: MailDetail | null; loading: boolean; error: string; labels: MailLabel[]; expanded: boolean; onToggleExpanded: () => void; onAction: (actions: MessageActions) => void; onDelete: () => void; onStar: () => void; onReply: () => void; onBack: () => void; }
export function MailReaderPanel({ mail, loading, error, labels, expanded, onToggleExpanded, onAction, onDelete, onStar, onReply, onBack }: ReaderProps) {
  useEffect(() => {
    if (!expanded) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onToggleExpanded(); };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [expanded, onToggleExpanded]);
  const contentKey = loading ? `loading-${mail?.id ?? "none"}` : error ? `error-${mail?.id ?? "none"}` : mail ? `mail-${mail.id}` : "empty";
  return <section className={`mail-reader-panel${expanded ? " reader-expanded" : ""}`}><MailReaderToolbar mail={mail} labels={labels} expanded={expanded} onBack={onBack} onAction={onAction} onDelete={onDelete} onPrint={() => window.print()} onToggleExpanded={onToggleExpanded} onOpenWindow={() => { if (mail) window.open(`/?message=${mail.id}`, "_blank", "noopener"); }} /><div className="reader-scroll" key={contentKey}>{loading ? <div className="reader-state loading-pulse">正在读取邮件...</div> : error ? <div className="reader-state error-state"><strong>无法读取邮件</strong><span>{error}</span></div> : mail ? <div className="reader-enter"><MailHeader mail={mail} onStar={onStar} onReply={onReply} /><div className="reader-message"><RealEmailContent mail={mail} /><EmailFooter mail={mail} /></div></div> : <div className="reader-empty"><Mail size={42} /><h2>选择一封邮件</h2><p>邮件正文将在此处安全显示。</p></div>}</div></section>;
}
