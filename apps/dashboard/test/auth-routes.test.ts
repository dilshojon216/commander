import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST as appLoginPOST } from "@/app/api/auth/app/login/route";
import { POST as appPairPOST } from "@/app/api/auth/app/pair/route";
import { POST as appTokenPOST } from "@/app/api/auth/app/elevation-token/route";
import { GET as methodsGET } from "@/app/api/auth/methods/route";
import { POST as elevateAppPOST } from "@/app/api/auth/elevate/app/route";
import { POST as elevatePwPOST } from "@/app/api/auth/elevate/password/route";
import { POST as loginPwPOST } from "@/app/api/auth/login/password/route";
import { POST as logoutPOST } from "@/app/api/auth/logout/route";
import { POST as passkeyRegOptsPOST } from "@/app/api/auth/passkey/register/options/route";
import { GET as sessionGET } from "@/app/api/auth/session/route";
import { POST as pingPOST } from "@/app/api/auth/ping/route";
import { lookupSession } from "@/lib/auth/sessions";
import { setPassword } from "../scripts/auth-cli.mjs";
import { plantSetupCode, settings, tempAuthDir } from "./auth-fixtures";

const tmp = tempAuthDir();
const S = settings();
const HOST = "127.0.0.1:4318";
const ORIGIN = `http://${HOST}`;
const PW = "juda uzun parol 12345";

beforeEach(async () => {
  tmp.reset();
  (globalThis as { __commanderLimiters?: unknown }).__commanderLimiters = undefined;
  await setPassword(tmp.dir(), PW);
});
afterAll(() => tmp.cleanup());

