import { useEffect } from "react";
import { Archive, ChevronDown, ChevronLeft, ChevronRight, Clock3, Inbox, Mail, MailOpen, MoreVertical, Paperclip, RefreshCw, Star, Tag, Trash2, TriangleAlert } from "lucide-react";
import type { MailAccount, MailItem, MailLabel, MailSource, MessageActions, MessageFolder } from "../data/mailData";
import { formatListTime, messageSource, sourceNames } from "../data/mailData";
import { snoozeIso } from "../data/snooze";
import { AccountBrand } from "./BrandIcons";
import { MenuButton, Popover } from "./Ui";

export function SourceBadge({ source }: { source: MailSource }) {
  return <span className={`source-badge ${source}`}><AccountBrand source={source} /><span>{sourceNames[source]}</span></span>;
}

function SnoozeMenu({ close, onSelect }: { close: () => void; onSelect: (date: string) => void }) {
  return <><div className="menu-heading">延后到</div><MenuButton icon={<Clock3 />} label="今天晚些时候" detail="18:00（若已过则明早）" onClick={() => { onSelect(snoozeIso("later_today")); close(); }} /><MenuButton icon={<Clock3 />} label="明天" detail="08:00" onClick={() => { onSelect(snoozeIso("tomorrow")); close(); }} /><MenuButton icon={<Clock3 />} label="下周一" detail="08:00" onClick={() => { onSelect(snoozeIso("next_monday")); close(); }} /></>;
}

function MoveMenu({ close, onMove }: { close: () => void; onMove: (folder: MessageFolder) => void }) {
  return <><div className="menu-heading">移动到</div><MenuButton icon={<Inbox />} label="收件箱" onClick={() => { onMove("inbox"); close(); }} /><MenuButton icon={<Archive />} label="归档" onClick={() => { onMove("archive"); close(); }} /><MenuButton icon={<TriangleAlert />} label="垃圾邮件" onClick={() => { onMove("spam"); close(); }} /><MenuButton icon={<Trash2 />} label="垃圾箱" onClick={() => { onMove("trash"); close(); }} /></>;
}

interface ToolbarProps {
  checkedCount: number;
  allChecked: boolean;
  syncing: boolean;
  total: number;
  offset: number;
  shown: number;
  trashView: boolean;
  labels: MailLabel[];
  onCheckAll: () => void;
  onSelectWhere: (where: "all" | "none" | "read" | "unread" | "starred") => void;
  onRefresh: () => void;
  onBulk: (actions: MessageActions) => void;
  onPermanentDelete: () => void;
  onPrevious: () => void;
  onNext: () => void;
}

