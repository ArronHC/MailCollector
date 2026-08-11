import { useEffect, useEffectEvent, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { api, auth, backend, unauthorizedEvent } from "./api";
import { AccountDialog, type AccountForm } from "./components/AccountDialog";
import { ComposeDialog, type ComposeSeed } from "./components/ComposeDialog";
import { BackendSettingsDialog } from "./components/BackendSettingsDialog";
import { MailListPanel } from "./components/MailListPanel";
import { MailReaderPanel } from "./components/MailReaderPanel";
import { LoginScreen } from "./components/LoginScreen";
import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { Modal, ToastStack, type ToastMessage } from "./components/Ui";
import type { DraftContent, MailAccount, MailDetail, MailItem, MailLabel, MailProvider, MessageActions, MessageView } from "./data/mailData";
import { accountSource, sourceNames } from "./data/mailData";
import { queueAccountConfigDeletion, syncCloudConfiguration } from "./config-sync";

const PAGE_SIZE = 15;
const REMOTE_REFRESH_MS = 15_000;
type TransitionKind = "auth" | "reader";
let transitionSequence = 0;

function transitionState(update: () => void, kind: TransitionKind) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    update();
    return;
  }
  const id = ++transitionSequence;
  document.documentElement.dataset.transition = kind;
  const transitionDocument = document as Document & { startViewTransition?: (callback: () => void) => { finished: Promise<unknown> } };
  const commit = () => flushSync(update);
  if (transitionDocument.startViewTransition) {
    transitionDocument.startViewTransition(commit).finished.finally(() => {
      if (id === transitionSequence) delete document.documentElement.dataset.transition;
    });
  } else {
    commit();
    delete document.documentElement.dataset.transition;
  }
}

export default function App() {
  const [authState, setAuthState] = useState<"checking" | "authenticated" | "guest">("checking");
  const [registered, setRegistered] = useState(false);
  const [backendSettingsOpen, setBackendSettingsOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void backend.initialize().then(() => Promise.all([auth.status(), auth.restore()]))
      .then(([status, restored]) => {
        if (cancelled) return;
        setRegistered(status.registered);
        setAuthState(restored ? "authenticated" : "guest");
      })
      .catch(() => { if (!cancelled) setAuthState("guest"); });
    const unauthorized = () => {
      void auth.status().then((status) => setRegistered(status.registered)).catch(() => undefined);
      transitionState(() => setAuthState("guest"), "auth");
    };
    window.addEventListener(unauthorizedEvent, unauthorized);
    return () => {
      cancelled = true;
      window.removeEventListener(unauthorizedEvent, unauthorized);
    };
  }, []);

  const remoteBackend = false;
  const content = authState === "checking"
    ? <main className="auth-loading"><strong>Mail Collector</strong><span>{remoteBackend ? "正在连接自托管服务器..." : "正在连接本地邮件空间..."}</span></main>
    : authState === "guest"
      ? <LoginScreen registered={registered} remoteBackend={remoteBackend} onBackendSettings={() => setBackendSettingsOpen(true)} onSignIn={async (email, password) => { await auth.signIn(email, password); transitionState(() => setAuthState("authenticated"), "auth"); }} onRegister={async (email, password, inviteCode) => { await auth.register(email, password, inviteCode); setRegistered(true); transitionState(() => setAuthState("authenticated"), "auth"); }} onKeySignIn={async (key) => { await auth.signInWithKey(key); transitionState(() => setAuthState("authenticated"), "auth"); }} />
      : <MailboxApp onBackendSettings={() => setBackendSettingsOpen(true)} onLogout={() => { void auth.signOut().finally(() => transitionState(() => setAuthState("guest"), "auth")); }} />;
  return <>{content}<BackendSettingsDialog open={backendSettingsOpen} onClose={() => setBackendSettingsOpen(false)} /></>;
}

