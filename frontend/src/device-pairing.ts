import { normalizeMobileBackendUrl, resolveApiUrl, setMobileBackendUrl, setMobileDeviceToken } from "./mobile-backend";

const pairingPrivateKeyKey = "mailCollectorPairingPrivateKey";
const pairingSessionKey = "mailCollectorPairingSession";
const mobileRecoveryKeyKey = "mailCollectorMobileRecoveryKey";

export type PairingSession = {
  pairingId: string;
  joinToken: string;
  expiresAt: string;
  serviceUrl: string;
};

export type PairingRequest = {
  pairingId: string;
  deviceName: string;
  platform: string;
  requesterPublicKey: string;
  requestedAt: string;
  expiresAt: string;
};

export type PairingOffer = {
  pairingId: string;
  code: string;
  expiresAt: string;
  publicBaseUrl: string;
};

export type PairingBundle = {
  version: 1;
  backendUrl: string;
  recoveryKey: string;
  deviceId: string;
  deviceToken: string;
  issuedAt: string;
};

type ExportedKeyPair = {
  publicKey: JsonWebKey;
  privateKey: JsonWebKey;
};

type EncryptedEnvelope = {
  version: 1;
  iv: string;
  ciphertext: string;
};

type PairingPollResult = {
  status: "requested" | "approved" | "rejected" | "expired";
  approverPublicKey?: string;
  encryptedBundle?: string;
  deviceId?: string;
};

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function generatePairingKeyPair(): Promise<ExportedKeyPair> {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  return {
    publicKey: await crypto.subtle.exportKey("jwk", pair.publicKey),
    privateKey: await crypto.subtle.exportKey("jwk", pair.privateKey)
  };
}

async function deriveEnvelopeKey(privateKey: JsonWebKey, peerPublicKey: JsonWebKey): Promise<CryptoKey> {
  const local = await crypto.subtle.importKey("jwk", privateKey, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const remote = await crypto.subtle.importKey("jwk", peerPublicKey, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const sharedBits = await crypto.subtle.deriveBits({ name: "ECDH", public: remote }, local, 256);
  const hkdfKey = await crypto.subtle.importKey("raw", sharedBits, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: new TextEncoder().encode("MailCollector Device Pairing v1") },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function jsonFetch<T>(url: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");
  if (options.body) headers.set("Content-Type", "application/json");
  const response = await fetch(url, { ...options, headers, credentials: "include" });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `请求失败 (${response.status})`);
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

export async function createRequesterPublicKey(): Promise<string> {
  const pair = await generatePairingKeyPair();
  sessionStorage.setItem(pairingPrivateKeyKey, JSON.stringify(pair.privateKey));
  return JSON.stringify(pair.publicKey);
}

export async function encryptPairingBundle(requesterPublicKey: string, bundle: PairingBundle): Promise<{ approverPublicKey: string; encryptedBundle: string }> {
  const pair = await generatePairingKeyPair();
  const key = await deriveEnvelopeKey(pair.privateKey, JSON.parse(requesterPublicKey) as JsonWebKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(bundle));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));
  const envelope: EncryptedEnvelope = { version: 1, iv: bytesToBase64Url(iv), ciphertext: bytesToBase64Url(ciphertext) };
  return { approverPublicKey: JSON.stringify(pair.publicKey), encryptedBundle: JSON.stringify(envelope) };
}

export async function decryptPairingBundle(approverPublicKey: string, encryptedBundle: string): Promise<PairingBundle> {
  const privateValue = sessionStorage.getItem(pairingPrivateKeyKey);
  if (!privateValue) throw new Error("本机配对密钥已丢失，请重新输入配对码");
  const envelope = JSON.parse(encryptedBundle) as EncryptedEnvelope;
  if (envelope.version !== 1) throw new Error("不支持的配对数据版本");
  const key = await deriveEnvelopeKey(JSON.parse(privateValue) as JsonWebKey, JSON.parse(approverPublicKey) as JsonWebKey);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64UrlToBytes(envelope.iv) }, key, base64UrlToBytes(envelope.ciphertext));
  const bundle = JSON.parse(new TextDecoder().decode(plaintext)) as PairingBundle;
  if (bundle.version !== 1 || !bundle.backendUrl || !bundle.deviceToken || !bundle.deviceId) throw new Error("配对数据不完整");
  return bundle;
}

export function savePairingSession(session: PairingSession): void {
  sessionStorage.setItem(pairingSessionKey, JSON.stringify(session));
}

