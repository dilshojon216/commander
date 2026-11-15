import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { apiFetch } from "./auth-client";

/** WebAuthn brauzer oqimlari (server bilan `challengeId` orqali bog'lanadi). */

export interface FlowResult {
  ok: boolean;
  error?: string;
  retryAfterMs?: number;
  elevatedUntil?: number;
}

async function post(url: string, body: unknown, withCsrf: boolean): Promise<{ status: number; json: Record<string, unknown> }> {
  const init: RequestInit = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) };
  const res = withCsrf ? await apiFetch(url, init) : await fetch(url, { ...init, credentials: "same-origin", cache: "no-store" });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    json = {};
  }
  return { status: res.status, json };
}

function fromError(status: number, json: Record<string, unknown>): FlowResult {
  return { ok: false, error: typeof json.error === "string" ? json.error : `http_${status}`, retryAfterMs: typeof json.retryAfterMs === "number" ? json.retryAfterMs : undefined };
}

function isCancel(e: unknown): boolean {
  return e instanceof Error && (e.name === "NotAllowedError" || e.name === "AbortError");
}

export async function passkeyLoginFlow(): Promise<FlowResult> {
  const o = await post("/api/auth/passkey/login/options", {}, false);
  if (o.status !== 200) return fromError(o.status, o.json);
  let response;
  try {
    response = await startAuthentication({ optionsJSON: o.json.options as Parameters<typeof startAuthentication>[0]["optionsJSON"] });
  } catch (e) {
    return { ok: false, error: isCancel(e) ? "cancelled" : "assertion_failed" };
  }
  const v = await post("/api/auth/passkey/login/verify", { challengeId: o.json.challengeId, response }, false);
  return v.status === 200 ? { ok: true } : fromError(v.status, v.json);
}

export async function passkeyRegisterFlow(setupCode: string, name: string): Promise<FlowResult> {
  const o = await post("/api/auth/passkey/register/options", { setupCode }, false);
  if (o.status !== 200) return fromError(o.status, o.json);
  let response;
  try {
    response = await startRegistration({ optionsJSON: o.json.options as Parameters<typeof startRegistration>[0]["optionsJSON"] });
  } catch (e) {
    return { ok: false, error: isCancel(e) ? "cancelled" : "registration_failed" };
  }
  const v = await post("/api/auth/passkey/register/verify", { setupCode, challengeId: o.json.challengeId, response, name }, false);
  return v.status === 200 ? { ok: true } : fromError(v.status, v.json);
}

export async function passkeyElevateFlow(): Promise<FlowResult> {
  const o = await post("/api/auth/elevate/passkey/options", {}, true);
  if (o.status !== 200) return fromError(o.status, o.json);
  let response;
  try {
    response = await startAuthentication({ optionsJSON: o.json.options as Parameters<typeof startAuthentication>[0]["optionsJSON"] });
  } catch (e) {
    return { ok: false, error: isCancel(e) ? "cancelled" : "assertion_failed" };
  }
  const v = await post("/api/auth/elevate/passkey/verify", { challengeId: o.json.challengeId, response }, true);
  return v.status === 200 ? { ok: true, elevatedUntil: Number(v.json.elevatedUntil) } : fromError(v.status, v.json);
}

export async function passwordLoginFlow(password: string): Promise<FlowResult> {
  const r = await post("/api/auth/login/password", { password }, false);
  return r.status === 200 ? { ok: true } : fromError(r.status, r.json);
}

export async function passwordElevateFlow(password: string): Promise<FlowResult> {
  const r = await post("/api/auth/elevate/password", { password }, true);
  return r.status === 200 ? { ok: true, elevatedUntil: Number(r.json.elevatedUntil) } : fromError(r.status, r.json);
}

export async function appElevateFlow(token: string): Promise<FlowResult> {
  const r = await post("/api/auth/elevate/app", { token }, true);
  return r.status === 200 ? { ok: true, elevatedUntil: Number(r.json.elevatedUntil) } : fromError(r.status, r.json);
}