function MailboxApp({ onLogout, onBackendSettings }: { onLogout: () => void; onBackendSettings: () => void }) {
  const [accounts, setAccounts] = useState<MailAccount[]>([]);
  const [providers, setProviders] = useState<MailProvider[]>([]);
  const [labels, setLabels] = useState<MailLabel[]>([]);
  const [mails, setMails] = useState<MailItem[]>([]);
  const [mailDetail, setMailDetail] = useState<MailDetail | null>(null);
  const [activeMailId, setActiveMailId] = useState<number | null>(null);
  const [activeAccountId, setActiveAccountId] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState("全部");
  const [activeNavigation, setActiveNavigation] = useState("统一收件箱");
  const [activeLabelId, setActiveLabelId] = useState<number | null>(null);
  const [view, setView] = useState<MessageView>("inbox");
  const [starredFilter, setStarredFilter] = useState(false);
  const [draftCount, setDraftCount] = useState(0);
  const [checkedIds, setCheckedIds] = useState<Set<number>>(new Set());
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [readerLoading, setReaderLoading] = useState(false);
  const [readerExpanded, setReaderExpanded] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [classifying, setClassifying] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.innerWidth < 700);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [labelOpen, setLabelOpen] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeSeed, setComposeSeed] = useState<ComposeSeed>({});
  const [composeBusy, setComposeBusy] = useState(false);
  const [composeStatus, setComposeStatus] = useState("");
  const [listError, setListError] = useState("");
  const [readerError, setReaderError] = useState("");
  const [syncError, setSyncError] = useState("");
  const [dialogError, setDialogError] = useState("");
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const messageRequestSequence = useRef(0);
  const detailRequestSequence = useRef(0);
  const activeMailIdRef = useRef<number | null>(null);
  const foregroundMessageLoading = useRef(false);
  const readerLoadingRef = useRef(false);
  const remoteRefreshRunning = useRef(false);
  activeMailIdRef.current = activeMailId;

  const activeAccount = accounts.find((account) => account.id === activeAccountId) ?? null;
  const currentBackend = backend.current();
  const remoteMode = currentBackend.mode === "remote";
  const backendLabel = remoteMode ? `本机邮件 · 配置同步：${new URL(currentBackend.serverUrl).host}` : "本机邮件空间";
  const unreadCount = accounts.reduce((sum, account) => sum + account.unreadCount, 0);
  function toast(text: string, tone: ToastMessage["tone"] = "success", actionLabel?: string, onAction?: () => void) {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    setToasts((current) => [...current.slice(-3), { id, text, tone, actionLabel, onAction }]);
    window.setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), 5000);
  }

  const loadMetadata = useEffectEvent(async () => {
    const [accountData, labelData, drafts] = await Promise.all([
      api.accounts(),
      api.labels(),
      api.messages(new URLSearchParams({ view: "drafts", limit: "1", offset: "0" }))
    ]);
    setAccounts(accountData.accounts);
    setLabels(labelData.labels);
    setDraftCount(drafts.total);
  });

  const loadMessages = useEffectEvent(async (silent = false) => {
    if (silent && foregroundMessageLoading.current) return;
    const requestId = ++messageRequestSequence.current;
    if (!silent) {
      foregroundMessageLoading.current = true;
      setLoading(true);
    }
    setListError("");
    try {
      const params = new URLSearchParams({ view, limit: String(PAGE_SIZE), offset: String(offset) });
      if (activeAccountId) params.set("accountId", String(activeAccountId));
      if (activeLabelId) params.set("label", String(activeLabelId));
      if (query) params.set("query", query);
      if (starredFilter) params.set("starred", "true");
      if (activeTab === "未读") params.set("readState", "unread");
      if (activeTab !== "全部" && activeTab !== "未读") {
        const ids = accounts.filter((account) => sourceNames[accountSource(account)] === activeTab).map((account) => account.id);
        if (ids.length) params.set("accountIds", ids.join(",")); else { setMails([]); setTotal(0); return; }
      }
      const data = await api.messages(params);
      if (requestId !== messageRequestSequence.current) return;
      setMails(data.messages);
      setTotal(data.total);
      if (silent) {
        const visible = new Set(data.messages.map((message) => message.id));
        setCheckedIds((current) => new Set([...current].filter((id) => visible.has(id))));
      } else setCheckedIds(new Set());
      if (activeMailId && !data.messages.some((mail) => mail.id === activeMailId) && !new URLSearchParams(location.search).has("message")) {
        detailRequestSequence.current += 1;
        activeMailIdRef.current = null;
        readerLoadingRef.current = false;
        setReaderLoading(false);
        setReaderError("");
        setActiveMailId(null);
        setMailDetail(null);
      }
    } catch (error) {
      if (requestId === messageRequestSequence.current) setListError(error instanceof Error ? error.message : "无法加载邮件");
    } finally {
      if (!silent && requestId === messageRequestSequence.current) {
        foregroundMessageLoading.current = false;
        setLoading(false);
      }
    }
  });

  useEffect(() => {
    void syncCloudConfiguration().catch((error) => { if (backend.current().mode === "remote") setSyncError(error instanceof Error ? error.message : "云配置同步失败"); }).then(() => Promise.all([loadMetadata(), api.providers().then((data) => setProviders(data.providers))])).catch((error) => {
      setListError(error instanceof Error ? error.message : "无法连接服务器");
      setLoading(false);
    });
    const directId = Number(new URLSearchParams(location.search).get("message"));
    if (directId > 0) void openMailById(directId);
  }, []);

  const refreshRemoteState = useEffectEvent(async () => {
    if (remoteRefreshRunning.current) return;
    remoteRefreshRunning.current = true;
    const detailId = activeMailIdRef.current;
    const detailRequestId = detailRequestSequence.current;
    const refreshDetail = detailId && !readerLoadingRef.current;
    try {
      await Promise.all([
        loadMetadata(),
        loadMessages(true),
        refreshDetail ? api.message(detailId).then(({ message }) => {
          if (detailRequestId === detailRequestSequence.current && activeMailIdRef.current === detailId) setMailDetail(message);
        }) : Promise.resolve()
      ]);
    } finally {
      remoteRefreshRunning.current = false;
    }
  });

  useEffect(() => {
    const refresh = () => { void refreshRemoteState().catch(() => undefined); };
    const timer = window.setInterval(refresh, REMOTE_REFRESH_MS);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { setOffset(0); setQuery(search.trim()); }, 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => { void loadMessages(); }, [activeAccountId, activeLabelId, activeTab, view, starredFilter, offset, query, accounts.length]);

  async function openMailById(id: number) {
    const requestId = ++detailRequestSequence.current;
    activeMailIdRef.current = id;
    setActiveMailId(id);
    readerLoadingRef.current = true;
    setReaderLoading(true);
    setReaderError("");
    try {
      const { message } = await api.message(id);
      if (requestId !== detailRequestSequence.current || activeMailIdRef.current !== id) return;
      setMailDetail(message);
      if (!message.isRead && message.kind === "received") {
        const result = await api.updateMessage(id, { isRead: true });
        if (requestId !== detailRequestSequence.current || activeMailIdRef.current !== id) return;
        setMailDetail(result.message);
        setMails((current) => current.map((mail) => mail.id === id ? { ...mail, isRead: true } : mail));
        await loadMetadata();
      }
    } catch (error) {
      if (requestId === detailRequestSequence.current && activeMailIdRef.current === id) setReaderError(error instanceof Error ? error.message : "无法读取邮件");
    } finally {
      if (requestId === detailRequestSequence.current && activeMailIdRef.current === id) {
        readerLoadingRef.current = false;
        setReaderLoading(false);
      }
    }
  }

  async function selectMail(mail: MailItem) {
    if (mail.kind === "draft") {
      try {
        const { message } = await api.message(mail.id);
        setComposeSeed({ draftId: message.id, accountId: message.accountId, to: message.to, cc: message.cc, bcc: message.bcc, subject: message.subject, body: message.textBody ?? "" });
        setComposeOpen(true);
      } catch (error) { toast(error instanceof Error ? error.message : "无法打开草稿", "error"); }
      return;
    }
    await openMailById(mail.id);
  }

  function previousActions(mail: MailItem | MailDetail, actions: MessageActions): MessageActions {
    return {
      ...(actions.isRead !== undefined ? { isRead: mail.isRead } : {}),
      ...(actions.isStarred !== undefined ? { isStarred: mail.isStarred } : {}),
      ...(actions.folder !== undefined ? { folder: mail.folder } : {}),
      ...(actions.snoozedUntil !== undefined ? { snoozedUntil: mail.snoozedUntil } : {}),
      ...(actions.labels !== undefined ? { labels: mail.labels.map((label) => label.id) } : {})
    };
  }

  async function updateOne(id: number, actions: MessageActions, message = "邮件已更新") {
    const before = mailDetail?.id === id ? mailDetail : mails.find((mail) => mail.id === id);
    if (!before) return;
    try {
      const result = await api.updateMessage(id, actions);
      if (activeMailIdRef.current === id) setMailDetail(result.message);
      setMails((current) => current.map((mail) => mail.id === id ? { ...mail, ...result.message } : mail));
      await Promise.all([loadMessages(), loadMetadata()]);
      const undo = previousActions(before, actions);
      toast(message, "success", "撤销", () => { void api.updateMessage(id, undo).then(() => Promise.all([loadMessages(), loadMetadata()])); });
    } catch (error) { toast(error instanceof Error ? error.message : "操作失败", "error"); }
  }

  async function deleteCurrent() {
    if (!mailDetail) return;
    if (mailDetail.folder !== "trash") return updateOne(mailDetail.id, { folder: "trash", snoozedUntil: null }, "已移至垃圾箱");
    if (!window.confirm(remoteMode ? "永久删除服务器上的这封邮件记录？此变更会影响所有设备。" : "永久删除这封本地邮件？此操作无法撤销。")) return;
    try { await api.deleteMessage(mailDetail.id); detailRequestSequence.current += 1; activeMailIdRef.current = null; readerLoadingRef.current = false; setReaderLoading(false); setReaderError(""); setMailDetail(null); setActiveMailId(null); await Promise.all([loadMessages(), loadMetadata()]); toast("邮件已永久删除"); } catch (error) { toast(error instanceof Error ? error.message : "删除失败", "error"); }
  }

  async function bulkAction(actions: MessageActions) {
    const ids = checkedIds.size ? Array.from(checkedIds) : mails.map((mail) => mail.id);
    if (!ids.length) return;
    const snapshots = mails.filter((mail) => ids.includes(mail.id)).map((mail) => ({ id: mail.id, actions: previousActions(mail, actions) }));
    try {
      await api.bulkMessages(ids, actions);
      setCheckedIds(new Set());
      await Promise.all([loadMessages(), loadMetadata()]);
      toast(`已更新 ${ids.length} 封邮件`, "success", "撤销", () => { void Promise.all(snapshots.map((item) => api.updateMessage(item.id, item.actions))).then(() => Promise.all([loadMessages(), loadMetadata()])); });
    } catch (error) { toast(error instanceof Error ? error.message : "批量操作失败", "error"); }
  }

  async function permanentDeleteSelected() {
    const ids = Array.from(checkedIds);
    if (!ids.length || !window.confirm(remoteMode ? `永久删除服务器上选中的 ${ids.length} 封邮件记录？此变更会影响所有设备。` : `永久删除选中的 ${ids.length} 封本地邮件？`)) return;
    try { await Promise.all(ids.map((id) => api.deleteMessage(id))); setCheckedIds(new Set()); await Promise.all([loadMessages(), loadMetadata()]); toast(`已永久删除 ${ids.length} 封邮件`); } catch (error) { toast(error instanceof Error ? error.message : "删除失败", "error"); }
  }

  async function syncMailbox() {
    if (!accounts.length || syncing) return;
    setSyncing(true); setSyncError("");
    try {
      if (activeAccountId) await api.syncAccount(activeAccountId); else { const result = await api.syncAll(); if (result.failed.length) setSyncError(`${result.failed.length} 个邮箱同步失败`); }
      await Promise.all([loadMetadata(), loadMessages()]);
      toast("邮箱同步完成");
    } catch (error) { const text = error instanceof Error ? error.message : "同步失败"; setSyncError(text); toast(text, "error"); } finally { setSyncing(false); }
  }

  async function classifyMailbox() {
    if (classifying) return;
    setClassifying(true);
    try {
      const result = await api.classify(activeAccountId ?? undefined);
      await Promise.all([loadMetadata(), loadMessages()]);
      toast(`自动分类完成：${result.classified} 封邮件，${result.changed} 项更新`);
    } catch (error) {
      toast(error instanceof Error ? error.message : "自动分类失败", "error");
    } finally {
      setClassifying(false);
    }
  }

  function selectWhere(where: "all" | "none" | "read" | "unread" | "starred") {
    if (where === "none") return setCheckedIds(new Set());
    setCheckedIds(new Set(mails.filter((mail) => where === "all" || (where === "read" && mail.isRead) || (where === "unread" && !mail.isRead) || (where === "starred" && mail.isStarred)).map((mail) => mail.id)));
  }

  function openCompose(seed: ComposeSeed = {}) { setComposeSeed(seed); setComposeStatus(""); setComposeOpen(true); }
  function toggleReaderExpanded() {
    transitionState(() => setReaderExpanded((value) => !value), "reader");
  }
  function reply() {
    if (!mailDetail) return;
    openCompose({ accountId: mailDetail.accountId, to: mailDetail.fromAddress ? [mailDetail.fromAddress] : [], subject: mailDetail.subject.startsWith("Re:") ? mailDetail.subject : `Re: ${mailDetail.subject}`, body: `\n\n---- 原始邮件 ----\n发件人：${mailDetail.fromAddress || mailDetail.fromName || ""}\n日期：${new Date(mailDetail.receivedAt).toLocaleString("zh-CN")}\n主题：${mailDetail.subject}\n\n${mailDetail.textBody || mailDetail.snippet}` });
  }

  async function closeCompose(content: DraftContent, draftId?: number, discard = false) {
    setComposeBusy(true);
    try {
      if (discard) { if (draftId) await api.deleteMessage(draftId); toast("草稿已舍弃", "info"); }
      else if (content.to.length || content.cc.length || content.bcc.length || content.subject || content.body) { if (draftId) await api.updateDraft(draftId, content); else await api.createDraft(content); toast("草稿已保存"); }
      setComposeOpen(false); setComposeSeed({}); await Promise.all([loadMetadata(), loadMessages()]);
    } catch (error) { setComposeStatus(error instanceof Error ? error.message : "保存草稿失败"); } finally { setComposeBusy(false); }
  }

  async function sendMessage(content: DraftContent, draftId?: number) {
    setComposeBusy(true); setComposeStatus("");
    try {
      if (draftId) { await api.updateDraft(draftId, content); await api.sendDraft(draftId); } else await api.send(content);
      setComposeOpen(false); setComposeSeed({}); await Promise.all([loadMetadata(), loadMessages()]); toast("邮件已发送");
    } catch (error) { const text = error instanceof Error ? error.message : "发送失败"; setComposeStatus(text); toast(text, "error"); } finally { setComposeBusy(false); }
  }

  async function addAccount(form: AccountForm) {
    setDialogBusy(true); setDialogError("");
    try { const { account } = await api.addAccount({ ...form, mailbox: "INBOX" }); await api.syncAccount(account.id); if (remoteMode) await syncCloudConfiguration(); await Promise.all([loadMetadata(), loadMessages()]); setDialogOpen(false); toast(remoteMode ? "邮箱已添加，配置已加密同步" : "邮箱已添加并完成首次同步"); }
    catch (error) { setDialogError(error instanceof Error ? error.message : "添加邮箱失败"); throw error; }
    finally { setDialogBusy(false); }
  }

  async function manageAccount(action: "sync" | "toggle" | "delete", account: MailAccount) {
    if (action === "delete" && !window.confirm(remoteMode ? `确认删除 ${account.email}？本机邮件会被删除，其他设备会停用该账户配置。` : `确认删除 ${account.email}？本地邮件也会删除。`)) return;
    setDialogBusy(true); setDialogError("");
    try { if (action === "sync") await api.syncAccount(account.id); if (action === "toggle") await api.setAccountEnabled(account.id, !account.enabled); if (action === "delete") { await api.deleteAccount(account.id); queueAccountConfigDeletion(account.syncId); } if (remoteMode && action !== "sync") await syncCloudConfiguration(); await Promise.all([loadMetadata(), loadMessages()]); toast(action === "sync" ? "邮箱同步完成" : action === "toggle" ? "账户状态及云配置已更新" : "邮箱账户已删除，云配置已更新"); }
    catch (error) { setDialogError(error instanceof Error ? error.message : "账户操作失败"); }
    finally { setDialogBusy(false); }
  }

  async function createLabel() {
    const name = newLabel.trim(); if (!name) return;
    try { await api.createLabel(name); setNewLabel(""); setLabelOpen(false); await loadMetadata(); toast("标签已创建"); } catch (error) { toast(error instanceof Error ? error.message : "创建标签失败", "error"); }
  }

  return <div className={`app-shell${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
    <TopBar search={search} onSearch={setSearch} accountCount={accounts.length} syncing={syncing} classifying={classifying} error={syncError} backendLabel={backendLabel} onSync={() => void syncMailbox()} onClassify={() => void classifyMailbox()} onToggleSidebar={() => setSidebarCollapsed((value) => !value)} onHelp={() => setHelpOpen(true)} onSettings={onBackendSettings} onManageAccounts={() => setDialogOpen(true)} onLogout={onLogout} />
    <div className="content-grid"><Sidebar accounts={accounts} labels={labels} activeAccountId={activeAccountId} activeNavigation={activeNavigation} activeLabelId={activeLabelId} unreadCount={unreadCount} draftCount={draftCount} onAccountSelect={(id) => { setActiveAccountId(id); setActiveNavigation(""); setActiveLabelId(null); setView("inbox"); setStarredFilter(false); setActiveTab("全部"); setOffset(0); }} onViewChange={(label, nextView, starred) => { setActiveAccountId(null); setActiveNavigation(label); setActiveLabelId(null); setView(nextView); setStarredFilter(Boolean(starred)); setActiveTab("全部"); setOffset(0); }} onLabelSelect={(label) => { setActiveAccountId(null); setActiveNavigation(label.name); setActiveLabelId(label.id); setView("all"); setStarredFilter(false); setOffset(0); }} onCompose={() => openCompose()} onAddAccount={() => setDialogOpen(true)} onManageAccount={() => setDialogOpen(true)} onCreateLabel={() => setLabelOpen(true)} />
      <MailListPanel mails={mails} accounts={accounts} labels={labels} activeAccount={activeAccount} title={activeNavigation || "收件箱"} activeTab={activeTab} activeMailId={activeMailId} checkedIds={checkedIds} total={total} offset={offset} loading={loading} syncing={syncing} error={listError} trashView={view === "trash"} onTabChange={(tab) => { setActiveTab(tab); setOffset(0); }} onSelect={(mail) => void selectMail(mail)} onStar={(id) => void updateOne(id, { isStarred: !mails.find((mail) => mail.id === id)?.isStarred }, "星标状态已更新")} onCheck={(id) => setCheckedIds((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; })} onCheckAll={() => setCheckedIds((current) => mails.length && mails.every((mail) => current.has(mail.id)) ? new Set() : new Set(mails.map((mail) => mail.id)))} onSelectWhere={selectWhere} onRefresh={() => void syncMailbox()} onBulk={(actions) => void bulkAction(actions)} onPermanentDelete={() => void permanentDeleteSelected()} onPrevious={() => setOffset(Math.max(0, offset - PAGE_SIZE))} onNext={() => setOffset(offset + PAGE_SIZE)} />
      <MailReaderPanel mail={mailDetail} loading={readerLoading} error={readerError} labels={labels} expanded={readerExpanded} onToggleExpanded={toggleReaderExpanded} onAction={(actions) => { if (mailDetail) void updateOne(mailDetail.id, actions); }} onDelete={() => void deleteCurrent()} onStar={() => { if (mailDetail) void updateOne(mailDetail.id, { isStarred: !mailDetail.isStarred }, "星标状态已更新"); }} onReply={reply} onBack={() => { detailRequestSequence.current += 1; activeMailIdRef.current = null; readerLoadingRef.current = false; setReaderLoading(false); setReaderError(""); setReaderExpanded(false); setActiveMailId(null); setMailDetail(null); }} />
    </div>
    <AccountDialog open={dialogOpen} providers={providers} accounts={accounts} busy={dialogBusy} error={dialogError} onClose={() => { setDialogOpen(false); setDialogError(""); }} onSubmit={addAccount} onSync={(account) => manageAccount("sync", account)} onToggle={(account) => manageAccount("toggle", account)} onDelete={(account) => manageAccount("delete", account)} />
    <ComposeDialog open={composeOpen} accounts={accounts} seed={composeSeed} busy={composeBusy} status={composeStatus} onClose={(content, id, discard) => void closeCompose(content, id, discard)} onSend={(content, id) => void sendMessage(content, id)} />
    <Modal open={helpOpen} title="Mail Collector 帮助" onClose={() => setHelpOpen(false)}><div className="help-content"><p>使用顶部搜索查找发件人、主题和正文内容。勾选邮件后可批量归档、移动、延后或添加标签。</p><p>自动分类会在同步新邮件时运行，也可通过顶部按钮重新分析已有邮件。分类和邮件内容始终保存在本机。</p><p>齿轮按钮可启用端到端加密的账户配置同步；云端不会保存邮件正文。</p><p>快捷提示：双击写信窗口标题可最小化；关闭有内容的写信窗口会自动保存草稿。</p></div></Modal>
    <Modal open={labelOpen} title="新建标签" onClose={() => setLabelOpen(false)} className="small-modal"><div className="label-create"><input value={newLabel} onChange={(event) => setNewLabel(event.target.value)} placeholder="标签名称" autoFocus onKeyDown={(event) => { if (event.key === "Enter") void createLabel(); }} /><footer><button onClick={() => setLabelOpen(false)}>取消</button><button className="primary-action" onClick={() => void createLabel()} disabled={!newLabel.trim()}>创建</button></footer></div></Modal>
    <ToastStack toasts={toasts} dismiss={(id) => setToasts((current) => current.filter((item) => item.id !== id))} />
  </div>;
}
