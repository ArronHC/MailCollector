import type { CloudConfigEnvelope } from "./api";

const additionalData = new TextEncoder().encode("mail-collector-config-v1");

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function hexToBytes(value: string): Uint8Array {
  const normalized = value.trim();
  if (!/^[a-fA-F0-9]{64}$/.test(normalized)) throw new Error("同步密钥必须是 64 位十六进制字符");
  return Uint8Array.from(normalized.match(/.{2}/g)!, (byte) => Number.parseInt(byte, 16));
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function importKey(value: string, usage: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", arrayBuffer(hexToBytes(value)), { name: "AES-GCM" }, false, usage);
}

export async function encryptConfig(value: unknown, keyValue: string): Promise<CloudConfigEnvelope> {
  const key = await importKey(keyValue, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv: arrayBuffer(iv), additionalData: arrayBuffer(additionalData), tagLength: 128 }, key, arrayBuffer(plaintext));
  return { version: "1", iv: bytesToBase64Url(iv), ciphertext: bytesToBase64Url(new Uint8Array(encrypted)) };
}

export async function decryptConfig<T>(envelope: CloudConfigEnvelope, keyValue: string): Promise<T> {
  if (envelope.version !== "1") throw new Error("不支持的云配置加密版本");
  try {
    const key = await importKey(keyValue, ["decrypt"]);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: arrayBuffer(base64UrlToBytes(envelope.iv)), additionalData: arrayBuffer(additionalData), tagLength: 128 }, key, arrayBuffer(base64UrlToBytes(envelope.ciphertext)));
    return JSON.parse(new TextDecoder().decode(plaintext)) as T;
  } catch {
    throw new Error("同步密钥不正确，或云端配置已损坏");
  }
}

export function generateConfigKey(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
