export type ProviderErrorKind = "reauth_required" | "permission" | "cursor_invalid" | "rate_limited" | "transient" | "permanent";

export type ClassifiedProviderError = {
  kind: ProviderErrorKind;
  retryable: boolean;
  retryAfterMs: number | null;
  message: string;
};

export class DeferredJobError extends Error {
  constructor(message: string, readonly retryAt: Date) {
    super(message);
    this.name = "DeferredJobError";
  }
}

export function classifyProviderError(error: unknown): ClassifiedProviderError {
  const value = error as { code?: string; status?: number; statusCode?: number; responseStatus?: string; response?: { status?: number; headers?: Record<string, string> } };
  const message = error instanceof Error ? error.message : String(error);
  const normalized = `${value.code ?? ""} ${value.responseStatus ?? ""} ${message}`.toLowerCase();
  const status = value.status ?? value.statusCode ?? value.response?.status;
  const retryAfter = value.response?.headers?.["retry-after"];
  const retryAfterMs = retryAfter && Number.isFinite(Number(retryAfter)) ? Number(retryAfter) * 1000 : null;

  if (status === 401 || /authentication|invalid credentials|login failed|authentica/.test(normalized)) {
    return { kind: "reauth_required", retryable: false, retryAfterMs: null, message };
  }
  if (status === 403 || /permission denied|not permitted|insufficient scope/.test(normalized)) {
    return { kind: "permission", retryable: false, retryAfterMs: null, message };
  }
  if (/uidvalidity_changed|historyid|delta.*invalid|cursor.*invalid/.test(normalized)) {
    return { kind: "cursor_invalid", retryable: true, retryAfterMs: null, message };
  }
  if (/provider limiter is closed|同步服务正在关闭|service.*closing|operation was aborted|aborterror/.test(normalized)) {
    return { kind: "transient", retryable: true, retryAfterMs: 1000, message };
  }
  if (status === 429 || /rate.?limit|too many requests|over quota/.test(normalized)) {
    return { kind: "rate_limited", retryable: true, retryAfterMs, message };
  }
  if (status === 408 || (status !== undefined && status >= 500) || /timeout|timed out|econnreset|econnrefused|enetunreach|socket|network/.test(normalized)) {
    return { kind: "transient", retryable: true, retryAfterMs: null, message };
  }
  return { kind: "permanent", retryable: false, retryAfterMs: null, message };
}

export function retryDelayMs(attempt: number, retryAfterMs: number | null = null, random = Math.random): number {
  if (retryAfterMs !== null) return Math.max(1000, retryAfterMs);
  const exponential = Math.min(15 * 60_000, 1000 * 2 ** Math.max(0, attempt - 1));
  return Math.round(exponential * (0.75 + random() * 0.5));
}
