import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const upstream = vi.hoisted(() => ({ calls: [] as { path: string; scope?: string; method?: string }[] }));

vi.mock("@/lib/commander", async (orig) => {
  const actual = await orig<typeof import("@/lib/commander")>();
  return {
    ...actual,
    commanderRequest: vi.fn(async (path: string, opts: { scope?: string; method?: string } = {}) => {
      upstream.calls.push({ path, scope: opts.scope, method: opts.method });
      return { status: 200, json: { ok: true } };
    }),
  };
});
vi.mock("@/lib/bridge", () => ({ subscribeBridge: () => () => {} }));

import { GET as streamGET } from "@/app/api/stream/route";
import { GET as chatOlderGET } from "@/app/api/chat/[sessionId]/older/route";
import { GET as chatStreamGET } from "@/app/api/chat/[sessionId]/stream/route";
import * as cRoute from "@/app/api/c/[...path]/route";
import { proxy } from "../proxy";
import { createSession } from "@/lib/auth/sessions";
import { MINUTE } from "@/lib/auth/settings";
import { elevationFor, elevationRequired } from "@/lib/proxy-rules";
import { settings, tempAuthDir } from "./auth-fixtures";

const tmp = tempAuthDir();
const S = settings();
beforeEach(() => {
  tmp.reset();
  upstream.calls.length = 0;
});
afterAll(() => tmp.cleanup());

const ID = "11111111-1111-4111-8111-111111111111";
const HOST = "127.0.0.1:4318";
const ORIGIN = `http://${HOST}`;

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
type Req = { method: Method; path: string; body?: unknown; elevation: "none" | "required" };

/** Ruxsat ro'yxatidagi HAR BIR yo'l sinfi. `elevation`: o'zgartiruvchi yo'l elevation talab qiladimi. */
const GET_ROUTES = [
  "machines", "sessions", `sessions/${ID}`, `sessions/${ID}/events`, `sessions/${ID}/commands`, "projects", `projects/${ID}`, `projects/${ID}/tasks`, `projects/${ID}/commits`,
  `projects/${ID}/daily`, `projects/${ID}/md-files`, `projects/${ID}/git`, "usage", "usage/summary", "limits", "queue", `queue/${ID}`, "templates", `templates/${ID}`, "orchestrations",
  `orchestrations/${ID}`, "approvals", `approvals/${ID}`, "commands", `commands/${ID}`, "approval-rules", "tasks", `machines/${ID}/health`, "health/summary", "health/incidents",
  "health/thresholds", "center/health", "messaging/settings", "messaging/groups", "messaging/group", "messaging/messages", "alerts", "watchdog/settings", "reports", "reports/settings",
  `reports/${ID}`, "config/profiles", `config/profiles/${ID}`, `config/profiles/${ID}/file`, "config/status", "config/settings",
];

