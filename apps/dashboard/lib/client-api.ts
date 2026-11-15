import type { z } from "zod";
import { apiFetch } from "./auth-client";

/** Brauzer -> dashboard proksi (`/api/c/...`). Javob Zod bilan tekshiriladi. Token yo'q. */

export class ApiCallError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    message: string,
  ) {
    super(message);
  }
}

export async function getJson<S extends z.ZodType>(path: string, schema: S, signal?: AbortSignal): Promise<z.infer<S>> {
  const res = await apiFetch(`/api/c${path}`, { signal });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const msg = typeof body === "object" && body !== null && "message" in body ? String((body as { message: unknown }).message) : `Server ${res.status}`;
    throw new ApiCallError(res.status, body, msg);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ApiCallError(res.status, body, "Server javobi kutilgan formatda emas");
  return parsed.data;
}

export async function postJson<S extends z.ZodType>(path: string, payload: unknown, schema: S, headers?: Record<string, string>): Promise<z.infer<S>> {
  const res = await apiFetch(`/api/c${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) throw new ApiCallError(res.status, body, `Server ${res.status}`);
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ApiCallError(res.status, body, "Server javobi kutilgan formatda emas");
  return parsed.data;
}

export async function patchJson<S extends z.ZodType>(path: string, payload: unknown, schema: S): Promise<z.infer<S>> {
  const res = await apiFetch(`/api/c${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) throw new ApiCallError(res.status, body, `Server ${res.status}`);
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ApiCallError(res.status, body, "Server javobi kutilgan formatda emas");
  return parsed.data;
}

/** Javob sxemasiz yozuv (PUT/PATCH/DELETE/POST): natija keyin qayta o'qiladi. Xato `ApiCallError`. */
export async function requestJson(method: "POST" | "PUT" | "PATCH" | "DELETE", path: string, payload?: unknown): Promise<unknown> {
  const res = await apiFetch(`/api/c${path}`, {
    method,
    headers: payload === undefined ? undefined : { "Content-Type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) throw new ApiCallError(res.status, body, `Server ${res.status}`);
  return body;
}
