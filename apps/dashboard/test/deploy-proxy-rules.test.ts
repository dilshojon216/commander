import { describe, expect, it } from "vitest";
import { PROXY_TIMEOUT_CONFIG_MS, PROXY_TIMEOUT_DEFAULT_MS, classifyProxyRequest, elevationFor, elevationRequired, maxBodyFor, needsIdempotencyKey, proxyTimeoutFor } from "@/lib/proxy-rules";

const ID = "11111111-1111-4111-8111-111111111111";
const CMD = "22222222-2222-4222-8222-222222222222";
const READ = { ok: true, scope: "read", method: "GET" };
const ctl = (method: string) => ({ ok: true, scope: "control", method });

const INSPECT = ["projects", ID, "deploy", "inspect"];
const RUN = ["projects", ID, "deploy", "run"];
const ROLLBACK = ["projects", ID, "deploy", "rollback"];
const RUNS = ["projects", ID, "deploy", "runs"];
const OUTPUT = ["deploy", "runs", CMD, "output"];
const CP_CREATE = ["projects", ID, "checkpoints"];
const CP_LIST = ["projects", ID, "checkpoints", "list"];
const CP_RESTORE = ["projects", ID, "checkpoints", "restore"];
const CP_SETTINGS = ["checkpoints", "settings"];

describe("proxy: deploy (6.5)", () => {
  it("ruxsat etilgan yo'llar va tokenlar: POST control, GET read", () => {
    expect(classifyProxyRequest("POST", INSPECT)).toEqual(ctl("POST"));
    expect(classifyProxyRequest("POST", RUN)).toEqual(ctl("POST"));
    expect(classifyProxyRequest("POST", ROLLBACK)).toEqual(ctl("POST"));
    expect(classifyProxyRequest("GET", RUNS)).toEqual(READ);
    expect(classifyProxyRequest("GET", OUTPUT)).toEqual(READ);
  });
  it("noto'g'ri metod: 405 (yozuvni GET bilan, o'qishni POST bilan chaqirib bo'lmaydi)", () => {
    for (const p of [INSPECT, RUN, ROLLBACK]) {
      expect(classifyProxyRequest("GET", p)).toEqual({ ok: false, status: 405 });
      expect(classifyProxyRequest("PUT", p)).toEqual({ ok: false, status: 405 });
      expect(classifyProxyRequest("DELETE", p)).toEqual({ ok: false, status: 405 });
      expect(classifyProxyRequest("PATCH", p)).toEqual({ ok: false, status: 405 });
    }
    expect(classifyProxyRequest("POST", RUNS)).toEqual({ ok: false, status: 405 });
    expect(classifyProxyRequest("DELETE", RUNS)).toEqual({ ok: false, status: 405 });
    expect(classifyProxyRequest("POST", OUTPUT)).toEqual({ ok: false, status: 405 });
    expect(classifyProxyRequest("PUT", OUTPUT)).toEqual({ ok: false, status: 405 });
  });
  it("noma'lum yo'l, noto'g'ri id va traversal: 404", () => {
    expect(classifyProxyRequest("POST", ["projects", ID, "deploy"])).toEqual({ ok: false, status: 404 });
    expect(classifyProxyRequest("POST", ["projects", ID, "deploy", "recipe"])).toEqual({ ok: false, status: 404 });
    expect(classifyProxyRequest("POST", ["projects", ID, "deploy", "run", "x"])).toEqual({ ok: false, status: 404 });
    expect(classifyProxyRequest("POST", ["projects", "x", "deploy", "run"])).toEqual({ ok: false, status: 404 });
    expect(classifyProxyRequest("GET", ["deploy", "runs", "x", "output"])).toEqual({ ok: false, status: 404 });
    expect(classifyProxyRequest("GET", ["deploy", "runs", CMD])).toEqual({ ok: false, status: 404 });
    expect(classifyProxyRequest("POST", ["projects", ID, "deploy", "..", "run"])).toEqual({ ok: false, status: 404 });
    expect(classifyProxyRequest("GET", ["deploy", "runs", "..", "output"])).toEqual({ ok: false, status: 404 });
    expect(classifyProxyRequest("POST", ["projects", ID, "deploy", "run\\x"])).toEqual({ ok: false, status: 404 });
    expect(classifyProxyRequest("POST", ["projects", ID, "deploy", "", "run"])).toEqual({ ok: false, status: 404 });
  });
  it("elevation: inspect YO'Q; run va rollback HAR DOIM (istisnosiz)", () => {
    expect(elevationFor("POST", INSPECT)).toBe("none");
    expect(elevationFor("POST", RUN)).toBe("required");
    expect(elevationFor("POST", ROLLBACK)).toBe("required");
    expect(elevationRequired(elevationFor("POST", INSPECT), {})).toBe(false);
    expect(elevationRequired(elevationFor("POST", RUN), { target: "prod" })).toBe(true);
    expect(elevationRequired(elevationFor("POST", ROLLBACK), {})).toBe(true);
    expect(elevationFor("GET", RUNS)).toBe("none");
    expect(elevationFor("GET", OUTPUT)).toBe("none");
  });
  it("Idempotency-Key: run/rollback oladi; inspect va o'qish olmaydi", () => {
    expect(needsIdempotencyKey(RUN)).toBe(true);
    expect(needsIdempotencyKey(ROLLBACK)).toBe(true);
    expect(needsIdempotencyKey(INSPECT)).toBe(false);
    expect(needsIdempotencyKey(RUNS)).toBe(false);
    expect(needsIdempotencyKey(OUTPUT)).toBe(false);
  });
  it("muddat: inspect agentni kutadi (60 s); run/rollback darhol qaytadi; tana kichik", () => {
    expect(proxyTimeoutFor(INSPECT)).toBe(PROXY_TIMEOUT_CONFIG_MS);
    expect(proxyTimeoutFor(RUN)).toBe(PROXY_TIMEOUT_DEFAULT_MS);
    expect(proxyTimeoutFor(ROLLBACK)).toBe(PROXY_TIMEOUT_DEFAULT_MS);
    expect(proxyTimeoutFor(RUNS)).toBe(PROXY_TIMEOUT_DEFAULT_MS);
    expect(proxyTimeoutFor(OUTPUT)).toBe(PROXY_TIMEOUT_DEFAULT_MS);
    for (const p of [INSPECT, RUN, ROLLBACK]) expect(maxBodyFor(p)).toBe(4096);
  });
});

