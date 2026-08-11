export type BackendSettings = {
  mode: "local" | "remote";
  serverUrl: string;
};

export const defaultBackend: BackendSettings = { mode: "local", serverUrl: "" };

export function normalizeBackendSettings(input: BackendSettings): BackendSettings {
  if (input.mode === "local") return defaultBackend;
  const raw = input.serverUrl.trim();
  if (!raw) throw new Error("请输入服务器地址");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("服务器地址格式不正确");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("服务器地址必须使用 HTTP 或 HTTPS");
  const localHost = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !localHost) throw new Error("非本机服务器必须使用 HTTPS");
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("服务器地址只能包含协议、域名和端口");
  }
  return { mode: "remote", serverUrl: url.origin };
}