const MUTATING: Req[] = [
  { method: "POST", path: `approvals/${ID}/decision`, body: { behavior: "allow" }, elevation: "required" },
  { method: "POST", path: `approvals/${ID}/decision`, body: { behavior: "deny" }, elevation: "none" },
  { method: "POST", path: "commands", body: { type: "session.start" }, elevation: "required" },
  { method: "POST", path: "commands", body: { type: "session.prompt", sessionId: ID, text: "x" }, elevation: "required" },
  { method: "POST", path: "commands", body: { type: "session.set_mode" }, elevation: "required" },
  { method: "POST", path: "commands", body: { type: "session.remote_control" }, elevation: "required" },
  { method: "POST", path: "commands", body: { type: "session.resume", sessionId: ID }, elevation: "required" },
  { method: "POST", path: "commands", body: { type: "session.close", sessionId: ID }, elevation: "required" },
  { method: "POST", path: "commands", body: { type: "session.stop", sessionId: ID }, elevation: "none" },
  { method: "POST", path: "commands", body: {}, elevation: "required" },
  { method: "POST", path: `commands/${ID}/confirm`, body: {}, elevation: "required" },
  { method: "POST", path: `commands/${ID}/cancel`, body: {}, elevation: "none" },
  { method: "POST", path: "orchestrations", body: {}, elevation: "required" },
  { method: "POST", path: `orchestrations/${ID}/cancel`, body: {}, elevation: "none" },
  { method: "POST", path: "queue", body: {}, elevation: "required" },
  { method: "PATCH", path: `queue/${ID}`, body: {}, elevation: "required" },
  { method: "DELETE", path: `queue/${ID}`, elevation: "none" },
  { method: "POST", path: `queue/${ID}/run-now`, body: {}, elevation: "required" },
  { method: "POST", path: `queue/${ID}/cancel`, body: {}, elevation: "none" },
  { method: "POST", path: "templates", body: {}, elevation: "none" },
  { method: "PATCH", path: `templates/${ID}`, body: {}, elevation: "none" },
  { method: "DELETE", path: `templates/${ID}`, elevation: "none" },
  { method: "POST", path: `templates/${ID}/render`, body: {}, elevation: "none" },
  { method: "POST", path: `templates/${ID}/send-prompt`, body: {}, elevation: "required" },
  { method: "POST", path: "approval-rules", body: {}, elevation: "required" },
  { method: "DELETE", path: "approval-rules/123", elevation: "none" },
  { method: "POST", path: `projects/${ID}/daily/2026-11-14/summary`, body: {}, elevation: "required" },
  { method: "POST", path: `projects/${ID}/md-extract`, body: {}, elevation: "required" },
  { method: "POST", path: `projects/${ID}/tasks/append`, body: {}, elevation: "required" },
  { method: "POST", path: `projects/${ID}/refresh`, body: {}, elevation: "none" },
  { method: "POST", path: `projects/${ID}/diff`, body: {}, elevation: "none" },
  { method: "POST", path: `projects/${ID}/pr`, body: {}, elevation: "required" },
  { method: "POST", path: `projects/${ID}/ci/refresh`, body: {}, elevation: "none" },
  { method: "POST", path: `sessions/${ID}/diff`, body: {}, elevation: "none" },
  { method: "PATCH", path: `projects/${ID}/tasks/t1/board`, body: {}, elevation: "none" },
  { method: "PUT", path: "messaging/settings", body: {}, elevation: "required" },
  { method: "PATCH", path: "messaging/groups", body: {}, elevation: "required" },
  { method: "PUT", path: "messaging/groups/context", body: {}, elevation: "required" },
  { method: "PUT", path: "messaging/groups/rules", body: {}, elevation: "required" },
  { method: "PUT", path: `messaging/sessions/${ID}/role`, body: {}, elevation: "required" },
  { method: "PUT", path: "messaging/links", body: {}, elevation: "required" },
  { method: "DELETE", path: "messaging/links", elevation: "required" },
  { method: "POST", path: "messaging/messages", body: {}, elevation: "required" },
  { method: "POST", path: `alerts/${ID}/dismiss`, body: {}, elevation: "none" },
  { method: "PUT", path: "watchdog/settings", body: {}, elevation: "required" },
  { method: "PUT", path: "reports/settings", body: {}, elevation: "required" },
  { method: "POST", path: "reports/generate", body: {}, elevation: "required" },
  { method: "PUT", path: "config/settings", body: {}, elevation: "required" },
  { method: "POST", path: "config/profiles/capture", body: {}, elevation: "required" },
  { method: "POST", path: `config/machines/${ID}/diff`, body: {}, elevation: "required" },
  { method: "POST", path: `config/machines/${ID}/apply`, body: {}, elevation: "required" },
  { method: "POST", path: `config/machines/${ID}/rollback`, body: {}, elevation: "required" },
];

function creq(method: Method, path: string, o: { cookie?: string; csrf?: string; body?: unknown } = {}): NextRequest {
  const headers = new Headers({ host: HOST });
  if (o.cookie) headers.set("cookie", `commander_session=${o.cookie}`);
  if (o.csrf) headers.set("x-csrf-token", o.csrf);
  let body: string | undefined;
  if (method !== "GET") {
    headers.set("origin", ORIGIN);
    if (o.body !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(o.body);
    }
  }
  return new NextRequest(`${ORIGIN}/api/c/${path}`, { method, headers, body });
}

async function call(method: Method, path: string, o: Parameters<typeof creq>[2] = {}): Promise<Response> {
  const handler = cRoute[method];
  return handler(creq(method, path, o), { params: Promise.resolve({ path: path.split("/") }) } as never);
}

const errOf = async (r: Response) => ((await r.json()) as { error?: string }).error;

/** Elevation tugagan (10 daqiqa oldin kirgan) va elevation ichidagi sessiyalar. */
function stale() {
  return createSession("password", Date.now() - 10 * MINUTE, S);
}
function fresh() {
  return createSession("password", Date.now(), S);
}

