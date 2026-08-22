import type { ReactNode } from "react";
import { Keyboard, LayoutPanelLeft, Mail, RotateCcw, Server, ShieldCheck, SlidersHorizontal, Trash2, X, Users } from "lucide-react";
import { Modal } from "./Ui";
import { DeviceManager } from "./DeviceManager";
import { clearClientBackend, getMobileBackendUrl, isNativeClient } from "../mobile-backend";
import { resetAppSettings, untrustRemoteImageSender, updateAppSettings, useAppSettings } from "../settings";

function SettingRow({ title, detail, children }: { title: string; detail: string; children: ReactNode }) {
  return <div className="setting-row"><div><strong>{title}</strong><span>{detail}</span></div><div className="setting-control">{children}</div></div>;
}

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const settings = useAppSettings();
  const nativeClient = isNativeClient();
  const backend = getMobileBackendUrl();

  function changeServer() {
    clearClientBackend();
    window.location.reload();
  }

  return <Modal open={open} title="设置" onClose={onClose} className="settings-modal">
    <div className="settings-shell">
      <section className="settings-section">
        <header><LayoutPanelLeft /><div><h3>外观与布局</h3><p>调整三栏工作区和邮件列表的信息密度。</p></div></header>
        <SettingRow title="阅读窗格" detail="在宽屏三栏和上下分栏之间切换。"><select value={settings.readerPosition} onChange={(event) => updateAppSettings({ readerPosition: event.target.value as typeof settings.readerPosition })}><option value="right">右侧</option><option value="bottom">底部</option></select></SettingRow>
        <SettingRow title="邮件列表密度" detail="控制每封邮件占用的垂直空间。"><select value={settings.listDensity} onChange={(event) => updateAppSettings({ listDensity: event.target.value as typeof settings.listDensity })}><option value="compact">紧凑</option><option value="comfortable">标准</option><option value="spacious">宽松</option></select></SettingRow>
        <SettingRow title="显示正文摘要" detail="在列表中展示邮件摘要。"><input type="checkbox" checked={settings.showSnippets} onChange={(event) => updateAppSettings({ showSnippets: event.target.checked })} /></SettingRow>
      </section>

      {nativeClient ? <>
        <section className="settings-section">
          <header><Server /><div><h3>同步服务器</h3><p>电脑和手机均直接连接 VPS，邮件阅读数据保存在本机缓存。</p></div></header>
          <SettingRow title="当前 VPS" detail={backend || "尚未配置"}><button type="button" onClick={changeServer}>更换服务器</button></SettingRow>
        </section>
        <section className="settings-section">
          <header><Users /><div><h3>设备管理</h3><p>管理登录过此账号的电脑和手机。</p></div></header>
          <DeviceManager />
        </section>
      </> : null}

      <section className="settings-section compact-section">
        <header><ShieldCheck /><div><h3>隐私</h3><p>远程图片和本地缓存策略。</p></div></header>
        <div className="trusted-summary"><SlidersHorizontal /><span>已信任 {settings.trustedRemoteImageSenders.length} 个远程图片发件人</span>{settings.trustedRemoteImageSenders.length ? <button type="button" onClick={() => updateAppSettings({ trustedRemoteImageSenders: [] })}><Trash2 />全部清除</button> : null}</div>
        {settings.trustedRemoteImageSenders.length ? <div className="trusted-sender-list">{settings.trustedRemoteImageSenders.map((sender) => <div key={sender}><span>{sender}</span><button type="button" onClick={() => untrustRemoteImageSender(sender)}><X /></button></div>)}</div> : null}
      </section>

      <section className="settings-section">
        <header><Keyboard /><div><h3>操作</h3><p>键盘快捷键设置。</p></div></header>
        <SettingRow title="启用快捷键" detail="支持 J/K、E、S、U、R、C、/ 和 Esc。"><input type="checkbox" checked={settings.keyboardShortcutsEnabled} onChange={(event) => updateAppSettings({ keyboardShortcutsEnabled: event.target.checked })} /></SettingRow>
      </section>

      <footer className="settings-footer"><button onClick={() => resetAppSettings()}><RotateCcw />恢复默认设置</button><button className="primary-action" onClick={onClose}>完成</button></footer>
    </div>
  </Modal>;
}
