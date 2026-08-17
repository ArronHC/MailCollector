import { useSyncExternalStore } from "react";

export type ReaderPosition = "right" | "bottom";
export type MailListDensity = "compact" | "comfortable" | "spacious";
export type RemoteImagePolicy = "block" | "trusted" | "always";
export type ReadingFontSize = "small" | "medium" | "large";

export interface AppSettings {
  version: 1;
  readerPosition: ReaderPosition;
  listDensity: MailListDensity;
  showSnippets: boolean;
  showSourceBadges: boolean;
  readingFontSize: ReadingFontSize;
  remoteImagePolicy: RemoteImagePolicy;
  trustedRemoteImageSenders: string[];
  keyboardShortcutsEnabled: boolean;
  markReadOnOpen: boolean;
}

const STORAGE_KEY = "mailCollectorSettings:v1";

export const defaultAppSettings: AppSettings = {
  version: 1,
  readerPosition: "right",
  listDensity: "comfortable",
  showSnippets: true,
  showSourceBadges: true,
  readingFontSize: "medium",
  remoteImagePolicy: "block",
  trustedRemoteImageSenders: [],
  keyboardShortcutsEnabled: true,
  markReadOnOpen: true
};

const readerPositions = new Set<ReaderPosition>(["right", "bottom"]);
const densities = new Set<MailListDensity>(["compact", "comfortable", "spacious"]);
const remoteImagePolicies = new Set<RemoteImagePolicy>(["block", "trusted", "always"]);
const fontSizes = new Set<ReadingFontSize>(["small", "medium", "large"]);

function normalizeSender(value: string): string { return value.trim().toLowerCase(); }

function normalizeSettings(value: unknown): AppSettings {
  if (!value || typeof value !== "object") return { ...defaultAppSettings };
  const candidate = value as Partial<AppSettings>;
  const trustedRemoteImageSenders = Array.isArray(candidate.trustedRemoteImageSenders)
    ? Array.from(new Set(candidate.trustedRemoteImageSenders.filter((item): item is string => typeof item === "string").map(normalizeSender).filter(Boolean))).slice(0, 500)
    : [];
  return {
    version: 1,
    readerPosition: readerPositions.has(candidate.readerPosition as ReaderPosition) ? candidate.readerPosition as ReaderPosition : defaultAppSettings.readerPosition,
    listDensity: densities.has(candidate.listDensity as MailListDensity) ? candidate.listDensity as MailListDensity : defaultAppSettings.listDensity,
    showSnippets: typeof candidate.showSnippets === "boolean" ? candidate.showSnippets : defaultAppSettings.showSnippets,
    showSourceBadges: typeof candidate.showSourceBadges === "boolean" ? candidate.showSourceBadges : defaultAppSettings.showSourceBadges,
    readingFontSize: fontSizes.has(candidate.readingFontSize as ReadingFontSize) ? candidate.readingFontSize as ReadingFontSize : defaultAppSettings.readingFontSize,
    remoteImagePolicy: remoteImagePolicies.has(candidate.remoteImagePolicy as RemoteImagePolicy) ? candidate.remoteImagePolicy as RemoteImagePolicy : defaultAppSettings.remoteImagePolicy,
    trustedRemoteImageSenders,
    keyboardShortcutsEnabled: typeof candidate.keyboardShortcutsEnabled === "boolean" ? candidate.keyboardShortcutsEnabled : defaultAppSettings.keyboardShortcutsEnabled,
    markReadOnOpen: typeof candidate.markReadOnOpen === "boolean" ? candidate.markReadOnOpen : defaultAppSettings.markReadOnOpen
  };
}

function loadSettings(): AppSettings {
  if (typeof window === "undefined") return { ...defaultAppSettings };
  try { const stored = window.localStorage.getItem(STORAGE_KEY); return stored ? normalizeSettings(JSON.parse(stored)) : { ...defaultAppSettings }; }
  catch { return { ...defaultAppSettings }; }
}

let currentSettings = loadSettings();
const listeners = new Set<() => void>();

function applyToDocument(settings: AppSettings): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.readerPosition = settings.readerPosition;
  root.dataset.mailDensity = settings.listDensity;
  root.dataset.showSnippets = String(settings.showSnippets);
  root.dataset.showSourceBadges = String(settings.showSourceBadges);
  root.dataset.readingFontSize = settings.readingFontSize;
}

function emit(): void { applyToDocument(currentSettings); for (const listener of listeners) listener(); }
export function getAppSettings(): AppSettings { return currentSettings; }

export function updateAppSettings(patch: Partial<Omit<AppSettings, "version">>): AppSettings {
  currentSettings = normalizeSettings({ ...currentSettings, ...patch, version: 1 });
  if (typeof window !== "undefined") { try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(currentSettings)); } catch {} }
  emit();
  return currentSettings;
}

export function resetAppSettings(): AppSettings {
  currentSettings = { ...defaultAppSettings, trustedRemoteImageSenders: [] };
  if (typeof window !== "undefined") { try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(currentSettings)); } catch {} }
  emit();
  return currentSettings;
}

export function trustRemoteImageSender(address: string): void {
  const sender = normalizeSender(address);
  if (!sender) return;
  const trusted = currentSettings.trustedRemoteImageSenders.includes(sender) ? currentSettings.trustedRemoteImageSenders : [...currentSettings.trustedRemoteImageSenders, sender];
  updateAppSettings({ trustedRemoteImageSenders: trusted, remoteImagePolicy: currentSettings.remoteImagePolicy === "block" ? "trusted" : currentSettings.remoteImagePolicy });
}

export function untrustRemoteImageSender(address: string): void {
  const sender = normalizeSender(address);
  updateAppSettings({ trustedRemoteImageSenders: currentSettings.trustedRemoteImageSenders.filter((item) => item !== sender) });
}

function subscribe(listener: () => void): () => void { listeners.add(listener); return () => listeners.delete(listener); }
export function useAppSettings(): AppSettings { return useSyncExternalStore(subscribe, getAppSettings, getAppSettings); }

export function initializeAppSettings(): void {
  applyToDocument(currentSettings);
  if (typeof window === "undefined") return;
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY) return;
    try { currentSettings = event.newValue ? normalizeSettings(JSON.parse(event.newValue)) : { ...defaultAppSettings }; }
    catch { currentSettings = { ...defaultAppSettings }; }
    emit();
  });
}
