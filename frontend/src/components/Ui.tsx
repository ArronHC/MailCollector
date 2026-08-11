import { useEffect, useRef, useState } from "react";
import { CheckCircle2, CircleAlert, Info, X } from "lucide-react";

export function usePresence(open: boolean, duration = 180) {
  const [rendered, setRendered] = useState(open);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    if (open) {
      setRendered(true);
      setClosing(false);
      return;
    }
    if (!rendered) return;
    setClosing(true);
    const timer = window.setTimeout(() => { setRendered(false); setClosing(false); }, duration);
    return () => window.clearTimeout(timer);
  }, [open, rendered, duration]);

  return { rendered, closing };
}

export interface ToastMessage {
  id: number;
  text: string;
  tone?: "success" | "error" | "info";
  actionLabel?: string;
  onAction?: () => void;
}

export function Popover({ trigger, children, align = "left", className = "" }: { trigger: (open: boolean) => React.ReactNode; children: (close: () => void) => React.ReactNode; align?: "left" | "right"; className?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const presence = usePresence(open, 140);
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); };
    const closeEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", closeOutside);
    document.addEventListener("keydown", closeEscape);
    return () => { document.removeEventListener("mousedown", closeOutside); document.removeEventListener("keydown", closeEscape); };
  }, [open]);
  return <div className={`popover-root ${className}`} ref={ref}><div className="popover-trigger" onClick={() => setOpen((value) => !value)}>{trigger(open)}</div>{presence.rendered ? <div className={`gmail-menu align-${align}${presence.closing ? " closing" : ""}`} role="menu">{children(() => setOpen(false))}</div> : null}</div>;
}

export function MenuButton({ icon, label, detail, disabled, danger, onClick }: { icon?: React.ReactNode; label: string; detail?: string; disabled?: boolean; danger?: boolean; onClick: () => void }) {
  return <button className={`gmail-menu-button${danger ? " danger" : ""}`} role="menuitem" disabled={disabled} onClick={onClick}>{icon}<span>{label}</span>{detail ? <small>{detail}</small> : null}</button>;
}

export function Modal({ open, title, onClose, children, className = "" }: { open: boolean; title: string; onClose: () => void; children: React.ReactNode; className?: string }) {
  const presence = usePresence(open, 200);
  useEffect(() => {
    if (!open) return;
    const closeEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", closeEscape);
    return () => document.removeEventListener("keydown", closeEscape);
  }, [open, onClose]);
  if (!presence.rendered) return null;
  return <div className={`modal-backdrop${presence.closing ? " closing" : ""}`} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className={`gmail-modal ${className}`} role="dialog" aria-modal="true" aria-label={title}><header><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label="关闭"><X /></button></header>{children}</section></div>;
}

export function ToastStack({ toasts, dismiss }: { toasts: ToastMessage[]; dismiss: (id: number) => void }) {
  return <div className="toast-stack" aria-live="polite">{toasts.map((toast) => <div className={`toast ${toast.tone ?? "info"}`} key={toast.id}>{toast.tone === "success" ? <CheckCircle2 /> : toast.tone === "error" ? <CircleAlert /> : <Info />}<span>{toast.text}</span>{toast.actionLabel ? <button onClick={() => { toast.onAction?.(); dismiss(toast.id); }}>{toast.actionLabel}</button> : null}<button className="toast-close" onClick={() => dismiss(toast.id)} aria-label="关闭"><X /></button></div>)}</div>;
}
