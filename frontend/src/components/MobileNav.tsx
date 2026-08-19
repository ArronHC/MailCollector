import { Inbox, Menu, PenLine, Send, Star } from "lucide-react";
import type { MessageView } from "../data/mailData";

interface MobileNavProps {
  activeNavigation: string;
  unreadCount: number;
  onViewChange: (label: string, view: MessageView, starred?: boolean) => void;
  onCompose: () => void;
  onOpenMenu: () => void;
}

function NavButton({ active, label, count, onClick, children }: { active?: boolean; label: string; count?: number; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" className={`mobile-nav-item${active ? " active" : ""}`} aria-label={label} onClick={onClick}>
    <span className="mobile-nav-icon">{children}{count && count > 0 ? <b>{count > 99 ? "99+" : count}</b> : null}</span>
    <span>{label}</span>
  </button>;
}

export function MobileNav({ activeNavigation, unreadCount, onViewChange, onCompose, onOpenMenu }: MobileNavProps) {
  return <nav className="mobile-bottom-nav" aria-label="手机版主导航">
    <NavButton active={activeNavigation === "统一收件箱"} label="收件箱" count={unreadCount} onClick={() => onViewChange("统一收件箱", "inbox")}><Inbox /></NavButton>
    <NavButton active={activeNavigation === "已加星标"} label="星标" onClick={() => onViewChange("已加星标", "all", true)}><Star /></NavButton>
    <button type="button" className="mobile-compose-button" aria-label="写新邮件" onClick={onCompose}><PenLine /><span>写信</span></button>
    <NavButton active={activeNavigation === "已发送"} label="已发送" onClick={() => onViewChange("已发送", "sent")}><Send /></NavButton>
    <NavButton label="更多" onClick={onOpenMenu}><Menu /></NavButton>
  </nav>;
}
