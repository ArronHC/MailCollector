import { CheckCircle2, CircleHelp, LoaderCircle, LogOut, Menu, Search, Settings, Sparkles, TriangleAlert, UserRound } from "lucide-react";
import { CollectorMark } from "./BrandIcons";
import { MenuButton, Popover } from "./Ui";

export function TopSearchBar({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return <label className="top-search"><Search /><input value={value} onChange={(event) => onChange(event.target.value)} placeholder="搜索邮件" aria-label="搜索邮件" />{value ? <button onClick={() => onChange("")} aria-label="清空搜索">×</button> : null}</label>;
}

export function SyncStatus({ accountCount, syncing, error, onSync }: { accountCount: number; syncing: boolean; error: string; onSync: () => void }) {
  return <button className={`sync-status${error ? " error" : ""}`} onClick={onSync} disabled={syncing} title={error || "同步全部邮箱"}>{syncing ? <LoaderCircle className="spinning" /> : error ? <TriangleAlert /> : <CheckCircle2 fill="#1e8e3e" color="#fff" />}<span>{syncing ? "正在同步邮箱" : error ? "同步出现错误" : `已连接 ${accountCount} 个邮箱`}</span></button>;
}

export function ClassifyButton({ classifying, onClassify }: { classifying: boolean; onClassify: () => void }) {
  return <button className="classify-button" onClick={onClassify} disabled={classifying} title="根据发件人、主题和正文自动添加分类标签">{classifying ? <LoaderCircle className="spinning" /> : <Sparkles />}<span>{classifying ? "正在分类" : "自动分类"}</span></button>;
}

export function UserActions({ backendLabel, onHelp, onSettings, onManageAccounts, onLogout }: { backendLabel: string; onHelp: () => void; onSettings: () => void; onManageAccounts: () => void; onLogout: () => void }) {
  return <div className="user-actions">
    <button className="icon-button interactive" aria-label="帮助" onClick={onHelp}><CircleHelp /></button>
    <button className="icon-button interactive" aria-label="设置" onClick={onSettings}><Settings /></button>
    <Popover align="right" trigger={() => <button className="user-avatar interactive" aria-label="账户菜单">MC</button>}>{(close) => <><div className="account-menu-head"><div className="user-avatar large">MC</div><strong>Mail Collector</strong><span>{backendLabel}</span></div><MenuButton icon={<UserRound />} label="管理邮箱账户" onClick={() => { onManageAccounts(); close(); }} /><MenuButton icon={<LogOut />} label="退出当前会话" onClick={() => { onLogout(); close(); }} /></>}</Popover>
  </div>;
}

interface TopBarProps {
  search: string;
  accountCount: number;
  syncing: boolean;
  classifying: boolean;
  error: string;
  onSearch: (value: string) => void;
  onSync: () => void;
  onClassify: () => void;
  onToggleSidebar: () => void;
  onHelp: () => void;
  onSettings: () => void;
  onManageAccounts: () => void;
  backendLabel: string;
  onLogout: () => void;
}

export function TopBar({ search, onSearch, accountCount, syncing, classifying, error, backendLabel, onSync, onClassify, onToggleSidebar, onHelp, onSettings, onManageAccounts, onLogout }: TopBarProps) {
  return <header className="top-bar"><div className="brand-area"><button className="icon-button menu-button interactive" aria-label="折叠侧栏" onClick={onToggleSidebar}><Menu /></button><div className="mail-brand"><CollectorMark /><div><span>Mail Collector</span><small>聚合邮件空间</small></div></div></div><div className="top-main"><TopSearchBar value={search} onChange={onSearch} /><div className="top-right"><ClassifyButton classifying={classifying} onClassify={onClassify} /><SyncStatus accountCount={accountCount} syncing={syncing} error={error} onSync={onSync} /><UserActions backendLabel={backendLabel} onHelp={onHelp} onSettings={onSettings} onManageAccounts={onManageAccounts} onLogout={onLogout} /></div></div></header>;
}
