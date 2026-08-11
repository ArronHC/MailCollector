import { Archive, ChevronDown, Clock3, File, Inbox, MailWarning, Plus, Send, Star, Tag, Trash2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useState } from "react";
import type { MailAccount, MailLabel, MessageView } from "../data/mailData";
import { accountSource, sourceNames } from "../data/mailData";
import { AccountBrand } from "./BrandIcons";

export function ComposeButton({ onClick }: { onClick: () => void }) {
  return <button className="compose-button interactive" onClick={onClick}><Plus /><span>写新邮件</span></button>;
}

export function AccountItem({ account, active, onClick, onManage }: { account: MailAccount; active: boolean; onClick: () => void; onManage: () => void }) {
  const source = accountSource(account);
  return <button className={`account-item interactive${active ? " active" : ""}`} onClick={onClick} onDoubleClick={onManage} title={`${account.email}${account.lastError ? `\n${account.lastError}` : ""}`}><AccountBrand source={source} /><span>{account.name.trim() || sourceNames[source]}</span><b>{account.status === "syncing" ? "..." : account.unreadCount}</b></button>;
}

export function AccountList({ accounts, activeAccountId, onSelect, onAdd, onManage }: { accounts: MailAccount[]; activeAccountId: number | null; onSelect: (id: number) => void; onAdd: () => void; onManage: () => void }) {
  return <section className="account-list"><div className="sidebar-section-title"><span>邮箱账户</span><button className="interactive" aria-label="添加账户" onClick={onAdd}><Plus /></button></div>{accounts.map((account) => <AccountItem key={account.id} account={account} active={activeAccountId === account.id} onClick={() => onSelect(account.id)} onManage={onManage} />)}{!accounts.length ? <button className="empty-account" onClick={onAdd}>添加第一个邮箱</button> : null}</section>;
}

interface NavigationItemProps { label: string; icon: LucideIcon; count?: number; active: boolean; onClick: () => void; }
export function NavigationItem({ label, icon: Icon, count, active, onClick }: NavigationItemProps) {
  return <button className={`navigation-item interactive${active ? " active" : ""}`} onClick={onClick}><Icon /><span>{label}</span>{typeof count === "number" && count > 0 ? <b>{count}</b> : null}</button>;
}

const navigation: Array<{ label: string; view: MessageView; icon: LucideIcon }> = [
  { label: "统一收件箱", view: "inbox", icon: Inbox },
  { label: "已加星标", view: "all", icon: Star },
  { label: "已延后", view: "snoozed", icon: Clock3 },
  { label: "已发送", view: "sent", icon: Send },
  { label: "草稿", view: "drafts", icon: File },
  { label: "全部邮件", view: "all", icon: Archive },
  { label: "垃圾邮件", view: "spam", icon: MailWarning },
  { label: "已删除", view: "trash", icon: Trash2 }
];

export function MailNavigation({ active, unreadCount, draftCount, onChange }: { active: string; unreadCount: number; draftCount: number; onChange: (label: string, view: MessageView, starred?: boolean) => void }) {
  return <nav className="mail-navigation">{navigation.map((item) => <NavigationItem key={item.label} label={item.label} icon={item.icon} count={item.label === "统一收件箱" ? unreadCount : item.label === "草稿" ? draftCount : undefined} active={active === item.label} onClick={() => onChange(item.label, item.view, item.label === "已加星标")} />)}</nav>;
}

function labelColor(index: number): string { return ["label-blue", "label-green", "label-yellow", "label-purple", "label-red"][index % 5] ?? "label-blue"; }

export function LabelList({ labels, activeLabelId, onSelect, onCreate }: { labels: MailLabel[]; activeLabelId: number | null; onSelect: (label: MailLabel) => void; onCreate: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? labels : labels.slice(0, 3);
  return <section className="label-list"><div className="sidebar-section-title label-title"><span>标签</span><button className="interactive" aria-label="新建标签" onClick={onCreate}><Plus /></button></div>{visible.map((label, index) => <button className={`label-row interactive${activeLabelId === label.id ? " active" : ""}`} key={label.id} onClick={() => onSelect(label)}><Tag className={labelColor(index)} /><span>{label.name}</span>{label.messageCount ? <b>{label.messageCount}</b> : null}</button>)}{labels.length > 3 ? <button className="label-row more-label interactive" onClick={() => setExpanded((value) => !value)}><ChevronDown className={expanded ? "rotated" : ""} /><span>{expanded ? "收起" : "更多"}</span></button> : null}</section>;
}

interface SidebarProps {
  accounts: MailAccount[];
  labels: MailLabel[];
  activeAccountId: number | null;
  activeNavigation: string;
  activeLabelId: number | null;
  unreadCount: number;
  draftCount: number;
  onAccountSelect: (id: number | null) => void;
  onViewChange: (label: string, view: MessageView, starred?: boolean) => void;
  onLabelSelect: (label: MailLabel) => void;
  onCompose: () => void;
  onAddAccount: () => void;
  onManageAccount: () => void;
  onCreateLabel: () => void;
}

export function Sidebar(props: SidebarProps) {
  const { accounts, labels, activeAccountId, activeNavigation, activeLabelId, unreadCount, draftCount, onAccountSelect, onViewChange, onLabelSelect, onCompose, onAddAccount, onManageAccount, onCreateLabel } = props;
  return <aside className="sidebar"><ComposeButton onClick={onCompose} /><AccountList accounts={accounts} activeAccountId={activeAccountId} onSelect={(id) => onAccountSelect(id)} onAdd={onAddAccount} onManage={onManageAccount} /><MailNavigation active={activeNavigation} unreadCount={unreadCount} draftCount={draftCount} onChange={onViewChange} /><LabelList labels={labels} activeLabelId={activeLabelId} onSelect={onLabelSelect} onCreate={onCreateLabel} /></aside>;
}