export function loadPairingSession(): PairingSession | null {
  const value = sessionStorage.getItem(pairingSessionKey);
  if (!value) return null;
  try {
    const session = JSON.parse(value) as PairingSession;
    return session.pairingId && session.joinToken && session.serviceUrl ? session : null;
  } catch {
    return null;
  }
}

export function clearPairingSession(): void {
  sessionStorage.removeItem(pairingSessionKey);
  sessionStorage.removeItem(pairingPrivateKeyKey);
}

export function applyPairingBundle(bundle: PairingBundle): void {
  setMobileBackendUrl(normalizeMobileBackendUrl(bundle.backendUrl));
  setMobileDeviceToken(bundle.deviceToken);
  if (bundle.recoveryKey) localStorage.setItem(mobileRecoveryKeyKey, bundle.recoveryKey);
  clearPairingSession();
}

export function getMobileRecoveryKey(): string {
  return localStorage.getItem(mobileRecoveryKeyKey) ?? "";
}

export function pairingServiceUrl(): string {
  const configured = (import.meta.env.VITE_PAIRING_SERVICE_URL as string | undefined)?.trim() ?? "";
  return configured.replace(/\/+$/, "");
}

export async function requestDevicePairing(serviceUrl: string, code: string): Promise<PairingSession> {
  const normalizedService = normalizeMobileBackendUrl(serviceUrl);
  const requesterPublicKey = await createRequesterPublicKey();
  const result = await jsonFetch<{ pairingId: string; joinToken: string; expiresAt: string }>(`${normalizedService}/api/device-pairing/join`, {
    method: "POST",
    body: JSON.stringify({
      code,
      deviceName: navigator.userAgent.includes("Android") ? "Android device" : "Mobile device",
      platform: navigator.userAgent.includes("Android") ? "android" : "mobile",
      requesterPublicKey
    })
  });
  const session = { ...result, serviceUrl: normalizedService };
  savePairingSession(session);
  return session;
}

export async function pollDevicePairing(session: PairingSession): Promise<PairingPollResult> {
  return jsonFetch<PairingPollResult>(`${session.serviceUrl}/api/device-pairing/${encodeURIComponent(session.pairingId)}/poll`, {
    method: "POST",
    body: JSON.stringify({ joinToken: session.joinToken })
  });
}

export async function finishApprovedPairing(result: PairingPollResult): Promise<PairingBundle> {
  if (result.status !== "approved" || !result.approverPublicKey || !result.encryptedBundle) throw new Error("配对尚未批准");
  const bundle = await decryptPairingBundle(result.approverPublicKey, result.encryptedBundle);
  applyPairingBundle(bundle);
  return bundle;
}

export async function createPairingOffer(): Promise<PairingOffer> {
  return jsonFetch<PairingOffer>(resolveApiUrl("/api/device-pairing/create"), { method: "POST" });
}

export async function listPendingPairings(): Promise<PairingRequest[]> {
  const result = await jsonFetch<{ requests: PairingRequest[] }>(resolveApiUrl("/api/device-pairing/pending"));
  return result.requests;
}

async function generateDeviceCredential(): Promise<{ deviceId: string; deviceToken: string; deviceTokenHash: string }> {
  const deviceId = crypto.randomUUID();
  const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
  const deviceToken = bytesToBase64Url(tokenBytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(deviceToken)));
  const deviceTokenHash = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return { deviceId, deviceToken, deviceTokenHash };
}

export async function approvePairingRequest(request: PairingRequest, backendUrl: string, recoveryKey: string): Promise<void> {
  const credential = await generateDeviceCredential();
  const bundle: PairingBundle = {
    version: 1,
    backendUrl: normalizeMobileBackendUrl(backendUrl),
    recoveryKey,
    deviceId: credential.deviceId,
    deviceToken: credential.deviceToken,
    issuedAt: new Date().toISOString()
  };
  const encrypted = await encryptPairingBundle(request.requesterPublicKey, bundle);
  await jsonFetch(resolveApiUrl(`/api/device-pairing/${encodeURIComponent(request.pairingId)}/approve`), {
    method: "POST",
    body: JSON.stringify({
      deviceId: credential.deviceId,
      deviceTokenHash: credential.deviceTokenHash,
      approverPublicKey: encrypted.approverPublicKey,
      encryptedBundle: encrypted.encryptedBundle
    })
  });
}

export async function rejectPairingRequest(pairingId: string): Promise<void> {
  await jsonFetch(resolveApiUrl(`/api/device-pairing/${encodeURIComponent(pairingId)}/reject`), { method: "POST" });
}
