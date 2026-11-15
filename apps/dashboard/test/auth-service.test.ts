import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { appElevate, appElevationToken, appLogin, appPair, availableMethods, elevateWithPassword, loginWithPassword, passkeyElevate, passkeyElevateOptions, passkeyLogin, passkeyLoginOptions, passkeyRegisterOptions, passkeyRegisterVerify } from "@/lib/auth/service";
import type { LoginOk } from "@/lib/auth/service";
import { isElevated, lookupSession } from "@/lib/auth/sessions";
import { MINUTE } from "@/lib/auth/settings";
import { limiterFor, PASSWORD_LIMIT } from "@/lib/auth/ratelimit";
import { loadCredentials, loadSetup } from "@/lib/auth/store";
import { setPassword } from "../scripts/auth-cli.mjs";
import { plantSetupCode, SoftAuthenticator, settings, tempAuthDir } from "./auth-fixtures";

const tmp = tempAuthDir();
const S = settings();
const NOW = 1_800_000_000_000;
const CODE = "ABCD-EFGH";

beforeEach(() => {
  tmp.reset();
  (globalThis as { __commanderLimiters?: unknown }).__commanderLimiters = undefined;
});
afterAll(() => tmp.cleanup());

function must<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(`kutilgan muvaffaqiyat, keldi: ${JSON.stringify(r)}`);
  return r as Extract<T, { ok: true }>;
}

async function registerPasskey(auth: SoftAuthenticator, now = NOW): Promise<LoginOk> {
  plantSetupCode(CODE, now);
  const o = must(await passkeyRegisterOptions(CODE, now, S));
  return must(await passkeyRegisterVerify({ setupCode: CODE, challengeId: o.challengeId, response: auth.register(o.options.challenge) }, now, S));
}

