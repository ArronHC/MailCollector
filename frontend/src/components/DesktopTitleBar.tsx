import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, X } from "lucide-react";
import { CollectorMark } from "./BrandIcons";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export function DesktopTitleBar() {
  if (!window.__TAURI_INTERNALS__) return null;
  const currentWindow = getCurrentWindow();
  return <header className="desktop-titlebar" data-tauri-drag-region onDoubleClick={() => void currentWindow.toggleMaximize()}>
    <div className="desktop-titlebar-brand" data-tauri-drag-region><CollectorMark /><span>Mail Collector</span></div>
    <div className="desktop-window-controls">
      <button type="button" aria-label="最小化" onClick={() => void currentWindow.minimize()}><Minus /></button>
      <button type="button" aria-label="最大化或还原" onClick={() => void currentWindow.toggleMaximize()}><Square /></button>
      <button className="desktop-window-close" type="button" aria-label="关闭" onClick={() => void currentWindow.close()}><X /></button>
    </div>
  </header>;
}