function post(path: string, body: unknown, h: Record<string, string> = {}, origin: string | null = ORIGIN): Request {
  const headers: Record<string, string> = { host: HOST, "content-type": "application/json", ...h };
  if (origin) headers.origin = origin;
  return new Request(`${ORIGIN}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

function cookieOf(res: Response): string {
  const sc = res.headers.get("set-cookie") ?? "";
  return /commander_session=([^;]+)/.exec(sc)?.[1] ?? "";
}

async function login(): Promise<{ sid: string; csrf: string }> {
  const r = await loginPwPOST(post("/api/auth/login/password", { password: PW }));
  expect(r.status).toBe(200);
  const body = (await r.json()) as { csrf: string };
  return { sid: cookieOf(r), csrf: body.csrf };
}

describe("parol bilan kirish route'i", () => {
  it("cookie: HttpOnly; SameSite=Strict; Path=/; Domain yo'q; no-store; javobda parol/xesh yo'q", async () => {
    const r = await loginPwPOST(post("/api/auth/login/password", { password: PW }));
    expect(r.status).toBe(200);
    const sc = r.headers.get("set-cookie") ?? "";
    expect(sc).toMatch(/^commander_session=[A-Za-z0-9_-]{40,};/);
    expect(sc).toContain("HttpOnly");
    expect(sc).toContain("SameSite=Strict");
    expect(sc).toContain("Path=/");
    expect(sc).toContain("Max-Age=43200");
    expect(sc).not.toContain("Domain");
    expect(r.headers.get("cache-control")).toBe("no-store");
    const text = JSON.stringify(await r.json());
    expect(text).not.toContain(PW);
    expect(text).not.toContain("scrypt");
  });
  it("noto'g'ri parol 401, cookie yo'q; 5 urinishdan keyin 429 + Retry-After", async () => {
    for (let i = 0; i < 5; i++) {
      const r = await loginPwPOST(post("/api/auth/login/password", { password: "xato" }));
      expect(r.status).toBe(401);
      expect(r.headers.get("set-cookie")).toBeNull();
    }
    const r = await loginPwPOST(post("/api/auth/login/password", { password: PW }));
    expect(r.status).toBe(429);
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
  });
  it("Origin yo'q yoki begona bo'lsa 403 (login CSRF yo'q)", async () => {
    expect((await loginPwPOST(post("/api/auth/login/password", { password: PW }, {}, null))).status).toBe(403);
    expect((await loginPwPOST(post("/api/auth/login/password", { password: PW }, {}, "http://evil.example"))).status).toBe(403);
  });
  it("yaroqsiz JSON / massiv / juda katta tana rad etiladi", async () => {
    const mk = (body: string) => new Request(`${ORIGIN}/api/auth/login/password`, { method: "POST", headers: { host: HOST, origin: ORIGIN }, body });
    expect((await loginPwPOST(mk("{bad"))).status).toBe(400);
    expect((await loginPwPOST(mk("[1]"))).status).toBe(400);
    expect((await loginPwPOST(mk(JSON.stringify({ password: "x".repeat(70_000) })))).status).toBe(413);
  });
});

describe("sessiya, ping, chiqish", () => {
  it("sessiyasiz GET /session 401; sessiya bilan CSRF va usullar qaytadi", async () => {
    expect((await sessionGET(new Request(`${ORIGIN}/api/auth/session`, { headers: { host: HOST } }))).status).toBe(401);
    const { sid, csrf } = await login();
    const r = await sessionGET(new Request(`${ORIGIN}/api/auth/session`, { headers: { host: HOST, cookie: `commander_session=${sid}` } }));
    expect(r.status).toBe(200);
    const b = (await r.json()) as { csrf: string; methods: { password: boolean }; elevationMs: number };
    expect(b.csrf).toBe(csrf);
    expect(b.methods.password).toBe(true);
    expect(b.elevationMs).toBe(5 * 60_000);
  });
  it("/methods ommaviy, faqat bayroqlar (sir yo'q)", async () => {
    const t = await (await methodsGET()).text();
    expect(JSON.parse(t)).toEqual({ passkey: false, password: true, app: false });
  });
  it("ping va logout CSRF talab qiladi; logout sessiyani o'chiradi va cookie'ni tozalaydi", async () => {
    const { sid, csrf } = await login();
    const c = { cookie: `commander_session=${sid}` };
    expect((await pingPOST(post("/api/auth/ping", {}, c))).status).toBe(403);
    expect((await pingPOST(post("/api/auth/ping", {}, { ...c, "x-csrf-token": csrf }))).status).toBe(200);
    expect((await logoutPOST(post("/api/auth/logout", {}, c))).status).toBe(403);
    const out = await logoutPOST(post("/api/auth/logout", {}, { ...c, "x-csrf-token": csrf }));
    expect(out.status).toBe(200);
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(lookupSession(sid, Date.now(), S, { touch: false }).ok).toBe(false);
    expect((await pingPOST(post("/api/auth/ping", {}, { ...c, "x-csrf-token": csrf }))).status).toBe(401);
  });
  it("elevation/password: sessiya + CSRF + to'g'ri parol kerak", async () => {
    const { sid, csrf } = await login();
    const h = { cookie: `commander_session=${sid}`, "x-csrf-token": csrf };
    expect((await elevatePwPOST(post("/api/auth/elevate/password", { password: PW }))).status).toBe(401);
    expect((await elevatePwPOST(post("/api/auth/elevate/password", { password: "xato" }, h))).status).toBe(401);
    const r = await elevatePwPOST(post("/api/auth/elevate/password", { password: PW }, h));
    expect(r.status).toBe(200);
    expect(((await r.json()) as { elevatedUntil: number }).elevatedUntil).toBeGreaterThan(Date.now());
  });
});

describe("passkey ro'yxatdan o'tkazish route'i", () => {
  it("sozlash kodisiz 403; noto'g'ri kod 401", async () => {
    expect((await passkeyRegOptsPOST(post("/api/auth/passkey/register/options", { setupCode: "ABCD-EFGH" }))).status).toBe(403);
    plantSetupCode("ABCD-EFGH", Date.now());
    expect((await passkeyRegOptsPOST(post("/api/auth/passkey/register/options", { setupCode: "WXYZ-2345" }))).status).toBe(401);
    const ok = await passkeyRegOptsPOST(post("/api/auth/passkey/register/options", { setupCode: "ABCD-EFGH" }));
    expect(ok.status).toBe(200);
    const b = (await ok.json()) as { options: { rp: { id: string }; authenticatorSelection: { userVerification: string; authenticatorAttachment: string } } };
    expect(b.options.rp.id).toBe("localhost");
    expect(b.options.authenticatorSelection).toMatchObject({ userVerification: "required", authenticatorAttachment: "platform" });
  });
});

describe("Mac ilova route'lari", () => {
  it("juftlash -> kirish -> elevation tokeni -> elevation (to'liq zanjir)", async () => {
    plantSetupCode("ABCD-EFGH", Date.now());
    const pair = await appPairPOST(post("/api/auth/app/pair", { setupCode: "ABCD-EFGH", name: "Test Mac" }, {}, null));
    expect(pair.status).toBe(200);
    const { secret } = (await pair.json()) as { secret: string };
    // kod bir martalik
    expect((await appPairPOST(post("/api/auth/app/pair", { setupCode: "ABCD-EFGH" }, {}, null))).status).toBe(403);

    const bearer = { authorization: `Bearer ${secret}` };
    expect((await appLoginPOST(post("/api/auth/app/login", {}, { authorization: "Bearer yoq" }, null))).status).toBe(401);
    const lr = await appLoginPOST(post("/api/auth/app/login", {}, bearer, null));
    expect(lr.status).toBe(200);
    const sid = cookieOf(lr);
    const csrf = ((await lr.json()) as { csrf: string }).csrf;
    expect(sid.length).toBeGreaterThan(40);

    const tok = await appTokenPOST(post("/api/auth/app/elevation-token", {}, bearer, null));
    expect(tok.status).toBe(200);
    const { token } = (await tok.json()) as { token: string };
    const h = { cookie: `commander_session=${sid}`, "x-csrf-token": csrf };
    expect((await elevateAppPOST(post("/api/auth/elevate/app", { token }, h))).status).toBe(200);
    expect((await elevateAppPOST(post("/api/auth/elevate/app", { token }, h))).status).toBe(401); // bir martalik
  });
  it("brauzerdan begona Origin bilan ilova route'lari rad etiladi", async () => {
    expect((await appLoginPOST(post("/api/auth/app/login", {}, { authorization: "Bearer x" }, "http://evil.example"))).status).toBe(403);
    expect((await appPairPOST(post("/api/auth/app/pair", { setupCode: "ABCD-EFGH" }, {}, "http://evil.example"))).status).toBe(403);
  });
});