export function MailListToolbar(props: ToolbarProps) {
  const { checkedCount, allChecked, syncing, total, offset, shown, trashView, labels, onCheckAll, onSelectWhere, onRefresh, onBulk, onPermanentDelete, onPrevious, onNext } = props;
  const start = total && shown ? Math.min(total, offset + 1) : 0;
  const end = total && shown ? Math.min(total, offset + shown) : 0;
  return <div className="mail-list-toolbar"><div className="toolbar-left"><input type="checkbox" checked={allChecked} onChange={onCheckAll} aria-label="选择全部邮件" /><Popover trigger={() => <button className="icon-button tiny-arrow interactive" aria-label="选择选项"><ChevronDown /></button>}>{(close) => <><MenuButton label="全部" onClick={() => { onSelectWhere("all"); close(); }} /><MenuButton label="无" onClick={() => { onSelectWhere("none"); close(); }} /><MenuButton label="已读" onClick={() => { onSelectWhere("read"); close(); }} /><MenuButton label="未读" onClick={() => { onSelectWhere("unread"); close(); }} /><MenuButton label="已加星标" onClick={() => { onSelectWhere("starred"); close(); }} /></>}</Popover>{checkedCount ? <div className="selection-actions"><span className="selected-count">已选择 {checkedCount}</span><button className="icon-button interactive" title="归档" onClick={() => onBulk({ folder: "archive", snoozedUntil: null })}><Archive /></button><button className="icon-button interactive" title={trashView ? "永久删除" : "移至垃圾箱"} onClick={() => trashView ? onPermanentDelete() : onBulk({ folder: "trash", snoozedUntil: null })}><Trash2 /></button><button className="icon-button interactive" title="标记为未读" onClick={() => onBulk({ isRead: false })}><Mail /></button><Popover trigger={() => <button className="icon-button interactive" title="延后"><Clock3 /></button>}>{(close) => <SnoozeMenu close={close} onSelect={(snoozedUntil) => onBulk({ folder: "inbox", snoozedUntil })} />}</Popover><Popover trigger={() => <button className="icon-button interactive" title="移动"><Inbox /></button>}>{(close) => <MoveMenu close={close} onMove={(folder) => onBulk({ folder, snoozedUntil: null })} />}</Popover><Popover trigger={() => <button className="icon-button interactive" title="标签"><Tag /></button>}>{(close) => <><div className="menu-heading">设置标签（替换现有）</div><MenuButton label="清除标签" onClick={() => { onBulk({ labels: [] }); close(); }} />{labels.map((label) => <MenuButton key={label.id} icon={<Tag />} label={label.name} onClick={() => { onBulk({ labels: [label.id] }); close(); }} />)}</>}</Popover><Popover trigger={() => <button className="icon-button interactive" title="更多"><MoreVertical /></button>} align="right">{(close) => <><MenuButton icon={<MailOpen />} label="标记为已读" onClick={() => { onBulk({ isRead: true }); close(); }} /><MenuButton icon={<Star />} label="添加星标" onClick={() => { onBulk({ isStarred: true }); close(); }} /><MenuButton icon={<TriangleAlert />} label="标记为垃圾邮件" onClick={() => { onBulk({ folder: "spam" }); close(); }} /></>}</Popover></div> : <><button className={`icon-button interactive${syncing ? " spinning" : ""}`} aria-label="刷新并同步" onClick={onRefresh} disabled={syncing}><RefreshCw /></button><Popover trigger={() => <button className="icon-button interactive" aria-label="更多"><MoreVertical /></button>}>{(close) => <><MenuButton icon={<MailOpen />} label="将本页标为已读" onClick={() => { onBulk({ isRead: true }); close(); }} /><MenuButton icon={<RefreshCw />} label="同步邮箱" onClick={() => { onRefresh(); close(); }} /></>}</Popover></>}</div><div className="pagination"><span>{start}–{end} 行，共 {total} 行</span><button className="icon-button interactive" aria-label="上一页" onClick={onPrevious} disabled={offset === 0}><ChevronLeft /></button><button className="icon-button interactive" aria-label="下一页" onClick={onNext} disabled={!shown || offset + shown >= total}><ChevronRight /></button></div></div>;
}

export function MailboxHeader({ accountCount, activeAccount, title }: { accountCount: number; activeAccount: MailAccount | null; title: string }) {
  return <div className="mailbox-title"><h1>{activeAccount ? "收件箱" : title}</h1><span>{activeAccount ? activeAccount.email : `来自 ${accountCount} 个账户`}</span></div>;
}

export function MailTabs({ active, accounts, onChange }: { active: string; accounts: MailAccount[]; onChange: (tab: string) => void }) {
  const sourceTabs = Array.from(new Set(accounts.map((account) => sourceNames[messageSource({ accountName: account.name, accountEmail: account.email })]))).slice(0, 3);
  const tabs = ["全部", "未读", ...(sourceTabs.length > 1 ? sourceTabs : [])];
  return <div className="mail-tabs">{tabs.map((tab) => <button key={tab} className={`interactive${active === tab ? " active" : ""}`} onClick={() => onChange(tab)}>{tab}</button>)}</div>;
}

