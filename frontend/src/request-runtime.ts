const active = new Set<AbortController>();

export function cancelApiRequests(): void {
  for (const controller of active) controller.abort();
}

/** Deadline includes response body consumption, not just response headers. */
export async function timedFetch(input: string, options: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  active.add(controller);
  const timer = window.setTimeout(() => controller.abort(new DOMException("请求超时（30 秒），请重试", "TimeoutError")), 30_000);
  try {
    const response = await fetch(input, { ...options, signal: controller.signal });
    const body = await response.arrayBuffer();
    return new Response([204, 205, 304].includes(response.status) ? null : body, { status: response.status, statusText: response.statusText, headers: response.headers });
  } finally {
    window.clearTimeout(timer);
    active.delete(controller);
    options.signal?.removeEventListener("abort", abort);
  }
}

export function isRequestAborted(error: unknown): boolean {
  return error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError");
}
