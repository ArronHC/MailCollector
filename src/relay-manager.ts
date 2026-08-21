import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { decryptSecret, encryptSecret } from "./crypto.js";

const FRP_VERSION = "0.70.1";
const relayTokenEnvName = "MAILCOLLECTOR_FRP_TOKEN";

type StoredRelaySettings = {
  version: 1;
  enabled: boolean;
  serverAddr: string;
  serverPort: number;
  remotePort: number;
  publicUrl: string;
  encryptedAuthToken: string;
};

export type RelayConfigInput = {
  enabled: boolean;
  serverAddr: string;
  serverPort: number;
  remotePort: number;
  publicUrl: string;
  authToken?: string;
};

export type RelayStatus = {
  available: boolean;
  frpVersion: string;
  configured: boolean;
  enabled: boolean;
  processRunning: boolean;
  tunnelConnected: boolean;
  publicReachable: boolean;
  serverAddr: string;
  serverPort: number;
  remotePort: number;
  publicUrl: string;
  hasAuthToken: boolean;
  lastProbeAt: string | null;
  lastProbeLatencyMs: number | null;
  lastError: string | null;
};

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n")}"`;
}

function normalizePublicUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw Object.assign(new Error("公网地址必须使用 http:// 或 https://"), { status: 400 });
  }
  if (url.username || url.password || url.search || url.hash) {
    throw Object.assign(new Error("公网地址不能包含账号、查询参数或锚点"), { status: 400 });
  }
  if (url.pathname !== "/") {
    throw Object.assign(new Error("公网地址请填写站点根地址，不要包含路径"), { status: 400 });
  }
  return url.toString().replace(/\/$/, "");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RelayManager {
  private readonly settingsPath: string;
  private readonly configPath: string;
  private readonly logPath: string;
  private readonly frpcPath: string;
  private readonly encryptionKey: Buffer;
  private readonly localPort: number;
  private settings: StoredRelaySettings | null;
  private child: ChildProcess | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private intentionalStop = false;
  private tunnelConnected = false;
  private publicReachable = false;
  private lastProbeAt: string | null = null;
  private lastProbeLatencyMs: number | null = null;
  private lastError: string | null = null;

  constructor(options: { dataDir: string; runtimeDir: string; localPort: number; encryptionKey: Buffer }) {
    this.settingsPath = path.join(options.dataDir, "relay-settings.json");
    this.configPath = path.join(options.dataDir, "frpc.toml");
    this.logPath = path.join(options.dataDir, "frpc.log");
    this.frpcPath = path.join(options.runtimeDir, "frpc.exe");
    this.encryptionKey = options.encryptionKey;
    this.localPort = options.localPort;
    this.settings = this.loadSettings();
    if (this.settings?.enabled) setImmediate(() => void this.start().catch((error) => this.captureError(error)));
  }

  status(): RelayStatus {
    const token = this.readToken();
    return {
      available: process.platform === "win32" && fs.existsSync(this.frpcPath),
      frpVersion: FRP_VERSION,
      configured: Boolean(this.settings?.serverAddr && this.settings.publicUrl && token),
      enabled: this.settings?.enabled ?? false,
      processRunning: Boolean(this.child && this.child.exitCode === null),
      tunnelConnected: this.tunnelConnected,
      publicReachable: this.publicReachable,
      serverAddr: this.settings?.serverAddr ?? "",
      serverPort: this.settings?.serverPort ?? 7000,
      remotePort: this.settings?.remotePort ?? 23001,
      publicUrl: this.settings?.publicUrl ?? "",
      hasAuthToken: Boolean(token),
      lastProbeAt: this.lastProbeAt,
      lastProbeLatencyMs: this.lastProbeLatencyMs,
      lastError: this.lastError
    };
  }

  async configure(input: RelayConfigInput): Promise<RelayStatus> {
    const serverAddr = input.serverAddr.trim();
    const existingToken = this.readToken();
    const authToken = input.authToken?.trim() || existingToken;
    const publicUrl = input.publicUrl.trim() ? normalizePublicUrl(input.publicUrl) : "";

    if (input.enabled) {
      if (!serverAddr) throw Object.assign(new Error("请输入 VPS 地址"), { status: 400 });
      if (authToken.length < 16) throw Object.assign(new Error("Relay Token 至少需要 16 个字符"), { status: 400 });
      if (!publicUrl) throw Object.assign(new Error("请输入手机访问的 HTTPS 地址"), { status: 400 });
    }

    const stored: StoredRelaySettings = {
      version: 1,
      enabled: input.enabled,
      serverAddr,
      serverPort: input.serverPort,
      remotePort: input.remotePort,
      publicUrl,
      encryptedAuthToken: authToken ? encryptSecret(authToken, this.encryptionKey) : ""
    };
    fs.writeFileSync(this.settingsPath, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
    this.settings = stored;
    this.publicReachable = false;
    this.lastProbeAt = null;
    this.lastProbeLatencyMs = null;
    this.lastError = null;

    if (stored.enabled) await this.restart();
    else this.stop();
    return this.status();
  }

  async restart(): Promise<RelayStatus> {
    this.stop();
    await this.start();
    return this.status();
  }

  async testPublic(): Promise<RelayStatus> {
    if (!this.settings?.enabled) throw Object.assign(new Error("请先启用 VPS Relay"), { status: 409 });
    await this.start();
    const endpoint = `${this.settings.publicUrl}/api/service`;
    let latestError: unknown = new Error("Relay 暂时不可达");

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const startedAt = Date.now();
      try {
        const response = await fetch(endpoint, {
          method: "GET",
          headers: { Accept: "application/json", "User-Agent": "MailCollector-Relay-Probe/1" },
          signal: controller.signal
        });
        if (!response.ok) throw new Error(`HTTPS 入口返回 ${response.status}`);
        const body = await response.json() as { service?: string };
        if (body.service !== "mail-collector") throw new Error("HTTPS 入口没有指向当前 Mail Collector");
        this.publicReachable = true;
        this.lastProbeAt = new Date().toISOString();
        this.lastProbeLatencyMs = Date.now() - startedAt;
        this.lastError = null;
        return this.status();
      } catch (error) {
        latestError = error;
        this.publicReachable = false;
      } finally {
        clearTimeout(timeout);
      }
      await delay(700);
    }

    this.lastProbeAt = new Date().toISOString();
    this.lastProbeLatencyMs = null;
    this.captureError(latestError);
    throw Object.assign(new Error(this.lastError ?? "Relay 暂时不可达"), { status: 502 });
  }

  close(): void {
    this.closed = true;
    this.stop();
  }

  private loadSettings(): StoredRelaySettings | null {
    if (!fs.existsSync(this.settingsPath)) return null;
    try {
      const value = JSON.parse(fs.readFileSync(this.settingsPath, "utf8")) as Partial<StoredRelaySettings>;
      if (value.version !== 1) return null;
      if (typeof value.enabled !== "boolean" || typeof value.serverAddr !== "string" || typeof value.publicUrl !== "string") return null;
      if (!Number.isInteger(value.serverPort) || !Number.isInteger(value.remotePort) || typeof value.encryptedAuthToken !== "string") return null;
      return value as StoredRelaySettings;
    } catch (error) {
      this.captureError(error);
      return null;
    }
  }

  private readToken(): string {
    if (!this.settings?.encryptedAuthToken) return "";
    try {
      return decryptSecret(this.settings.encryptedAuthToken, this.encryptionKey);
    } catch (error) {
      this.captureError(error);
      return "";
    }
  }

  private writeConfig(): { authToken: string } {
    if (!this.settings) throw Object.assign(new Error("VPS Relay 尚未配置"), { status: 409 });
    const authToken = this.readToken();
    if (!authToken) throw Object.assign(new Error("VPS Relay Token 不可用，请重新保存配置"), { status: 409 });
    const config = [
      `serverAddr = ${tomlString(this.settings.serverAddr)}`,
      `serverPort = ${this.settings.serverPort}`,
      "loginFailExit = false",
      "auth.method = \"token\"",
      `auth.token = \"{{ .Envs.${relayTokenEnvName} }}\"`,
      "auth.additionalScopes = [\"HeartBeats\", \"NewWorkConns\"]",
      "transport.tls.enable = true",
      "",
      "[[proxies]]",
      "name = \"mail-collector\"",
      "type = \"tcp\"",
      "localIP = \"127.0.0.1\"",
      `localPort = ${this.localPort}`,
      `remotePort = ${this.settings.remotePort}`,
      ""
    ].join("\n");
    fs.writeFileSync(this.configPath, config, { mode: 0o600 });
    return { authToken };
  }

  private async start(): Promise<void> {
    if (this.closed || !this.settings?.enabled) return;
    if (this.child && this.child.exitCode === null) return;
    if (process.platform !== "win32" || !fs.existsSync(this.frpcPath)) {
      throw Object.assign(new Error("当前桌面运行时没有包含 frpc.exe，请重新安装最新版 Mail Collector"), { status: 503 });
    }

    const { authToken } = this.writeConfig();
    const childEnv = { ...process.env, [relayTokenEnvName]: authToken };
    try {
      execFileSync(this.frpcPath, ["verify", "-c", this.configPath], {
        env: childEnv,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      this.captureError(error);
      throw Object.assign(new Error("FRP 配置校验失败"), { status: 400 });
    }

    this.intentionalStop = false;
    this.tunnelConnected = false;
    const child = spawn(this.frpcPath, ["-c", this.configPath], {
      cwd: path.dirname(this.frpcPath),
      env: childEnv,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    this.child = child;
    const onOutput = (chunk: Buffer) => this.handleOutput(chunk.toString("utf8"));
    child.stdout?.on("data", onOutput);
    child.stderr?.on("data", onOutput);
    child.on("error", (error) => this.captureError(error));
    child.on("exit", (code, signal) => {
      if (this.child === child) this.child = null;
      this.tunnelConnected = false;
      if (!this.intentionalStop && !this.closed && this.settings?.enabled) {
        this.lastError = `FRP 客户端已退出${code !== null ? ` (${code})` : signal ? ` (${signal})` : ""}，正在自动重连`;
        this.scheduleRestart();
      }
    });
  }

  private stop(): void {
    this.intentionalStop = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.child && this.child.exitCode === null) this.child.kill();
    this.child = null;
    this.tunnelConnected = false;
    this.publicReachable = false;
  }

  private scheduleRestart(): void {
    if (this.restartTimer || this.closed) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.start().catch((error) => {
        this.captureError(error);
        this.scheduleRestart();
      });
    }, 3000);
    this.restartTimer.unref();
  }

  private handleOutput(output: string): void {
    fs.appendFileSync(this.logPath, output);
    const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (const line of lines) {
      if (/login to server success|start proxy success/i.test(line)) {
        this.tunnelConnected = true;
        this.lastError = null;
      } else if (/login to server failed|start error|authorization failed|port already used/i.test(line)) {
        this.tunnelConnected = false;
        this.lastError = line.slice(-500);
      }
    }
  }

  private captureError(error: unknown): void {
    this.lastError = error instanceof Error ? error.message : String(error);
  }
}
