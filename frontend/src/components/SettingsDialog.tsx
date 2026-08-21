import { Keyboard, LayoutPanelLeft, Mail, RotateCcw, ShieldCheck, SlidersHorizontal, Trash2, X } from "lucide-react";
import { Modal } from "./Ui";
import { AccountSyncSettings } from "./AccountSyncSettings";
import { DevicePairingSettings } from "./DevicePairingSettings";
import { VpsRelaySettings } from "./VpsRelaySettings";
import { isNativeMobile } from "../mobile-backend";
import { resetAppSettings, untrustRemoteImageSender, updateAppSettings, useAppSettings } from "../settings";

function SettingRow({ title, detail, children }: { title: string; detail: string; children: React.ReactNode }) {
  return <div className="setting-row"><div><strong>{title}</strong><span>{detail}</span></div><div className="setting-control">{children}</div></div>;
}

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const settings = useAppSettings();
  const nativeMobile = isNativeMobile();
  return <Modal open={open} title="设置" onClose={onClose} className="settings-modal">
    <div className="settings-shell">
      <section className="settings-section">
        <header><LayoutPanelLeft /><div><h3>外观与布局</h3><p>调整三栏工作区和邮件列表的信息密度。</p></div></header>
        <SettingRow title="阅读窗格" detail="在宽屏三栏和上下分栏之间切换。"><select value={settings.readerPosition} onChange={(event) => updateAppSettings({ readerPosition: event.target.value as typeof settings.readerPosition })}><option value="right">右侧</option><option value="bottom">底部</option></select></SettingRow>
        <SettingRow title="邮件列表密度" detail="控制每封邮件占用的垂直空间。"><select value={settings.listDensity} onChange={(event) => updateAppSettings({ listDensity: event.target.value as typeof settings.listDensity })}><option value="compact">紧凑</option><option value="comfortable">标准</option><option value="spacious">宽松</option></select></SettingRow>
        <SettingRow title="显示正文摘要" detail="在列表中展示邮件摘要。"><input type="checkbox" checked={settings.showSnippets} onChange={(event) => updateAppSettings({ showSnippets: event.target.checked })} /></SettingRow>
        <SettingRow title="显示账户来源" detail="聚合视图中显示 Gmail、Outlook 等来源标记。"><input type="checkbox" checked={settings.showSourceBadges} onChange={(event) => updateAppSettings({ showSourceBadges: event.target.checked })} /></SettingRow>
      </section>

      <section className="settings-section">
        <header><Mail /><div><h3>邮件阅读</h3><p>控制正文显示方式和远程图片策略。</p></div></header>
        <SettingRow title="阅读字号" detail="调整 HTML 与纯文本邮件正文的阅读大小。"><select value={settings.readingFontSize} onChange={(event) => updateAppSettings({ readingFontSize: event.target.value as typeof settings.readingFontSize })}><option value="small">较小</option><option value="medium">标准</option><option value="large">较大</option></select></SettingRow>
        <SettingRow title="远程图片" detail="可信发件人模式可逐个允许常用发件人。"><select value={settings.remoteImagePolicy} onChange={(event) => updateAppSettings({ remoteImagePolicy: event.target.value as typeof settings.remoteImagePolicy })}><option value="block">始终阻止</option><option value="trusted">仅可信发件人</option><option value="always">始终显示</option></select></SettingRow>
        <SettingRow title="打开后标为已读" detail="关闭后，阅读邮件不会自动修改已读状态。"><input type="checkbox" checked={settings.markReadOnOpen} onChange={(event) => updateAppSettings({ markReadOnOpen: event.target.checked })} /></SettingRow>
      </section>

      <section className="settings-section">
        <header><Keyboard /><div><h3>操作</h3><p>为高频邮件整理保留键盘优先的工作流。</p></div></header>
        <SettingRow title="启用快捷键" detail="支持 J/K、E、S、U、R、C、/ 和 Esc。"><input type="checkbox" checked={settings.keyboardShortcutsEnabled} onChange={(event) => updateAppSettings({ keyboardShortcutsEnabled: event.target.checked })} /></SettingRow>
      </section>

      <AccountSyncSettings />
      {!nativeMobile ? <><VpsRelaySettings /><DevicePairingSettings /></> : null}

      <section className="settings-section compact-section">
        <header><ShieldCheck /><div><h3>隐私</h3><p>远程图片仍通过现有 CSP 隔离策略加载，不会放开脚本、表单或网络请求。</p></div></header>
        <div className="trusted-summary"><SlidersHorizontal /><span>已信任 {settings.trustedRemoteImageSenders.length} 个远程图片发件人</span>{settings.trustedRemoteImageSenders.length ? <button type="button" onClick={() => updateAppSettings({ trustedRemoteImageSenders: [] })}><Trash2 />全部清除</button> : null}</div>
        {settings.trustedRemoteImageSenders.length ? <div className="trusted-sender-list">{settings.trustedRemoteImageSenders.map((sender) => <div key={sender}><span title={sender}>{sender}</span><button type="button" onClick={() => untrustRemoteImageSender(sender)} aria-label={`不再信任 ${sender}`} title="不再自动显示图片"><X /></button></div>)}</div> : <p className="trusted-empty">当你在邮件正文中选择“始终显示此发件人的图片”后，会在这里管理。</p>}
      </section>

      <footer className="settings-footer"><button onClick={() => resetAppSettings()}><RotateCcw />恢复默认设置</button><button className="primary-action" onClick={onClose}>完成</button></footer>
    </div>
  </Modal>;
}