export function MailRow({ mail, selected, checked, showSource, onCheck, onSelect, onStar }: { mail: MailItem; selected: boolean; checked: boolean; showSource: boolean; onCheck: () => void; onSelect: () => void; onStar: () => void }) {
  const sender = mail.kind === "sent" || mail.kind === "draft" ? `收件人：${mail.toText || "未填写"}` : mail.fromName || mail.fromAddress || "未知发件人";
  const openWithKeyboard = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect();
    }
  };
  return <article className={`mail-row interactive-row${selected ? " selected" : ""}${mail.isRead ? " is-read" : " is-unread"}`} role="button" tabIndex={0} aria-selected={selected} onKeyDown={openWithKeyboard} onClick={onSelect}><div className="mail-checkbox"><input type="checkbox" checked={checked} onChange={onCheck} onClick={(event) => event.stopPropagation()} aria-label={`选择 ${mail.subject || "无主题邮件"}`} /></div><div className="mail-row-body"><div className="mail-row-top"><strong>{sender}</strong><time>{formatListTime(mail.receivedAt)}</time></div><div className="mail-subject">{mail.subject || "(无主题)"}</div><div className="mail-preview">{mail.snippet || (mail.kind === "draft" ? "草稿" : "无正文摘要")}</div>{showSource ? <SourceBadge source={messageSource(mail)} /> : null}{mail.labels.map((label) => <span className="row-label" key={label.id}>{label.name}</span>)}{mail.hasAttachments ? <Paperclip className="attachment-icon" /> : null}</div><button className={`row-star interactive${mail.isStarred ? " starred" : ""}`} onClick={(event) => { event.stopPropagation(); onStar(); }} aria-label={mail.isStarred ? "取消加星" : "加星"}><Star fill={mail.isStarred ? "currentColor" : "none"} /></button></article>;
}

interface MailListPanelProps {
  mails: MailItem[]; accounts: MailAccount[]; labels: MailLabel[]; activeAccount: MailAccount | null; title: string; activeTab: string; activeMailId: number | null; checkedIds: Set<number>; total: number; offset: number; loading: boolean; syncing: boolean; error: string; trashView: boolean;
  onTabChange: (tab: string) => void; onSelect: (mail: MailItem) => void; onStar: (id: number) => void; onCheck: (id: number) => void; onCheckAll: () => void; onSelectWhere: (where: "all" | "none" | "read" | "unread" | "starred") => void; onRefresh: () => void; onBulk: (actions: MessageActions) => void; onPermanentDelete: () => void; onPrevious: () => void; onNext: () => void;
}

export function MailListPanel(props: MailListPanelProps) {
  const { mails, accounts, labels, activeAccount, title, activeTab, activeMailId, checkedIds, total, offset, loading, syncing, error, trashView, onTabChange, onSelect, onStar, onCheck, onCheckAll, onSelectWhere, onRefresh, onBulk, onPermanentDelete, onPrevious, onNext } = props;
  const sourceCount = new Set(accounts.map((account) => messageSource({ accountName: account.name, accountEmail: account.email }))).size;
  useEffect(() => {
    if (!loading && offset > 0 && offset >= total) onPrevious();
  }, [loading, offset, total, onPrevious]);
  return <section className="mail-list-panel"><MailListToolbar checkedCount={checkedIds.size} allChecked={mails.length > 0 && mails.every((mail) => checkedIds.has(mail.id))} onCheckAll={onCheckAll} onSelectWhere={onSelectWhere} onRefresh={onRefresh} syncing={syncing} total={total} offset={offset} shown={mails.length} trashView={trashView} labels={labels} onBulk={onBulk} onPermanentDelete={onPermanentDelete} onPrevious={onPrevious} onNext={onNext} /><div className="mailbox-header"><MailboxHeader accountCount={accounts.length} activeAccount={activeAccount} title={title} /><MailTabs active={activeTab} accounts={activeAccount ? [] : accounts} onChange={onTabChange} /></div><div className="mail-list-scroll">{loading ? <div className="panel-state loading-pulse">正在加载邮件...</div> : error ? <div className="panel-state error-state"><strong>无法加载邮件</strong><span>{error}</span><button onClick={onRefresh}>重试</button></div> : mails.length ? mails.map((mail) => <MailRow key={mail.id} mail={mail} selected={activeMailId === mail.id} checked={checkedIds.has(mail.id)} showSource={!activeAccount && sourceCount > 1} onCheck={() => onCheck(mail.id)} onSelect={() => onSelect(mail)} onStar={() => onStar(mail.id)} />) : <div className="panel-state"><Mail size={38} /><strong>这里没有邮件</strong><span>{accounts.length ? "调整筛选条件，或点击刷新同步邮箱。" : "请先添加邮箱账户。"}</span></div>}</div></section>;
}
