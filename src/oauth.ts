import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { decryptSecret, encryptSecret } from "./crypto.js";
import type { MailAccount } from "./types.js";

export type OAuthMailProvider = "google" | "microsoft";

type OAuthCredential = {
  version: 1;
  provider: OAuthMailProvider;
  email: string;
  displayName: string;
  clientId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
};

type OAuthFlow = {
  id: string;
  state: string;
  nonce: string;
  verifier: string;
  provider: OAuthMailProvider;
  redirectUri: string;
  createdAt: number;
  status: "pending" | "authorized" | "success" | "error";
  error: string;
  accountId: number | null;
};

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
};

type OAuthManagerOptions = {
  encryptionKey: Buffer;
  databasePath: string;
  port: number;
  googleClientId: string;
  microsoftClientId: string;
  redirectBaseUrl?: string;
};

const flowLifetimeMs = 10 * 60_000;
const refreshSkewMs = 2 * 60_000;
const googleScopes = ["openid", "email", "profile", "https://mail.google.com/"];
const microsoftScopes = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "https://outlook.office.com/IMAP.AccessAsUser.All",
  "https://outlook.office.com/SMTP.Send"
];

function base64Url(input: Buffer): string {
  return input.toString("base64url");
}

function oauthFailure(message: string, status = 401): Error {
  const error = new Error(message) as Error & { status: number };
  error.status = status;
  return error;
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const part = token.split(".")[1];
  if (!part) throw oauthFailure("OAuth 身份令牌格式不正确");
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw oauthFailure("OAuth 身份令牌无法解析");
  }
}