describe("proxy: git checkpoint (6.9)", () => {
  it("ruxsat etilgan yo'llar: POST/PUT control, GET read", () => {
    expect(classifyProxyRequest("POST", CP_CREATE)).toEqual(ctl("POST"));
    expect(classifyProxyRequest("POST", CP_LIST)).toEqual(ctl("POST"));
    expect(classifyProxyRequest("POST", CP_RESTORE)).toEqual(ctl("POST"));
    expect(classifyProxyRequest("PUT", CP_SETTINGS)).toEqual(ctl("PUT"));
    expect(classifyProxyRequest("GET", CP_SETTINGS)).toEqual(READ);
  });
  it("noto'g'ri metod: 405", () => {
    for (const p of [CP_CREATE, CP_LIST, CP_RESTORE]) {
      expect(classifyProxyRequest("GET", p)).toEqual({ ok: false, status: 405 });
      expect(classifyProxyRequest("PUT", p)).toEqual({ ok: false, status: 405 });
      expect(classifyProxyRequest("DELETE", p)).toEqual({ ok: false, status: 405 });
    }
    expect(classifyProxyRequest("POST", CP_SETTINGS)).toEqual({ ok: false, status: 405 });
    expect(classifyProxyRequest("DELETE", CP_SETTINGS)).toEqual({ ok: false, status: 405 });
    expect(classifyProxyRequest("PATCH", CP_SETTINGS)).toEqual({ ok: false, status: 405 });
  });
  it("noma'lum yo'l va traversal: 404", () => {
    expect(classifyProxyRequest("POST", ["projects", ID, "checkpoints", "delete"])).toEqual({ ok: false, status: 404 });
    expect(classifyProxyRequest("POST", ["projects", ID, "checkpoints", "restore", "x"])).toEqual({ ok: false, status: 404 });
    expect(classifyProxyRequest("POST", ["projects", "x", "checkpoints"])).toEqual({ ok: false, status: 404 });
    expect(classifyProxyRequest("GET", ["checkpoints"])).toEqual({ ok: false, status: 404 });
    expect(classifyProxyRequest("GET", ["checkpoints", "other"])).toEqual({ ok: false, status: 404 });
    expect(classifyProxyRequest("POST", ["projects", ID, "checkpoints", "..", "restore"])).toEqual({ ok: false, status: 404 });
    expect(classifyProxyRequest("GET", ["checkpoints", "..", "settings"])).toEqual({ ok: false, status: 404 });
  });
  it("elevation: yaratish va ro'yxat YO'Q; restore va sozlamalarni yozish HAR DOIM", () => {
    expect(elevationFor("POST", CP_CREATE)).toBe("none");
    expect(elevationFor("POST", CP_LIST)).toBe("none");
    expect(elevationFor("POST", CP_RESTORE)).toBe("required");
    expect(elevationFor("PUT", CP_SETTINGS)).toBe("required");
    expect(elevationFor("GET", CP_SETTINGS)).toBe("none");
    expect(elevationRequired(elevationFor("POST", CP_RESTORE), {})).toBe(true);
    expect(elevationRequired(elevationFor("PUT", CP_SETTINGS), { bigTask: true })).toBe(true);
    expect(elevationRequired(elevationFor("POST", CP_CREATE), { label: "x" })).toBe(false);
  });
  it("Idempotency-Key: restore oladi; yaratish/ro'yxat/sozlama olmaydi", () => {
    expect(needsIdempotencyKey(CP_RESTORE)).toBe(true);
    expect(needsIdempotencyKey(CP_CREATE)).toBe(false);
    expect(needsIdempotencyKey(CP_LIST)).toBe(false);
    expect(needsIdempotencyKey(CP_SETTINGS)).toBe(false);
  });
  it("muddat: yaratish va ro'yxat agentni kutadi (60 s); restore va sozlama qisqa; tana kichik", () => {
    expect(proxyTimeoutFor(CP_CREATE)).toBe(PROXY_TIMEOUT_CONFIG_MS);
    expect(proxyTimeoutFor(CP_LIST)).toBe(PROXY_TIMEOUT_CONFIG_MS);
    expect(proxyTimeoutFor(CP_RESTORE)).toBe(PROXY_TIMEOUT_DEFAULT_MS);
    expect(proxyTimeoutFor(CP_SETTINGS)).toBe(PROXY_TIMEOUT_DEFAULT_MS);
    for (const p of [CP_CREATE, CP_LIST, CP_RESTORE, CP_SETTINGS]) expect(maxBodyFor(p)).toBe(4096);
  });
});