describe("/api/c: HAR BIR ruxsat etilgan GET yo'li autentifikatsiya talab qiladi", () => {
  it.each(GET_ROUTES)("GET %s", async (path) => {
    const noCookie = await call("GET", path);
    expect(noCookie.status).toBe(401);
    expect(await errOf(noCookie)).toBe("unauthenticated");
    expect((await call("GET", path, { cookie: "x".repeat(43) })).status).toBe(401);
    expect(upstream.calls).toHaveLength(0);

    const s = stale(); // GET elevation talab qilmaydi
    const ok = await call("GET", path, { cookie: s.sid });
    expect(ok.status).toBe(200);
    expect(upstream.calls).toHaveLength(1);
  });
  it("noma'lum yo'l kirmaganlarga 404 emas 401 (yo'l mavjudligi sezdirilmaydi)", async () => {
    expect((await call("GET", "devices/me")).status).toBe(401);
    expect((await call("DELETE", "machines")).status).toBe(401);
  });
  it("kirgan foydalanuvchiga noma'lum yo'l baribir 404", async () => {
    expect((await call("GET", "devices/me", { cookie: fresh().sid })).status).toBe(404);
  });
});

describe("/api/c: o'zgartiruvchi yo'llar: auth, CSRF, elevation", () => {
  it.each(MUTATING.map((m) => [`${m.method} ${m.path} ${JSON.stringify(m.body ?? "")}`, m] as const))("%s", async (_name, m) => {
    // 1) kirmagan -> 401, upstream'ga hech narsa ketmaydi
    const anon = await call(m.method, m.path, { body: m.body, csrf: "x" });
    expect(anon.status).toBe(401);
    expect(await errOf(anon)).toBe("unauthenticated");

    // 2) kirgan, lekin CSRF yo'q/noto'g'ri -> 403
    const f = fresh();
    expect((await call(m.method, m.path, { cookie: f.sid, body: m.body })).status).toBe(403);
    expect((await call(m.method, m.path, { cookie: f.sid, csrf: "noto'g'ri", body: m.body })).status).toBe(403);
    expect(upstream.calls).toHaveLength(0);

    // 3) elevation tugagan sessiya
    const s = stale();
    const r = await call(m.method, m.path, { cookie: s.sid, csrf: s.session.csrf, body: m.body });
    if (m.elevation === "required") {
      expect(r.status).toBe(401);
      expect(await errOf(r)).toBe("reauth_required");
      expect(upstream.calls).toHaveLength(0);
    } else {
      expect(r.status).toBe(200);
      expect(upstream.calls).toHaveLength(1);
      upstream.calls.length = 0;
    }

    // 4) yangi tasdiqli sessiya -> o'tadi
    const r2 = await call(m.method, m.path, { cookie: f.sid, csrf: f.session.csrf, body: m.body });
    expect(r2.status).toBe(200);
    expect(upstream.calls).toHaveLength(1);
  });

  it("jadval elevationFor bilan mos (xuddi shu qoida)", () => {
    for (const m of MUTATING) {
      const need = elevationRequired(elevationFor(m.method, m.path.split("/")), m.body);
      expect(need, `${m.method} ${m.path}`).toBe(m.elevation === "required");
    }
  });
  it("FAIL-CLOSED: ro'yxatdagi noma'lum o'zgartiruvchi yo'l elevation talab qiladi; GET hech qachon", () => {
    expect(elevationRequired(elevationFor("POST", ["yangi", "narsa"]), {})).toBe(true);
    expect(elevationRequired(elevationFor("PUT", ["config", "settings"]), {})).toBe(true);
    expect(elevationRequired(elevationFor("GET", ["config", "settings"]), undefined)).toBe(false);
  });
  it("elevation ichida confirm approve scope bilan upstream'ga boradi", async () => {
    const f = fresh();
    const r = await call("POST", `commands/${ID}/confirm`, { cookie: f.sid, csrf: f.session.csrf, body: {} });
    expect(r.status).toBe(200);
    expect(upstream.calls[0]).toMatchObject({ scope: "approve", method: "POST", path: `/commands/${ID}/confirm` });
  });
  it("tugagan elevation 5 daqiqadan keyin qayta so'raydi (oyna chegarasi)", async () => {
    const t0 = Date.now();
    const sess = createSession("password", t0 - 4 * MINUTE - 50_000, S); // elevatedUntil ~ t0 + 10 s
    expect((await call("POST", "commands", { cookie: sess.sid, csrf: sess.session.csrf, body: { type: "session.start" } })).status).toBe(200);
    const old = createSession("password", t0 - 5 * MINUTE - 1000, S);
    expect((await call("POST", "commands", { cookie: old.sid, csrf: old.session.csrf, body: { type: "session.start" } })).status).toBe(401);
  });
  it("Origin mos kelmasa 403 (mavjud himoya saqlangan)", async () => {
    const f = fresh();
    const bad = new NextRequest(`${ORIGIN}/api/c/commands`, { method: "POST", headers: { host: HOST, origin: "http://evil.example", cookie: `commander_session=${f.sid}`, "x-csrf-token": f.session.csrf, "content-type": "application/json" }, body: "{}" });
    const r = await cRoute.POST(bad, { params: Promise.resolve({ path: ["commands"] }) } as never);
    expect(r.status).toBe(403);
    expect(upstream.calls).toHaveLength(0);
  });
});

