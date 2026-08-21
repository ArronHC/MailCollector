import { useEffect, useState } from "react";
import { api } from "../api";
import {
  approvePairingRequest,
  createPairingOffer,
  listPendingPairings,
  rejectPairingRequest,
  type PairingOffer,
  type PairingRequest
} from "../device-pairing";

export function DevicePairingSettings() {
  const [offer, setOffer] = useState<PairingOffer | null>(null);
  const [pending, setPending] = useState<PairingRequest[]>([]);
  const [backendUrl, setBackendUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function refreshPending() {
    try {
      setPending(await listPendingPairings());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法获取配对请求");
    }
  }

  useEffect(() => {
    if (!offer) return;
    void refreshPending();
    const timer = window.setInterval(() => void refreshPending(), 1500);
    return () => window.clearInterval(timer);
  }, [offer?.pairingId]);

  async function createOffer() {
    setBusy(true);
    setError("");
    try {
      const created = await createPairingOffer();
      setOffer(created);
      setBackendUrl(created.publicBaseUrl || window.location.origin);
      setPending([]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法创建设备配对码");
    } finally {
      setBusy(false);
    }
  }

  async function approve(request: PairingRequest) {
    setBusy(true);
    setError("");
    try {
      const { recoveryKey } = await api.ensureAccountSyncRecoveryKey();
      await approvePairingRequest(request, backendUrl || window.location.origin, recoveryKey);
      await refreshPending();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法批准设备");
    } finally {
      setBusy(false);
    }
  }

  async function reject(request: PairingRequest) {
    setBusy(true);
    setError("");
    try {
      await rejectPairingRequest(request.pairingId);
      await refreshPending();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法拒绝设备");
    } finally {
      setBusy(false);
    }
  }

  return <section className="settings-section">
    <header><div><h3>设备配对</h3><p>用一次性 6 位码把手机安全连接到当前 Mail Collector。</p></div></header>
    <div className="setting-row">
      <div><strong>新设备</strong><span>配对码 5 分钟内有效，只能被一个设备使用。</span></div>
      <div className="setting-control"><button type="button" onClick={() => void createOffer()} disabled={busy}>{busy ? "处理中…" : "生成配对码"}</button></div>
    </div>
    {offer ? <div className="pairing-offer">
      <strong className="pairing-code">{offer.code}</strong>
      <span>在手机 Mail Collector 中输入此代码。</span>
      <label><span>手机连接地址</span><input value={backendUrl} onChange={(event) => setBackendUrl(event.target.value)} placeholder="https://mail.example.com" /></label>
      <small>如果这里是 127.0.0.1，请改成手机实际能访问的局域网或 HTTPS 地址。</small>
    </div> : null}
    {pending.map((request) => <div className="setting-row" key={request.pairingId}>
      <div><strong>{request.deviceName}</strong><span>{request.platform} · 正在请求配对</span></div>
      <div className="setting-control pairing-actions">
        <button type="button" onClick={() => void reject(request)} disabled={busy}>拒绝</button>
        <button type="button" className="primary-action" onClick={() => void approve(request)} disabled={busy || !backendUrl.trim()}>批准</button>
      </div>
    </div>)}
    {offer && !pending.length ? <p className="trusted-empty">等待手机提交配对码…</p> : null}
    {error ? <div className="mobile-backend-error">{error}</div> : null}
  </section>;
}
