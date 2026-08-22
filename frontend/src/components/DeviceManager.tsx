import { useEffect, useState } from "react";
import { Monitor, RefreshCw, Smartphone, Trash2 } from "lucide-react";
import { api, type ClientDevice } from "../api";
import { getDeviceId } from "../device-info";
import "./DeviceManager.css";

function icon(platform: ClientDevice["platform"]) {
  return platform === "android" ? <Smartphone /> : <Monitor />;
}

function platformName(platform: ClientDevice["platform"]): string {
  if (platform === "android") return "Android";
  if (platform === "windows") return "Windows";
  return "Web";
}

export function DeviceManager() {
  const currentDeviceId = getDeviceId();
  const [devices, setDevices] = useState<ClientDevice[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [removingId, setRemovingId] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const result = await api.devices();
      setDevices(result.devices);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法加载设备");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function remove(id: string) {
    if (id === currentDeviceId || removingId) return;
    setRemovingId(id);
    try {
      await api.removeDevice(id);
      setDevices((current) => current.filter((device) => device.id !== id));
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "移除设备失败");
    } finally {
      setRemovingId(null);
    }
  }

  return <div className="device-manager">
    <div className="device-manager-toolbar">
      <span>{devices.length ? `${devices.length} 台已登录设备` : "已登录设备"}</span>
      <button type="button" className="device-refresh" onClick={() => void load()} disabled={loading}>
        <RefreshCw />{loading ? "刷新中" : "刷新"}
      </button>
    </div>

    {error ? <p className="device-manager-error">{error}</p> : null}

    <div className="device-list">
      {devices.map((device) => {
        const isCurrent = device.id === currentDeviceId;
        return <div className={`device-row${isCurrent ? " current" : ""}`} key={device.id}>
          <div className="device-icon">{icon(device.platform)}</div>
          <div className="device-copy">
            <div className="device-name-line">
              <strong>{device.name}</strong>
              {isCurrent ? <span className="device-current-badge">本机</span> : null}
            </div>
            <span>{platformName(device.platform)} · revision {device.lastSyncRevision}</span>
            <small>最近在线 {new Date(device.lastSeenAt).toLocaleString("zh-CN")}</small>
          </div>
          {isCurrent
            ? <span className="device-current-note">当前设备</span>
            : <button type="button" className="device-remove" title="移除此设备" aria-label={`移除 ${device.name}`} disabled={removingId === device.id} onClick={() => void remove(device.id)}><Trash2 /></button>}
        </div>;
      })}
      {!loading && devices.length === 0 ? <p className="device-manager-empty">暂无已登录设备。</p> : null}
    </div>
  </div>;
}
