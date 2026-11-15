import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { clearSessionCookie, readSessionCookie, sessionSetCookie } from "@/lib/auth/cookie";
import { putChallenge, takeChallenge } from "@/lib/auth/challenges";
import { decide } from "@/lib/auth/guard";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { isPublicPath, safeNextPath } from "@/lib/auth/paths";
import { AttemptLimiter } from "@/lib/auth/ratelimit";
import { createSession, csrfMatches, destroySession, elevateSession, isElevated, lookupSession } from "@/lib/auth/sessions";
import { checkSetupCode, consumeSetupCode, SETUP_MAX_ATTEMPTS } from "@/lib/auth/setup-code";
import { getAuthSettings, HOUR, MINUTE } from "@/lib/auth/settings";
import { loadSessions } from "@/lib/auth/store";
import { hashPassword as cliHash, setPassword as cliSetPassword } from "../scripts/auth-cli.mjs";
import { loadCredentials } from "@/lib/auth/store";
import { plantSetupCode, settings, tempAuthDir } from "./auth-fixtures";

const tmp = tempAuthDir();
beforeEach(() => tmp.reset());
afterAll(() => tmp.cleanup());

const NOW = 1_800_000_000_000;
const S = settings();

describe("sozlamalar", () => {
  it("sukut: 12 soat mutlaq, 2 soat idle, 5 daqiqa elevation; env chegaralanadi", () => {
    expect(S.absoluteMs).toBe(12 * HOUR);
    expect(S.idleMs).toBe(2 * HOUR);
    expect(S.elevationMs).toBe(5 * MINUTE);
    expect(S.rpId).toBe("localhost");
    expect(S.origins).toEqual(["http://localhost:4318"]);
    const e = getAuthSettings({ DASHBOARD_ELEVATION_MINUTES: "99999", DASHBOARD_SESSION_HOURS: "9999", DASHBOARD_IDLE_MINUTES: "0" });
    expect(e.elevationMs).toBe(30 * MINUTE);
    expect(e.absoluteMs).toBe(24 * HOUR);
    expect(e.idleMs).toBe(5 * MINUTE);
  });
});

describe("parol xeshi", () => {
  it("to'g'ri parol o'tadi, noto'g'risi o'tmaydi, xesh har safar boshqa (tuz)", async () => {
    const h = await hashPassword("to'g'ri ot batareya");
    expect(h.startsWith("scrypt$65536$8$1$")).toBe(true);
    expect(await verifyPassword("to'g'ri ot batareya", h)).toBe(true);
    expect(await verifyPassword("noto'g'ri", h)).toBe(false);
    expect(await hashPassword("to'g'ri ot batareya")).not.toBe(h);
  });
  it("buzilgan/xavfli xesh formati rad etiladi (kichik N, noto'g'ri uzunlik)", async () => {
    expect(await verifyPassword("x", "plain")).toBe(false);
    expect(await verifyPassword("x", "scrypt$2$8$1$AAAA$AAAA")).toBe(false);
    expect(await verifyPassword("x", "scrypt$65536$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA")).toBe(false);
  });
  it("CLI yozgan xesh server tomonidan tekshiriladi (format mosligi)", async () => {
    expect(await verifyPassword("cli parol 123456", await cliHash("cli parol 123456"))).toBe(true);
    await cliSetPassword(tmp.dir(), "boshqa parol 987654");
    const stored = loadCredentials().password?.hash ?? "";
    expect(await verifyPassword("boshqa parol 987654", stored)).toBe(true);
  });
  it("CLI qisqa parolni rad etadi", async () => {
    await expect(cliSetPassword(tmp.dir(), "qisqa")).rejects.toThrow();
  });
});

