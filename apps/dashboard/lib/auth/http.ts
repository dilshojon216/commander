import { clearSessionCookie, sessionSetCookie } from "./cookie";
import { authorize, denyResponse } from "./guard";
import type { GuardOptions } from "./guard";
import { isSameOrigin } from "../proxy-rules";
import { getAuthSettings } from "./settings";
import type { Failure, LoginOk } from "./service";
import type { SessionView } from "./sessions";

/** Auth route handler'lari uchun umumiy yordamchilar (sof HTTP qatlami; mantiq `service.ts` da). */

const NO_STORE = { "Cache-Control": "no-store" };
export const MAX_AUTH_BODY = 64 * 1024;

export function json(body: unknown, status = 200, extra: Record<string, string> = {}, cookies: string[] = []): Response {
  const h = new Headers({ ...NO_STORE, ...extra });
  for (const c of cookies) h.append("Set-Cookie", c);
  return Response.json(body, { status, headers: h });
}

export function failure(f: Failure): Response {
  const extra: Record<string, string> = f.retryAfterMs ? { "Retry-After": String(Math.ceil(f.retryAfterMs / 1000)) } : {};
  return json({ error: f.error, retryAfterMs: f.retryAfterMs }, f.status, extra);
}

export function loginSuccess(r: LoginOk): Response {
  const s = getAuthSettings();
  const maxAge = Math.floor(s.absoluteMs / 1000);
  return json({ ok: true, csrf: r.session.csrf, elevatedUntil: r.session.elevatedUntil, expiresAt: r.session.expiresAt }, 200, {}, [sessionSetCookie(r.sid, maxAge)]);
}

export function logoutResponse(): Response {
  return json({ ok: true }, 200, {}, [clearSessionCookie()]);
}

/** Brauzer POST'lari uchun: `Origin` bo'lishi va `Host` bilan mos kelishi shart. */
export function originGuard(request: Request): Response | null {
  if (isSameOrigin(request.headers.get("origin"), request.headers.get("host"))) return null;
  return json({ error: "forbidden", message: "Origin mos emas" }, 403);
}

/** `Origin` yuborilgan bo'lsa mos kelishi shart; yo'q bo'lsa (ilova/URLSession) o'tadi. Ilova siri bilan chaqiriladigan yo'llar uchun. */
export function originGuardOptional(request: Request): Response | null {
  return request.headers.get("origin") === null ? null : originGuard(request);
}

export async function readBody(request: Request): Promise<Record<string, unknown> | Response> {
  const text = await request.text();
  if (text.length > MAX_AUTH_BODY) return json({ error: "invalid_request", message: "Tana juda katta" }, 413);
  if (text === "") return {};
  try {
    const v: unknown = JSON.parse(text);
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("not object");
    return v as Record<string, unknown>;
  } catch {
    return json({ error: "invalid_request", message: "JSON noto'g'ri" }, 400);
  }
}

export function bearerSecret(request: Request): string | null {
  const h = request.headers.get("authorization");
  if (!h || !h.startsWith("Bearer ")) return null;
  return h.slice(7).trim() || null;
}

/** Sessiyali route'lar: origin + sessiya + CSRF (mutating). Muvaffaqiyatda sessiya, aks holda tayyor javob. */
export function sessionGuard(request: Request, opts: GuardOptions = { mutating: true, touch: true }): { session: SessionView } | { response: Response } {
  if (opts.mutating) {
    const bad = originGuard(request);
    if (bad) return { response: bad };
  }
  const g = authorize(request, opts);
  if (!g.ok) return { response: denyResponse(g) };
  return { session: g.session };
}
