import { randomBytes } from "node:crypto";
import type { AuthenticationResponseJSON, PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { audit } from "./audit";
import { putChallenge, takeChallenge } from "./challenges";
import { randomToken, safeEqual, sha256Hex } from "./crypto";
import { verifyPassword } from "./password";
import { limiterFor, PASSWORD_LIMIT, SECRET_LIMIT } from "./ratelimit";
import { checkSetupCode, consumeSetupCode } from "./setup-code";
import type { SetupCheck } from "./setup-code";
import { createSession, elevateSession } from "./sessions";
import type { SessionView } from "./sessions";
import type { AuthSettings } from "./settings";
import { loadCredentials, saveCredentials } from "./store";
import { authenticationOptions, registrationOptions, verifyAuthentication, verifyRegistration } from "./webauthn";

/**
 * Kirish va qayta tasdiqlash oqimlari (HTTP'dan mustaqil; route handler'lar yupqa qobiq). Har bir muvaffaqiyatli kirish
 * yangi sessiya yaratadi (session fixation yo'q) va "ko'tarilgan" oyna oladi; har xato audit qilinadi.
 */

export type Failure = { ok: false; error: string; status: 400 | 401 | 403 | 404 | 429; retryAfterMs?: number };
export type LoginOk = { ok: true; sid: string; session: SessionView };

const fail = (error: string, status: Failure["status"] = 401, retryAfterMs?: number): Failure => ({ ok: false, error, status, retryAfterMs });

export function availableMethods(): { passkey: boolean; password: boolean; app: boolean } {
  const c = loadCredentials();
  return { passkey: c.passkeys.length > 0, password: !!c.password, app: !!c.app };
}

// ---- parol -------------------------------------------------------------------------------------------------------

/** Parolni tekshiradi (rate limit bilan). `verifyPassword` doim ishlaydi (vaqt farqi bilan "parol yo'q" sezilmasin). */
async function checkPassword(password: unknown, now: number): Promise<Failure | null> {
  const limiter = limiterFor("password", PASSWORD_LIMIT);
  const gate = limiter.check(now);
  if (!gate.allowed) {
    audit("login.locked", { method: "password" });
    return fail("rate_limited", 429, gate.retryAfterMs);
  }
  const stored = loadCredentials().password?.hash ?? "scrypt$65536$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  const ok = typeof password === "string" && password.length > 0 && password.length <= 1024 && (await verifyPassword(password, stored)) && !!loadCredentials().password;
  if (!ok) {
    limiter.fail(now);
    return fail("invalid_credentials");
  }
  limiter.success();
  return null;
}

export async function loginWithPassword(password: unknown, now: number, s: AuthSettings): Promise<LoginOk | Failure> {
  const bad = await checkPassword(password, now);
  if (bad) {
    if (bad.error !== "rate_limited") audit("login.fail", { method: "password" });
    return bad;
  }
  const { sid, session } = createSession("password", now, s);
  audit("login.ok", { method: "password" });
  return { ok: true, sid, session };
}

export async function elevateWithPassword(session: SessionView, password: unknown, now: number, s: AuthSettings): Promise<{ ok: true; elevatedUntil: number } | Failure> {
  const bad = await checkPassword(password, now);
  if (bad) {
    if (bad.error !== "rate_limited") audit("elevate.fail", { method: "password" });
    return bad;
  }
  const until = elevateSession(session.hash, now, s);
  if (until === null) return fail("unauthenticated");
  audit("elevate.ok", { method: "password" });
  return { ok: true, elevatedUntil: until };
}

// ---- passkey: ro'yxatdan o'tkazish (sozlash kodi bilan) -------------------------------------------------------------

function setupFailure(r: Exclude<SetupCheck, "ok">): Failure {
  audit("setup.code_fail", { reason: r });
  return fail(r === "invalid" ? "invalid_setup_code" : "setup_code_unavailable", r === "invalid" ? 401 : 403);
}

export async function passkeyRegisterOptions(setupCode: unknown, now: number, s: AuthSettings): Promise<{ ok: true; options: PublicKeyCredentialCreationOptionsJSON; challengeId: string } | Failure> {
  if (typeof setupCode !== "string") return fail("invalid_setup_code", 400);
  const r = checkSetupCode(setupCode, now);
  if (r !== "ok") return setupFailure(r);
  const creds = loadCredentials();
  if (!creds.userId) {
    creds.userId = randomBytes(32).toString("base64url");
    saveCredentials(creds);
  }
  const options = await registrationOptions(creds.userId, creds.passkeys, s);
  const challengeId = putChallenge({ purpose: "register", challenge: options.challenge }, now);
  return { ok: true, options, challengeId };
}

export async function passkeyRegisterVerify(input: { setupCode: unknown; challengeId: unknown; response: unknown; name?: unknown }, now: number, s: AuthSettings): Promise<LoginOk | Failure> {
  if (typeof input.setupCode !== "string" || typeof input.challengeId !== "string" || typeof input.response !== "object" || input.response === null) return fail("invalid_request", 400);
  const ch = takeChallenge(input.challengeId, "register", now);
  if (!ch) return fail("challenge_expired", 400);
  // Kod shu yerda ISTE'MOL qilinadi (bir martalik); parallel ikkinchi urinish "setup_code_unavailable" oladi.
  const r = consumeSetupCode(input.setupCode, now);
  if (r !== "ok") return setupFailure(r);
  let rec: Awaited<ReturnType<typeof verifyRegistration>>;
  try {
    rec = await verifyRegistration(input.response as RegistrationResponseJSON, ch.challenge, s);
  } catch {
    rec = null;
  }
  if (!rec) return fail("registration_failed", 400);
  const creds = loadCredentials();
  if (creds.passkeys.some((p) => p.id === rec.id)) return fail("already_registered", 400);
  const name = typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, 40) : `Passkey ${creds.passkeys.length + 1}`;
  creds.passkeys.push({ ...rec, name, createdAt: now });
  saveCredentials(creds);
  audit("setup.register_passkey", { count: creds.passkeys.length });
  const { sid, session } = createSession("passkey", now, s);
  audit("login.ok", { method: "passkey" });
  return { ok: true, sid, session };
}