describe("urinish chegarasi", () => {
  it("5 xatodan keyin bloklanadi, blok tugagach ochiladi, muvaffaqiyat hisobni nolga tushiradi", () => {
    const l = new AttemptLimiter({ max: 5, windowMs: 5 * MINUTE, lockMs: 5 * MINUTE });
    for (let i = 0; i < 4; i++) l.fail(NOW + i);
    expect(l.check(NOW + 10).allowed).toBe(true);
    l.fail(NOW + 11);
    const g = l.check(NOW + 12);
    expect(g.allowed).toBe(false);
    expect(g.retryAfterMs).toBeGreaterThan(4 * MINUTE);
    expect(l.check(NOW + 6 * MINUTE).allowed).toBe(true);
    l.fail(NOW + 7 * MINUTE);
    l.success();
    for (let i = 0; i < 4; i++) l.fail(NOW + 8 * MINUTE + i);
    expect(l.check(NOW + 9 * MINUTE).allowed).toBe(true);
  });
  it("oyna tashqarisidagi eski xatolar hisobga olinmaydi", () => {
    const l = new AttemptLimiter({ max: 3, windowMs: MINUTE, lockMs: MINUTE });
    l.fail(NOW);
    l.fail(NOW + 10);
    l.fail(NOW + 2 * MINUTE);
    expect(l.check(NOW + 2 * MINUTE).allowed).toBe(true);
  });
});

describe("sozlash kodi: bir martalik", () => {
  it("to'g'ri kod bir marta ishlaydi, ikkinchi marta yo'q", () => {
    plantSetupCode("ABCD-EFGH", NOW);
    expect(consumeSetupCode("abcd-efgh", NOW + 1000)).toBe("ok");
    expect(consumeSetupCode("ABCD-EFGH", NOW + 2000)).toBe("none");
  });
  it("10 daqiqadan keyin muddati o'tadi", () => {
    plantSetupCode("ABCD-EFGH", NOW);
    expect(checkSetupCode("ABCD-EFGH", NOW + 10 * MINUTE + 1)).toBe("expired");
    expect(checkSetupCode("ABCD-EFGH", NOW + 10 * MINUTE + 2)).toBe("none");
  });
  it("noto'g'ri urinishlar chegaralanadi: limitdan keyin to'g'ri kod ham ishlamaydi", () => {
    plantSetupCode("ABCD-EFGH", NOW);
    for (let i = 0; i < SETUP_MAX_ATTEMPTS; i++) expect(checkSetupCode("ZZZZ-ZZZZ", NOW + i)).toBe("invalid");
    expect(checkSetupCode("ABCD-EFGH", NOW + 100)).toBe("none");
  });
  it("noto'g'ri formatdagi kod rad etiladi", () => {
    plantSetupCode("ABCD-EFGH", NOW);
    expect(checkSetupCode("1", NOW)).toBe("invalid");
    expect(checkSetupCode("ABCD-EFGH-IJKL", NOW)).toBe("invalid");
  });
  it("kod yo'q bo'lsa 'none'", () => {
    expect(checkSetupCode("ABCD-EFGH", NOW)).toBe("none");
  });
});

