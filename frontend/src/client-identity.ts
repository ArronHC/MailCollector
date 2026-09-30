import { getMobileBackendUrl } from "./mobile-backend";

let identity = "";

// Use existing auth identity/credentials, never credential plaintext in storage keys.
export async function setClientIdentity(value: string): Promise<void> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  identity = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function clearClientIdentity(): void { identity = ""; }

export function clientStorageScope(): string {
  const backend = getMobileBackendUrl() || window.location.origin;
  return JSON.stringify([backend, identity]);
}

export function hasClientIdentity(): boolean { return Boolean(identity); }