function stringClaim(payload: Record<string, unknown>, ...names: string[]): string {
  for (const name of names) {
    const value = payload[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function audienceMatches(payload: Record<string, unknown>, clientId: string): boolean {
  const audience = payload.aud;
  if (typeof audience === "string") return audience === clientId;
  return Array.isArray(audience) && audience.some((value) => value === clientId);
}

class OAuthCredentialStore {
  constructor(private readonly filePath: string, private readonly encryptionKey: Buffer) {}

  get(syncId: string): OAuthCredential | null {
    const encrypted = this.read()[syncId];
    if (!encrypted) return null;
    try {
      const parsed = JSON.parse(decryptSecret(encrypted, this.encryptionKey)) as OAuthCredential;
      if (parsed.version !== 1 || !parsed.provider || !parsed.refreshToken) throw new Error("invalid credential");
      return parsed;
    } catch {
      throw oauthFailure("OAuth 凭据存储损坏，请重新授权邮箱");
    }
  }

  set(syncId: string, credential: OAuthCredential): void {
    const records = this.read();
    records[syncId] = encryptSecret(JSON.stringify(credential), this.encryptionKey);
    this.write(records);
  }

  delete(syncId: string): void {
    const records = this.read();
    if (!(syncId in records)) return;
    delete records[syncId];
    this.write(records);
  }

  private read(): Record<string, string> {
    if (!fs.existsSync(this.filePath)) return {};
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as { version?: number; records?: Record<string, string> };
      if (parsed.version !== 1 || !parsed.records || typeof parsed.records !== "object") throw new Error("invalid store");
      return parsed.records;
    } catch {
      throw oauthFailure("OAuth 凭据文件无法读取，请检查本地数据目录");
    }
  }

  private write(records: Record<string, string>): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, `${JSON.stringify({ version: 1, records }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  }
}

export class OAuthManager {
  private readonly flows = new Map<string, OAuthFlow>();
  private readonly store: OAuthCredentialStore;

  constructor(private readonly options: OAuthManagerOptions) {
    this.store = new OAuthCredentialStore(`${options.databasePath}.oauth-secrets.json`, options.encryptionKey);
  }

  available(provider: OAuthMailProvider): boolean {
    return Boolean(this.clientId(provider));
  }

  marker(provider: OAuthMailProvider): string {
    return encryptSecret(`oauth-v1:${provider}`, this.options.encryptionKey);
  }

  providerForAccount(account: MailAccount): OAuthMailProvider | null {
    try {
      const value = decryptSecret(account.encryptedPassword, this.options.encryptionKey);
      if (value === "oauth-v1:google") return "google";
      if (value === "oauth-v1:microsoft") return "microsoft";
      return null;
    } catch {
      return null;
    }
  }

  saveCredential(syncId: string, credential: OAuthCredential): void {
    this.store.set(syncId, credential);
  }

  deleteCredential(syncId: string): void {
    this.store.delete(syncId);
  }

  start(provider: OAuthMailProvider): { flowId: string; authorizationUrl: string } {
    this.cleanupFlows();
    const clientId = this.clientId(provider);
    if (!clientId) {
      throw oauthFailure(provider === "google" ? "尚未配置 Google OAuth Client ID" : "尚未配置 Microsoft OAuth Client ID", 503);
    }
    const verifier = base64Url(crypto.randomBytes(48));
    const challenge = base64Url(crypto.createHash("sha256").update(verifier).digest());
    const flow: OAuthFlow = {
      id: crypto.randomUUID(),
      state: base64Url(crypto.randomBytes(32)),
      nonce: base64Url(crypto.randomBytes(24)),
      verifier,
      provider,
      redirectUri: this.redirectUri(provider),
      createdAt: Date.now(),
      status: "pending",
      error: "",
      accountId: null
    };
    this.flows.set(flow.id, flow);

    const params = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      redirect_uri: flow.redirectUri,
      response_mode: "query",
      scope: this.scopes(provider).join(" "),
      state: flow.state,
      nonce: flow.nonce,
      code_challenge: challenge,
      code_challenge_method: "S256"
    });
    if (provider === "google") {
      params.set("access_type", "offline");
      params.set("prompt", "consent select_account");
    } else {
      params.set("prompt", "select_account");
    }
    const endpoint = provider === "google"
      ? "https://accounts.google.com/o/oauth2/v2/auth"
      : "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
    return { flowId: flow.id, authorizationUrl: `${endpoint}?${params}` };
  }

  async completeCallback(state: string, code: string, providerError = "", providerErrorDescription = ""): Promise<{ flowId: string; credential: OAuthCredential }> {
    this.cleanupFlows();
    const flow = [...this.flows.values()].find((item) => item.state === state);
    if (!flow || flow.status !== "pending") throw oauthFailure("OAuth 授权请求不存在或已过期", 400);
    if (providerError) {
      const message = providerErrorDescription || providerError;
      this.markFlowError(flow.id, `授权未完成：${message}`);
      throw oauthFailure(`授权未完成：${message}`, 400);
    }
    if (!code) {
      this.markFlowError(flow.id, "授权服务器没有返回授权码");
      throw oauthFailure("授权服务器没有返回授权码", 400);
    }

    try {
      const credential = await this.exchangeCode(flow, code);
      flow.status = "authorized";
      return { flowId: flow.id, credential };
    } catch (error) {
      const message = error instanceof Error ? error.message : "OAuth 授权失败";
      this.markFlowError(flow.id, message);
      throw error;
    }
  }

  flowStatus(flowId: string): { status: OAuthFlow["status"]; error: string; accountId: number | null } {
    this.cleanupFlows();
    const flow = this.flows.get(flowId);
    if (!flow) return { status: "error", error: "授权请求已过期，请重新开始", accountId: null };
    return { status: flow.status, error: flow.error, accountId: flow.accountId };
  }

  markFlowSuccess(flowId: string, accountId: number): void {
    const flow = this.flows.get(flowId);
    if (!flow) return;
    flow.status = "success";
    flow.accountId = accountId;
    flow.error = "";
  }

  markFlowError(flowId: string, message: string): void {
    const flow = this.flows.get(flowId);
    if (!flow) return;
    flow.status = "error";
    flow.error = message.slice(0, 1000);
  }

  async accessToken(account: MailAccount): Promise<string> {
    const provider = this.providerForAccount(account);
    if (!provider) throw oauthFailure("该邮箱不是 OAuth 账户", 400);
    const credential = this.store.get(account.syncId);
    if (!credential || credential.provider !== provider) throw oauthFailure("OAuth 授权信息不存在，请重新授权邮箱");
    if (credential.accessToken && credential.expiresAt > Date.now() + refreshSkewMs) return credential.accessToken;
    const refreshed = await this.refresh(credential);
    this.store.set(account.syncId, refreshed);
    return refreshed.accessToken;
  }

  private clientId(provider: OAuthMailProvider): string {
    return (provider === "google" ? this.options.googleClientId : this.options.microsoftClientId).trim();
  }

  private scopes(provider: OAuthMailProvider): string[] {
    return provider === "google" ? googleScopes : microsoftScopes;
  }

  private redirectUri(provider: OAuthMailProvider): string {
    const configured = this.options.redirectBaseUrl?.trim().replace(/\/+$/, "");
    if (configured) return configured;
    return provider === "google"
      ? `http://127.0.0.1:${this.options.port}`
      : `http://localhost:${this.options.port}`;
  }

  private async exchangeCode(flow: OAuthFlow, code: string): Promise<OAuthCredential> {
    const clientId = this.clientId(flow.provider);
    const tokenEndpoint = flow.provider === "google"
      ? "https://oauth2.googleapis.com/token"
      : "https://login.microsoftonline.com/common/oauth2/v2.0/token";
    const body = new URLSearchParams({
      client_id: clientId,
      code,
      code_verifier: flow.verifier,
      redirect_uri: flow.redirectUri,
      grant_type: "authorization_code"
    });
    if (flow.provider === "microsoft") body.set("scope", this.scopes(flow.provider).join(" "));
    const token = await this.tokenRequest(tokenEndpoint, body);
    if (!token.access_token || !token.refresh_token || !token.id_token) {
      throw oauthFailure("授权服务器没有返回完整的 OAuth 凭据，请撤销旧授权后重试");
    }
    const claims = decodeJwtPayload(token.id_token);
    if (!audienceMatches(claims, clientId)) throw oauthFailure("OAuth 身份令牌的客户端不匹配");
    if (stringClaim(claims, "nonce") !== flow.nonce) throw oauthFailure("OAuth 身份令牌 nonce 校验失败");
    const issuer = stringClaim(claims, "iss");
    if (flow.provider === "google" && !["https://accounts.google.com", "accounts.google.com"].includes(issuer)) {
      throw oauthFailure("Google OAuth 身份令牌签发方不正确");
    }
    if (flow.provider === "microsoft" && !issuer.startsWith("https://login.microsoftonline.com/")) {
      throw oauthFailure("Microsoft OAuth 身份令牌签发方不正确");
    }
    const email = stringClaim(claims, "email", "preferred_username", "upn");
    if (!email.includes("@")) throw oauthFailure("无法从 OAuth 授权结果识别邮箱地址");
    if (flow.provider === "google" && claims.email_verified === false) throw oauthFailure("Google 账户邮箱地址尚未验证");
    return {
      version: 1,
      provider: flow.provider,
      email,
      displayName: stringClaim(claims, "name") || email.split("@")[0] || email,
      clientId,
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: Date.now() + Math.max(60, Number(token.expires_in ?? 3600)) * 1000,
      scope: token.scope || this.scopes(flow.provider).join(" ")
    };
  }

  private async refresh(credential: OAuthCredential): Promise<OAuthCredential> {
    const clientId = this.clientId(credential.provider);
    if (!clientId || clientId !== credential.clientId) throw oauthFailure("OAuth Client ID 已变化，请重新授权邮箱");
    const tokenEndpoint = credential.provider === "google"
      ? "https://oauth2.googleapis.com/token"
      : "https://login.microsoftonline.com/common/oauth2/v2.0/token";
    const body = new URLSearchParams({
      client_id: clientId,
      refresh_token: credential.refreshToken,
      grant_type: "refresh_token"
    });
    if (credential.provider === "microsoft") body.set("scope", this.scopes(credential.provider).join(" "));
    const token = await this.tokenRequest(tokenEndpoint, body);
    if (!token.access_token) throw oauthFailure("OAuth access token 刷新失败，请重新授权邮箱");
    return {
      ...credential,
      accessToken: token.access_token,
      refreshToken: token.refresh_token || credential.refreshToken,
      expiresAt: Date.now() + Math.max(60, Number(token.expires_in ?? 3600)) * 1000,
      scope: token.scope || credential.scope
    };
  }

  private async tokenRequest(endpoint: string, body: URLSearchParams): Promise<TokenResponse> {
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(15_000)
      });
    } catch (error) {
      throw oauthFailure(`OAuth 服务连接失败：${error instanceof Error ? error.message : String(error)}`, 503);
    }
    const token = await response.json().catch(() => ({})) as TokenResponse;
    if (!response.ok || token.error) {
      const message = token.error_description || token.error || `HTTP ${response.status}`;
      const status = token.error === "invalid_grant" ? 401 : response.status >= 500 ? 503 : 400;
      throw oauthFailure(`OAuth token 请求失败：${message}`, status);
    }
    return token;
  }

  private cleanupFlows(): void {
    const cutoff = Date.now() - flowLifetimeMs;
    for (const [id, flow] of this.flows) {
      if (flow.createdAt < cutoff) this.flows.delete(id);
    }
  }
}

export type { OAuthCredential };
