function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

export function allowedRemoteOrigin(origin: string | undefined, enabled: boolean, configuredOrigins: string[]): boolean {
  if (!enabled || !origin) return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return false;
  if (parsed.protocol !== "https:" && !isLoopback(parsed.hostname)) return false;
  const configured = new Set(configuredOrigins.map((value) => {
    try {
      const configured = new URL(value);
      if (configured.protocol !== "https:" && !isLoopback(configured.hostname)) return "";
      return configured.origin;
    } catch { return ""; }
  }).filter(Boolean));
  return configured.has(parsed.origin) || isLoopback(parsed.hostname);
}