describe("passkey ro'yxatdan o'tkazish (dasturiy autentifikator)", () => {
  it("sozlash kodisiz ro'yxatdan o'tib bo'lmaydi (lokal jarayon jimgina qo'sha olmaydi)", async () => {
    const r = await passkeyRegisterOptions(CODE, NOW, S);
    expect(r).toMatchObject({ ok: false, error: "setup_code_unavailable" });
    expect(loadCredentials().passkeys).toHaveLength(0);
  });
  it("noto'g'ri kod rad etiladi", async () => {
    plantSetupCode(CODE, NOW);
    expect(await passkeyRegisterOptions("WXYZ-2345", NOW, S)).toMatchObject({ ok: false, error: "invalid_setup_code", status: 401 });
  });
  it("to'g'ri kod: passkey saqlanadi, sessiya ochiladi, kod ISTE'MOL qilinadi", async () => {
    const auth = new SoftAuthenticator();
    const login = await registerPasskey(auth);
    expect(login.session.method).toBe("passkey");
    expect(loadCredentials().passkeys).toHaveLength(1);
    expect(loadSetup()).toBeNull();
    expect(availableMethods()).toEqual({ passkey: true, password: false, app: false });
  });
  it("bir xil kod bilan ikkinchi ro'yxatdan o'tish rad etiladi (bir martalik)", async () => {
    const a = new SoftAuthenticator();
    plantSetupCode(CODE, NOW);
    const o1 = must(await passkeyRegisterOptions(CODE, NOW, S));
    const o2 = must(await passkeyRegisterOptions(CODE, NOW, S));
    must(await passkeyRegisterVerify({ setupCode: CODE, challengeId: o1.challengeId, response: a.register(o1.options.challenge) }, NOW, S));
    const b = new SoftAuthenticator();
    const second = await passkeyRegisterVerify({ setupCode: CODE, challengeId: o2.challengeId, response: b.register(o2.options.challenge) }, NOW, S);
    expect(second).toMatchObject({ ok: false, error: "setup_code_unavailable" });
    expect(loadCredentials().passkeys).toHaveLength(1);
  });
  it("noto'g'ri origin, UV yo'q yoki boshqa challenge bilan ro'yxatdan o'tib bo'lmaydi", async () => {
    for (const mutate of ["origin", "uv", "challenge"] as const) {
      tmp.reset();
      const a = new SoftAuthenticator();
      plantSetupCode(CODE, NOW);
      const o = must(await passkeyRegisterOptions(CODE, NOW, S));
      let response;
      if (mutate === "origin") response = a.register(o.options.challenge, "http://evil.example:4318");
      else if (mutate === "uv") {
        a.userVerified = false;
        response = a.register(o.options.challenge);
      } else response = a.register("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
      const r = await passkeyRegisterVerify({ setupCode: CODE, challengeId: o.challengeId, response }, NOW, S);
      expect(r.ok, mutate).toBe(false);
      expect(loadCredentials().passkeys, mutate).toHaveLength(0);
    }
  });
  it("challenge muddati o'tgan bo'lsa rad etiladi", async () => {
    const a = new SoftAuthenticator();
    plantSetupCode(CODE, NOW);
    const o = must(await passkeyRegisterOptions(CODE, NOW, S));
    const r = await passkeyRegisterVerify({ setupCode: CODE, challengeId: o.challengeId, response: a.register(o.options.challenge) }, NOW + 3 * MINUTE, S);
    expect(r).toMatchObject({ ok: false, error: "challenge_expired" });
  });
});

describe("passkey bilan kirish va elevation", () => {
  async function setup() {
    const auth = new SoftAuthenticator();
    await registerPasskey(auth);
    return auth;
  }

  it("kirish: to'g'ri imzo sessiya beradi; hisoblagich oshadi", async () => {
    const auth = await setup();
    const o = must(await passkeyLoginOptions(NOW + 1000, S));
    const r = must(await passkeyLogin({ challengeId: o.challengeId, response: auth.assert(o.options.challenge) }, NOW + 1000, S));
    expect(r.session.method).toBe("passkey");
    expect(loadCredentials().passkeys[0].counter).toBe(1);
  });
  it("passkey yo'q bo'lsa options 404", async () => {
    expect(await passkeyLoginOptions(NOW, S)).toMatchObject({ ok: false, status: 404 });
  });
  it("qayta ishlatish (replay) rad etiladi: bir xil challenge ikkinchi marta o'tmaydi", async () => {
    const auth = await setup();
    const o = must(await passkeyLoginOptions(NOW, S));
    const resp = auth.assert(o.options.challenge);
    must(await passkeyLogin({ challengeId: o.challengeId, response: resp }, NOW, S));
    expect(await passkeyLogin({ challengeId: o.challengeId, response: resp }, NOW, S)).toMatchObject({ ok: false, error: "challenge_expired" });
  });
  it("hisoblagich orqaga ketsa (klon) rad etiladi", async () => {
    const auth = await setup();
    const o1 = must(await passkeyLoginOptions(NOW, S));
    must(await passkeyLogin({ challengeId: o1.challengeId, response: auth.assert(o1.options.challenge) }, NOW, S));
    auth.counter = 0; // klon eski hisoblagich bilan
    const o2 = must(await passkeyLoginOptions(NOW, S));
    expect(await passkeyLogin({ challengeId: o2.challengeId, response: auth.assert(o2.options.challenge) }, NOW, S)).toMatchObject({ ok: false, error: "assertion_failed" });
  });
  it("UV bayrog'isiz (faqat bosish) assertion rad etiladi: userVerification=required", async () => {
    const auth = await setup();
    auth.userVerified = false;
    const o = must(await passkeyLoginOptions(NOW, S));
    expect(await passkeyLogin({ challengeId: o.challengeId, response: auth.assert(o.options.challenge) }, NOW, S)).toMatchObject({ ok: false, error: "assertion_failed" });
  });
  it("boshqa origin / noma'lum kalit / boshqa challenge rad etiladi", async () => {
    const auth = await setup();
    const o = must(await passkeyLoginOptions(NOW, S));
    expect((await passkeyLogin({ challengeId: o.challengeId, response: auth.assert(o.options.challenge, { origin: "http://evil.example:4318" }) }, NOW, S)).ok).toBe(false);
    const o2 = must(await passkeyLoginOptions(NOW, S));
    expect((await passkeyLogin({ challengeId: o2.challengeId, response: auth.assert("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA") }, NOW, S)).ok).toBe(false);
    const stranger = new SoftAuthenticator();
    const o3 = must(await passkeyLoginOptions(NOW, S));
    expect(await passkeyLogin({ challengeId: o3.challengeId, response: stranger.assert(o3.options.challenge) }, NOW, S)).toMatchObject({ ok: false, error: "unknown_credential" });
  });
  it("elevation: passkey bilan tasdiq oynani yangilaydi; boshqa sessiya challenge'ini ishlata olmaydi", async () => {
    const auth = await setup();
    const o = must(await passkeyLoginOptions(NOW, S));
    const login = must(await passkeyLogin({ challengeId: o.challengeId, response: auth.assert(o.options.challenge) }, NOW, S));
    const later = NOW + 20 * MINUTE;
    expect(isElevated(login.session, later)).toBe(false);
    const eo = must(await passkeyElevateOptions(login.session, later, S));
    const el = must(await passkeyElevate(login.session, { challengeId: eo.challengeId, response: auth.assert(eo.options.challenge) }, later, S));
    expect(el.elevatedUntil).toBe(later + 5 * MINUTE);
    const view = lookupSession(login.sid, later + MINUTE, S, { touch: false });
    expect(view.ok && isElevated(view.session, later + MINUTE)).toBe(true);

    // boshqa sessiya
    const o2 = must(await passkeyLoginOptions(later, S));
    const other = must(await passkeyLogin({ challengeId: o2.challengeId, response: auth.assert(o2.options.challenge) }, later, S));
    const eo2 = must(await passkeyElevateOptions(login.session, later, S));
    const stolen = await passkeyElevate(other.session, { challengeId: eo2.challengeId, response: auth.assert(eo2.options.challenge) }, later, S);
    expect(stolen).toMatchObject({ ok: false });
  });
  it("login challenge'i elevation uchun ishlamaydi (maqsad bog'langan)", async () => {
    const auth = await setup();
    const o = must(await passkeyLoginOptions(NOW, S));
    const login = must(await passkeyLogin({ challengeId: o.challengeId, response: auth.assert(o.options.challenge) }, NOW, S));
    const lo = must(await passkeyLoginOptions(NOW, S));
    const r = await passkeyElevate(login.session, { challengeId: lo.challengeId, response: auth.assert(lo.options.challenge) }, NOW + 20 * MINUTE, S);
    expect(r).toMatchObject({ ok: false, error: "challenge_expired" });
  });
});

describe("parol bilan kirish: chegara va elevation", () => {
  beforeEach(async () => {
    await setPassword(tmp.dir(), "juda uzun parol 12345");
  });

  it("to'g'ri parol kirish beradi, noto'g'risi 401", async () => {
    expect(must(await loginWithPassword("juda uzun parol 12345", NOW, S)).session.method).toBe("password");
    expect(await loginWithPassword("xato", NOW, S)).toMatchObject({ ok: false, error: "invalid_credentials", status: 401 });
    expect(await loginWithPassword(undefined, NOW, S)).toMatchObject({ ok: false });
    expect(await loginWithPassword("x".repeat(5000), NOW, S)).toMatchObject({ ok: false });
  });
  it("5 ta noto'g'ri urinishdan keyin 429 (to'g'ri parol ham bloklanadi), blokdan keyin ochiladi", async () => {
    for (let i = 0; i < 5; i++) await loginWithPassword("xato", NOW + i, S);
    const locked = await loginWithPassword("juda uzun parol 12345", NOW + 10, S);
    expect(locked).toMatchObject({ ok: false, error: "rate_limited", status: 429 });
    expect((locked as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(0);
    expect(must(await loginWithPassword("juda uzun parol 12345", NOW + PASSWORD_LIMIT.lockMs + 100, S)).ok).toBe(true);
  });
  it("bloklanish passkey/ilova yo'lini to'smaydi (hujumchi egasini chiqarib yubora olmaydi)", async () => {
    const auth = new SoftAuthenticator();
    await registerPasskey(auth);
    for (let i = 0; i < 6; i++) await loginWithPassword("xato", NOW + i, S);
    expect(limiterFor("password", PASSWORD_LIMIT).check(NOW + 10).allowed).toBe(false);
    const o = must(await passkeyLoginOptions(NOW + 10, S));
    expect(must(await passkeyLogin({ challengeId: o.challengeId, response: auth.assert(o.options.challenge) }, NOW + 10, S)).ok).toBe(true);
  });
  it("parol yo'q bo'lsa kirish mumkin emas", async () => {
    tmp.reset();
    expect(await loginWithPassword("juda uzun parol 12345", NOW, S)).toMatchObject({ ok: false, error: "invalid_credentials" });
  });
  it("elevation parol bilan; noto'g'ri parol oynani yangilamaydi", async () => {
    const login = must(await loginWithPassword("juda uzun parol 12345", NOW, S));
    const later = NOW + 30 * MINUTE;
    expect(await elevateWithPassword(login.session, "xato", later, S)).toMatchObject({ ok: false });
    expect(must(await elevateWithPassword(login.session, "juda uzun parol 12345", later, S)).elevatedUntil).toBe(later + 5 * MINUTE);
  });
});

describe("Mac ilova yo'li (ilova siri)", () => {
  it("juftlash: sozlash kodisiz mumkin emas; kod bir marta; sir faqat xesh sifatida saqlanadi", () => {
    expect(appPair(CODE, "Mac", NOW)).toMatchObject({ ok: false });
    plantSetupCode(CODE, NOW);
    const p = must(appPair(CODE, "Mac", NOW));
    expect(p.secret.length).toBeGreaterThan(40);
    expect(JSON.stringify(loadCredentials())).not.toContain(p.secret);
    expect(appPair(CODE, "Mac", NOW + 1)).toMatchObject({ ok: false });
  });
  it("kirish: to'g'ri sir sessiya beradi; noto'g'ri/yo'q sir rad etiladi", () => {
    plantSetupCode(CODE, NOW);
    const { secret } = must(appPair(CODE, "Mac", NOW));
    expect(must(appLogin(secret, NOW, S)).session.method).toBe("app");
    expect(appLogin("boshqa", NOW, S)).toMatchObject({ ok: false, error: "invalid_app_secret" });
    expect(appLogin(null, NOW, S)).toMatchObject({ ok: false });
  });
  it("sir taxmin qilish chegaralanadi", () => {
    plantSetupCode(CODE, NOW);
    const { secret } = must(appPair(CODE, "Mac", NOW));
    for (let i = 0; i < 10; i++) appLogin("xato", NOW + i, S);
    expect(appLogin(secret, NOW + 20, S)).toMatchObject({ ok: false, error: "rate_limited" });
  });
  it("elevation: Touch ID'dan keyin olingan token bir marta va 30 soniya ishlaydi", () => {
    plantSetupCode(CODE, NOW);
    const { secret } = must(appPair(CODE, "Mac", NOW));
    const login = must(appLogin(secret, NOW, S));
    const later = NOW + 20 * MINUTE;
    const t = must(appElevationToken(secret, later));
    expect(must(appElevate(login.session, t.token, later + 1000, S)).elevatedUntil).toBe(later + 1000 + 5 * MINUTE);
    expect(appElevate(login.session, t.token, later + 2000, S)).toMatchObject({ ok: false, error: "invalid_token" });
    const stale = must(appElevationToken(secret, later));
    expect(appElevate(login.session, stale.token, later + 31_000, S)).toMatchObject({ ok: false });
  });
  it("siri yo'q kimsa elevation tokeni ololmaydi; tokensiz/soxta token ishlamaydi", () => {
    plantSetupCode(CODE, NOW);
    const { secret } = must(appPair(CODE, "Mac", NOW));
    const login = must(appLogin(secret, NOW, S));
    expect(appElevationToken("noto'g'ri", NOW)).toMatchObject({ ok: false });
    expect(appElevate(login.session, "soxta", NOW, S)).toMatchObject({ ok: false });
    expect(appElevate(login.session, undefined, NOW, S)).toMatchObject({ ok: false });
  });
});