describe("sessiyalar", () => {
  it("kirish sessiyani yaratadi, diskda faqat xesh turadi (xom id yo'q)", () => {
    const { sid, session } = createSession("password", NOW, S);
    const onDisk = JSON.stringify(loadSessions());
    expect(onDisk).not.toContain(sid);
    expect(onDisk).toContain(session.hash);
    expect(lookupSession(sid, NOW + 1000, S, { touch: false }).ok).toBe(true);
  });
  it("noma'lum/qisqa/bo'sh identifikator rad etiladi", () => {
    expect(lookupSession("x", NOW, S, { touch: false }).ok).toBe(false);
    expect(lookupSession(null, NOW, S, { touch: false }).ok).toBe(false);
    expect(lookupSession("a".repeat(43), NOW, S, { touch: false }).ok).toBe(false);
  });
  it("idle: 2 soat faoliyatsiz -> tugaydi; touch muddatni uzaytiradi, fon so'rovi uzaytirmaydi", () => {
    const { sid } = createSession("password", NOW, S);
    // fon so'rovlari (touch: false) idle'ni yangilamaydi
    expect(lookupSession(sid, NOW + 100 * MINUTE, S, { touch: false }).ok).toBe(true);
    expect(lookupSession(sid, NOW + 2 * HOUR + 1, S, { touch: false }).ok).toBe(false);
    // qayta kirish; faoliyat bilan uzaytiriladi
    const b = createSession("password", NOW, S);
    expect(lookupSession(b.sid, NOW + 100 * MINUTE, S, { touch: true }).ok).toBe(true);
    expect(lookupSession(b.sid, NOW + 200 * MINUTE, S, { touch: false }).ok).toBe(true);
  });
  it("mutlaq muddat: faol bo'lsa ham 12 soatda tugaydi", () => {
    const { sid } = createSession("password", NOW, S);
    for (let t = 1; t <= 11; t++) expect(lookupSession(sid, NOW + t * HOUR, S, { touch: true }).ok).toBe(true);
    expect(lookupSession(sid, NOW + 12 * HOUR + 1, S, { touch: true }).ok).toBe(false);
  });
  it("chiqish (logout) sessiyani o'chiradi", () => {
    const { sid } = createSession("password", NOW, S);
    destroySession(sid);
    expect(lookupSession(sid, NOW, S, { touch: false }).ok).toBe(false);
  });
  it("elevation: kirishdan keyin 5 daqiqa, keyin tugaydi; qayta tasdiq yangilaydi", () => {
    const { session, sid } = createSession("passkey", NOW, S);
    expect(isElevated(session, NOW + 4 * MINUTE)).toBe(true);
    expect(isElevated(session, NOW + 5 * MINUTE)).toBe(false);
    const until = elevateSession(session.hash, NOW + 30 * MINUTE, S);
    expect(until).toBe(NOW + 35 * MINUTE);
    const s2 = lookupSession(sid, NOW + 31 * MINUTE, S, { touch: false });
    expect(s2.ok && isElevated(s2.session, NOW + 31 * MINUTE)).toBe(true);
    expect(s2.ok && isElevated(s2.session, NOW + 36 * MINUTE)).toBe(false);
  });
  it("tugagan sessiyani ko'tarib bo'lmaydi", () => {
    const { session } = createSession("password", NOW, S);
    expect(elevateSession(session.hash, NOW + 13 * HOUR, S)).toBeNull();
  });
  it("CSRF tokeni sessiyaga xos va doimiy vaqtda solishtiriladi", () => {
    const a = createSession("password", NOW, S).session;
    const b = createSession("password", NOW, S).session;
    expect(csrfMatches(a, a.csrf)).toBe(true);
    expect(csrfMatches(a, b.csrf)).toBe(false);
    expect(csrfMatches(a, null)).toBe(false);
    expect(csrfMatches(a, "")).toBe(false);
  });
  it("sessiyalar soni chegaralanadi (20)", () => {
    for (let i = 0; i < 25; i++) createSession("password", NOW + i, S);
    expect(Object.keys(loadSessions()).length).toBeLessThanOrEqual(20);
  });
});

