const API = "/api";

const UI_TOKEN_KEY = "mcpHubUiToken";

function getAuthHeaders(): Record<string, string> {
  const token =
    localStorage.getItem(UI_TOKEN_KEY) ||
    new URLSearchParams(location.search).get("token");
  if (token) {
    localStorage.setItem(UI_TOKEN_KEY, token);
    return { Authorization: "Bearer " + token };
  }
  return {};
}

export function getStoredUiToken(): string | null {
  return localStorage.getItem(UI_TOKEN_KEY);
}

export function setStoredUiToken(token: string): void {
  localStorage.setItem(UI_TOKEN_KEY, token);
}

export function clearStoredUiToken(): void {
  localStorage.removeItem(UI_TOKEN_KEY);
}

export async function api<T = unknown>(
  path: string,
  opts: RequestInit = {}
): Promise<T> {
  const headers = {
    "Content-Type": "application/json",
    ...getAuthHeaders(),
    ...(opts.headers as Record<string, string>),
  };
  const res = await fetch(API + path, { ...opts, headers, credentials: "include" });
  const data = res.ok
    ? await res.json().catch(() => ({}))
    : await res.json().catch(() => ({ error: res.statusText }));
  if (res.status === 401) {
    const err = new Error("مطلوب توكن أو كلمة مرور") as Error & { status?: number };
    err.status = 401;
    throw err;
  }
  if (!res.ok) throw new Error(data.error || data.message || "خطأ في الطلب");
  return data as T;
}

export interface ToolInfo {
  name: string;
  description?: string;
}

export interface ServerInfo {
  name: string;
  status: string;
  transportType?: string;
  capabilities?: {
    tools?: ToolInfo[];
    resources?: unknown[];
    prompts?: unknown[];
  };
}

export interface HealthResponse {
  state: string;
  servers?: ServerInfo[];
}

export interface ConfigResponse {
  config: { mcpServers?: Record<string, ServerConfig> };
  configPath?: string;
  canEdit: boolean;
}

export interface ServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  type?: string;
  disabled?: boolean;
}