describe("SSE va chat yo'llari", () => {
  const sse = (url: string, cookie?: string) => new Request(`${ORIGIN}${url}`, { headers: cookie ? { host: HOST, cookie: `commander_session=${cookie}` } : { host: HOST } });
  it("/api/stream kirmaganlarga 401; kirganlarga oqim", async () => {
    expect((await streamGET(sse("/api/stream"))).status).toBe(401);
    const ok = await streamGET(sse("/api/stream", fresh().sid));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toContain("text/event-stream");
    await ok.body?.cancel();
  });
  it("/api/chat/*: kirmaganlarga 401 (parametr tekshiruvidan oldin)", async () => {
    const ctx = { params: Promise.resolve({ sessionId: "bad" }) };
    expect((await chatStreamGET(sse("/api/chat/bad/stream?cid=x"), ctx)).status).toBe(401);
    expect((await chatOlderGET(sse("/api/chat/bad/older?cid=x&before=1"), ctx)).status).toBe(401);
    // kirgan: autentifikatsiyadan o'tdi va endi parametr tekshiruvi 400 beradi
    const s = fresh().sid;
    expect((await chatStreamGET(sse("/api/chat/bad/stream?cid=x", s), ctx)).status).toBe(400);
    expect((await chatOlderGET(sse("/api/chat/bad/older?cid=x&before=1", s), ctx)).status).toBe(400);
  });
});

describe("proxy.ts: sahifalar va API sessiyasiz yopiq", () => {
  const preq = (path: string, cookie?: string, host = HOST, extra: Record<string, string> = {}) => new NextRequest(`http://${host}${path}`, { headers: { host, ...(cookie ? { cookie: `commander_session=${cookie}` } : {}), ...extra } });

  it("sahifalar /login ga yo'naltiriladi (next bilan)", () => {
    const r = proxy(preq("/"));
    expect(r.status).toBe(307);
    expect(new URL(r.headers.get("location") ?? "").pathname).toBe("/login");
    const r2 = proxy(preq("/sessions/abc?tab=chat"));
    const loc = new URL(r2.headers.get("location") ?? "");
    expect(loc.pathname).toBe("/login");
    expect(loc.searchParams.get("next")).toBe("/sessions/abc?tab=chat");
    for (const p of ["/projects", "/usage", "/settings", "/settings-sync", "/tokens", "/queue", "/templates", "/reports", "/alerts", "/machines", "/anything-else"]) {
      expect(proxy(preq(p)).status, p).toBe(307);
    }
  });
  it("API yo'llari 401 JSON (yo'naltirish emas)", async () => {
    for (const p of ["/api/c/machines", "/api/stream", `/api/chat/${ID}/stream`, `/api/chat/${ID}/older`, "/api/anything"]) {
      const r = proxy(preq(p));
      expect(r.status, p).toBe(401);
      expect(((await r.json()) as { error: string }).error).toBe("unauthenticated");
    }
  });
  it("ochiq yo'llar: /login va /api/auth/* o'tadi", () => {
    for (const p of ["/login", "/api/auth/session", "/api/auth/methods", "/api/auth/login/password"]) {
      expect(proxy(preq(p)).headers.get("x-middleware-next"), p).toBe("1");
    }
  });
  it("haqiqiy sessiya bilan hamma narsa o'tadi; soxta cookie o'tmaydi", () => {
    const s = fresh().sid;
    for (const p of ["/", "/sessions", "/api/c/machines", "/api/stream"]) expect(proxy(preq(p, s)).headers.get("x-middleware-next"), p).toBe("1");
    expect(proxy(preq("/", "soxta".repeat(10))).status).toBe(307);
  });
  it("Host tekshiruvi (DNS-rebinding) avvalgidek: begona host 403", () => {
    expect(proxy(preq("/login", undefined, "evil.example")).status).toBe(403);
    expect(proxy(preq("/", fresh().sid, "evil.example")).status).toBe(403);
  });
  it("localhost host ham ruxsat (passkey uchun)", () => {
    expect(proxy(preq("/login", undefined, "localhost:4318")).headers.get("x-middleware-next")).toBe("1");
  });
});