// ---- passkey: kirish / qayta tasdiqlash ----------------------------------------------------------------------------

export async function passkeyLoginOptions(now: number, s: AuthSettings): Promise<{ ok: true; options: PublicKeyCredentialRequestOptionsJSON; challengeId: string } | Failure> {
  const creds = loadCredentials();
  if (creds.passkeys.length === 0) return fail("no_passkey", 404);
  const options = await authenticationOptions(creds.passkeys, s);
  return { ok: true, options, challengeId: putChallenge({ purpose: "login", challenge: options.challenge }, now) };
}

async function verifyAssertion(purpose: "login" | "elevate", challengeId: unknown, response: unknown, now: number, s: AuthSettings, sessionHash?: string): Promise<Failure | null> {
  if (typeof challengeId !== "string" || typeof response !== "object" || response === null) return fail("invalid_request", 400);
  const ch = takeChallenge(challengeId, purpose, now, sessionHash);
  if (!ch) return fail("challenge_expired", 400);
  const assertion = response as AuthenticationResponseJSON;
  const creds = loadCredentials();
  const pk = creds.passkeys.find((p) => typeof assertion.id === "string" && p.id === assertion.id);
  if (!pk) return fail("unknown_credential");
  const v = await verifyAuthentication(assertion, ch.challenge, pk, s);
  if (!v) return fail("assertion_failed");
  pk.counter = v.newCounter;
  saveCredentials(creds);
  return null;
}

export async function passkeyLogin(input: { challengeId: unknown; response: unknown }, now: number, s: AuthSettings): Promise<LoginOk | Failure> {
  const bad = await verifyAssertion("login", input.challengeId, input.response, now, s);
  if (bad) {
    audit("login.fail", { method: "passkey" });
    return bad;
  }
  const { sid, session } = createSession("passkey", now, s);
  audit("login.ok", { method: "passkey" });
  return { ok: true, sid, session };
}

