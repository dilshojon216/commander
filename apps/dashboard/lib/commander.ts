import "server-only";
import type { z } from "zod";
import { getConfig } from "./config";

/**
 * Commander center'ga server tomondan so'rov. Tokenlar FAQAT shu yerda (va bridge'da) ishlatiladi;
 * brauzerga hech qachon chiqmaydi, xato matnlariga ham kirmaydi.
 */

export type TokenScope = "read" | "approve" | "control";

export interface RawResult {
  status: number;
  json: unknown;
}

const TIMEOUT_MS = 5000;

export class ConfigError extends Error {}

export async function commanderRequest(
  path: string,
  opts: { method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE"; body?: unknown; scope?: TokenScope; headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<RawResult> {
  const cfg = getConfig();
  const token = opts.scope === "approve" ? cfg.approveToken : opts.scope === "control" ? cfg.controlToken : cfg.apiToken;
  if (!token) {
    throw new ConfigError(
      opts.scope === "approve" ? "COMMANDER_APPROVE_TOKEN sozlanmagan" : opts.scope === "control" ? "COMMANDER_CONTROL_TOKEN sozlanmagan" : "COMMANDER_API_TOKEN sozlanmagan",
    );
  }
  const headers: Record<string, string> = { Accept: "application/json", Authorization: `Bearer ${token}` };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.headers) Object.assign(headers, opts.headers);
  const res = await fetch(`${cfg.apiUrl}/v1${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    cache: "no-store",
    signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

export function describeError(e: unknown): string {
  if (e instanceof ConfigError) return e.message;
  if (e instanceof Error) {
    if (e.name === "TimeoutError") return "Server javob bermadi (timeout)";
    if (e.message.startsWith("Server ") || e.message.startsWith("Token")) return e.message;
  }
  return "Serverga ulanib bo'lmadi";
}

export interface ApiResult<T> {
  data: T | null;
  /** Center ishlamasa xabar (token hech qachon xabarga kirmaydi). */
  error: string | null;
}

/** Zod bilan tekshirilgan GET (server komponentlar uchun). Xato = `{data:null,error}`. */
export async function getParsed<S extends z.ZodType>(path: string, schema: S): Promise<ApiResult<z.infer<S>>> {
  try {
    const r = await commanderRequest(path);
    if (r.status === 401 || r.status === 403) return { data: null, error: "Token rad etildi (401/403)" };
    if (r.status < 200 || r.status >= 300) return { data: null, error: `Server ${r.status} qaytardi` };
    const parsed = schema.safeParse(r.json);
    if (!parsed.success) return { data: null, error: "Server javobi kutilgan formatda emas" };
    return { data: parsed.data, error: null };
  } catch (e) {
    return { data: null, error: describeError(e) };
  }
}
