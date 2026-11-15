import { readSessionCookie } from "./cookie";
import { CSRF_HEADER, getAuthSettings } from "./settings";
import type { AuthSettings } from "./settings";
import { csrfMatches, isElevated, lookupSession } from "./sessions";
import type { SessionView } from "./sessions";

export type DenyReason = "unauthenticated" | "csrf" | "reauth_required";

export type GuardResult = { ok: true; session: SessionView } | { ok: false; status: 401 | 403; error: DenyReason; message: string };

const MESSAGES: Record<DenyReason, string> = {
  unauthenticated: "Kirish talab qilinadi",
  csrf: "CSRF tokeni noto'g'ri yoki yo'q",
  reauth_required: "Xavfli amal: Touch ID yoki parol bilan qayta tasdiqlang",
};

function deny(error: DenyReason): GuardResult {
  return { ok: false, status: error === "csrf" ? 403 : 401, error, message: MESSAGES[error] };
}

export interface GuardOptions {
  /** O'zgartiruvchi so'rov: CSRF sarlavhasi shart. */
  mutating?: boolean;
  /** Yaqinda yangi tasdiq (elevation) shart. */
  elevation?: boolean;
  /** Foydalanuvchi faoliyati sifatida idle taymerini yangilash. */
  touch?: boolean;
}

/** Sof qaror (testlanadi): sessiya topilganmi, CSRF mosmi, ko'tarilganmi. Tartib: auth -> csrf -> elevation. */
export function decide(session: SessionView | null, csrfHeader: string | null, opts: GuardOptions, now: number): GuardResult {
  if (!session) return deny("unauthenticated");
  if (opts.mutating && !csrfMatches(session, csrfHeader)) return deny("csrf");
  if (opts.elevation && !isElevated(session, now)) return deny("reauth_required");
  return { ok: true, session };
}

/** Request'dan sessiyani o'qib `decide` ni chaqiradi. Barcha himoyalangan route handler'lar SHUNI ishlatadi. */
export function authorize(request: Request, opts: GuardOptions = {}, now = Date.now(), settings: AuthSettings = getAuthSettings()): GuardResult {
  const sid = readSessionCookie(request.headers.get("cookie"));
  const found = lookupSession(sid, now, settings, { touch: opts.touch ?? !!opts.mutating });
  return decide(found.ok ? found.session : null, request.headers.get(CSRF_HEADER), opts, now);
}

export function denyResponse(r: Extract<GuardResult, { ok: false }>): Response {
  return Response.json({ error: r.error, message: r.message }, { status: r.status, headers: { "Cache-Control": "no-store" } });
}
