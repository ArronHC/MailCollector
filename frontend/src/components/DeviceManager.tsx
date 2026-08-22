import { useEffect, useState } from "react";
import { Monitor, Smartphone, Trash2 } from "lucide-react";
import { api } from "../api";

type Device = {
  id: string;
  name: string;
  platform: "windows" | "android" | "web";
  lastSeenAt: string;
  lastSyncRevision: number;
};

function icon(platform: Device["platform"]) {
  return platform === "android" ? <Smartphone /> : <Monitor />;
}

export function DeviceManager() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [error, setError] = useState("");

  async function load() {
    try {
      const result = await api.devices();
      setDevices(result.devices);
    } catch (e) {
      setError(e instanceof Error ? e.message : "无法加载设备");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function remove(id: string) {
    await api.removeDevice(id);
    await load();
  }

  return <div className="device-manager">
    {error ? <p>{error}</p> : null}
    {devices.map((device) => <div className="device-row" key={device.id}>
      {icon(device.platform)}
      <div>
        <strong>{device.name}</strong>
        <span>{device.platform} · revision {device.lastSyncRevision}</span>
        <small>{new Date(device.lastSeenAt).toLocaleString()}</small>
      </div>
      <button type="button" onClick={() => void remove(device.id)}><Trash2 /></button>
    </div>)}
  </div>;
}