export async function passkeyElevateOptions(session: SessionView, now: number, s: AuthSettings): Promise<{ ok: true; options: PublicKeyCredentialRequestOptionsJSON; challengeId: string } | Failure> {
  const creds = loadCredentials();
  if (creds.passkeys.length === 0) return fail("no_passkey", 404);
  const options = await authenticationOptions(creds.passkeys, s);
  return { ok: true, options, challengeId: putChallenge({ purpose: "elevate", challenge: options.challenge, sessionHash: session.hash }, now) };
}

export async function passkeyElevate(session: SessionView, input: { challengeId: unknown; response: unknown }, now: number, s: AuthSettings): Promise<{ ok: true; elevatedUntil: number } | Failure> {
  const bad = await verifyAssertion("elevate", input.challengeId, input.response, now, s, session.hash);
  if (bad) {
    audit("elevate.fail", { method: "passkey" });
    return bad;
  }
  const until = elevateSession(session.hash, now, s);
  if (until === null) return fail("unauthenticated");
  audit("elevate.ok", { method: "passkey" });
  return { ok: true, elevatedUntil: until };
}

// ---- Mac ilova yo'li (ilova siri Keychain'da) -------------------------------------------------------------------------

export function appPair(setupCode: unknown, deviceName: unknown, now: number): { ok: true; secret: string } | Failure {
  if (typeof setupCode !== "string") return fail("invalid_setup_code", 400);
  const r = consumeSetupCode(setupCode, now);
  if (r !== "ok") return setupFailure(r);
  const secret = randomToken(32);
  const creds = loadCredentials();
  creds.app = { secretHash: sha256Hex(secret), pairedAt: now, name: typeof deviceName === "string" && deviceName.trim() ? deviceName.trim().slice(0, 60) : "Mac ilova" };
  saveCredentials(creds);
  audit("setup.pair_app");
  return { ok: true, secret };
}

function checkAppSecret(secret: string | null, now: number): Failure | null {
  const limiter = limiterFor("app-secret", SECRET_LIMIT);
  const gate = limiter.check(now);
  if (!gate.allowed) return fail("rate_limited", 429, gate.retryAfterMs);
  const app = loadCredentials().app;
  // Doim xesh hisoblanadi (vaqt farqi yo'q)
  const given = sha256Hex(secret ?? "");
  const ok = !!secret && secret.length <= 256 && !!app && safeEqual(given, app.secretHash);
  if (!ok) {
    limiter.fail(now);
    return fail("invalid_app_secret");
  }
  limiter.success();
  return null;
}

export function appLogin(secret: string | null, now: number, s: AuthSettings): LoginOk | Failure {
  const bad = checkAppSecret(secret, now);
  if (bad) {
    audit("login.fail", { method: "app" });
    return bad;
  }
  const { sid, session } = createSession("app", now, s);
  audit("login.ok", { method: "app" });
  return { ok: true, sid, session };
}

/** Ilova Touch ID'dan keyin siri bilan 30 soniyalik bir martalik token oladi; token sahifaga beriladi va `elevate/app` da ishlatiladi. */
export function appElevationToken(secret: string | null, now: number): { ok: true; token: string } | Failure {
  const bad = checkAppSecret(secret, now);
  if (bad) return bad;
  return { ok: true, token: putChallenge({ purpose: "app-elevate", challenge: "" }, now, 30_000) };
}

export function appElevate(session: SessionView, token: unknown, now: number, s: AuthSettings): { ok: true; elevatedUntil: number } | Failure {
  // Token sessiyaga bog'lanmagan (ilova sahifa sessiyasini bilmaydi), lekin bir martalik va 30 s; sahifa uni darhol ishlatadi.
  const ch = typeof token === "string" ? takeChallenge(token, "app-elevate", now) : null;
  if (!ch) {
    audit("elevate.fail", { method: "app" });
    return fail("invalid_token");
  }
  const until = elevateSession(session.hash, now, s);
  if (until === null) return fail("unauthenticated");
  audit("elevate.ok", { method: "app" });
  return { ok: true, elevatedUntil: until };
}