describe("guard.decide: auth -> csrf -> elevation tartibi (jadval)", () => {
  const live = createSession("password", NOW, S).session; // elevatedUntil = NOW+5min
  const cases: { name: string; session: typeof live | null; csrf: string | null; opts: Parameters<typeof decide>[2]; now: number; expect: string }[] = [
    { name: "sessiyasiz GET", session: null, csrf: null, opts: {}, now: NOW, expect: "401 unauthenticated" },
    { name: "sessiyasiz POST (csrf bor)", session: null, csrf: "x", opts: { mutating: true }, now: NOW, expect: "401 unauthenticated" },
    { name: "GET sessiya bilan", session: live, csrf: null, opts: {}, now: NOW, expect: "ok" },
    { name: "POST csrf'siz", session: live, csrf: null, opts: { mutating: true }, now: NOW, expect: "403 csrf" },
    { name: "POST noto'g'ri csrf", session: live, csrf: "boshqa", opts: { mutating: true }, now: NOW, expect: "403 csrf" },
    { name: "POST to'g'ri csrf", session: live, csrf: live.csrf, opts: { mutating: true }, now: NOW, expect: "ok" },
    { name: "xavfli amal elevation ichida", session: live, csrf: live.csrf, opts: { mutating: true, elevation: true }, now: NOW + MINUTE, expect: "ok" },
    { name: "xavfli amal elevation tugagach", session: live, csrf: live.csrf, opts: { mutating: true, elevation: true }, now: NOW + 6 * MINUTE, expect: "401 reauth_required" },
    { name: "csrf elevation'dan oldin tekshiriladi", session: live, csrf: "x", opts: { mutating: true, elevation: true }, now: NOW + 6 * MINUTE, expect: "403 csrf" },
  ];
  it.each(cases)("$name", (c) => {
    const r = decide(c.session, c.csrf, c.opts, c.now);
    const got = r.ok ? "ok" : `${r.status} ${r.error}`;
    expect(got).toBe(c.expect);
  });
});

describe("challenge: bir martalik", () => {
  it("olingach o'chadi; muddati o'tgan/boshqa maqsad/boshqa sessiya rad etiladi", () => {
    const id = putChallenge({ purpose: "login", challenge: "abc" }, NOW);
    expect(takeChallenge(id, "login", NOW + 1000)?.challenge).toBe("abc");
    expect(takeChallenge(id, "login", NOW + 1000)).toBeNull();
    const old = putChallenge({ purpose: "login", challenge: "abc" }, NOW);
    expect(takeChallenge(old, "login", NOW + 3 * MINUTE)).toBeNull();
    const wrongPurpose = putChallenge({ purpose: "login", challenge: "abc" }, NOW);
    expect(takeChallenge(wrongPurpose, "elevate", NOW)).toBeNull();
    const bound = putChallenge({ purpose: "elevate", challenge: "abc", sessionHash: "S1" }, NOW);
    expect(takeChallenge(bound, "elevate", NOW, "S2")).toBeNull();
    const bound2 = putChallenge({ purpose: "elevate", challenge: "abc", sessionHash: "S1" }, NOW);
    expect(takeChallenge(bound2, "elevate", NOW, "S1")).not.toBeNull();
  });
});

describe("cookie va yo'llar", () => {
  it("cookie: HttpOnly, SameSite=Strict, Domain yo'q, Secure yo'q (http://localhost)", () => {
    const c = sessionSetCookie("tok", 43200);
    expect(c).toContain("HttpOnly");
    expect(c).toContain("SameSite=Strict");
    expect(c).toContain("Path=/");
    expect(c).not.toContain("Domain");
    expect(c).not.toContain("Secure");
    expect(clearSessionCookie()).toContain("Max-Age=0");
  });
  it("cookie sarlavhasidan sessiya o'qiladi", () => {
    expect(readSessionCookie("a=1; commander_session=XYZ; b=2")).toBe("XYZ");
    expect(readSessionCookie("a=1")).toBeNull();
    expect(readSessionCookie(null)).toBeNull();
    expect(readSessionCookie("commander_session=")).toBeNull();
  });
  it("faqat /login va /api/auth/* ochiq", () => {
    for (const p of ["/login", "/api/auth/session", "/api/auth/passkey/login/options"]) expect(isPublicPath(p)).toBe(true);
    for (const p of ["/", "/sessions", "/api/c/machines", "/api/stream", "/api/chat/x/stream", "/api/authx", "/login/x", "/api"]) expect(isPublicPath(p)).toBe(false);
  });
  it("?next= faqat ichki yo'l (open redirect yo'q)", () => {
    expect(safeNextPath("/sessions/abc?x=1")).toBe("/sessions/abc?x=1");
    for (const bad of ["//evil.com", "https://evil.com", "/\\evil", "javascript:alert(1)", "", null, "/login", "/api/auth/x", "/a\nb"]) expect(safeNextPath(bad as string | null)).toBe("/");
  });
});
