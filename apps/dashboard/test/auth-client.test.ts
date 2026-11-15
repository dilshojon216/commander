import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch, authErrorText, registerReauthHandler, setCsrf } from "@/lib/auth-client";

function res(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  setCsrf("CSRF1");
  registerReauthHandler(null);
});
afterEach(() => vi.unstubAllGlobals());

describe("apiFetch", () => {
  it("o'zgartiruvchi so'rovga CSRF sarlavhasi qo'shadi, GET'ga yo'q", async () => {
    fetchMock.mockResolvedValue(res(200, {}));
    await apiFetch("/api/c/commands", { method: "POST", body: "{}" });
    await apiFetch("/api/c/machines");
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("x-csrf-token")).toBe("CSRF1");
    expect(new Headers(fetchMock.mock.calls[1][1]?.headers).get("x-csrf-token")).toBeNull();
  });
  it("reauth_required: oyna ochiladi, tasdiqlansa so'rov BIR marta qayta yuboriladi", async () => {
    const handler = vi.fn(async () => true);
    registerReauthHandler(handler);
    fetchMock.mockResolvedValueOnce(res(401, { error: "reauth_required" })).mockResolvedValueOnce(res(200, { ok: 1 }));
    const r = await apiFetch("/api/c/commands", { method: "POST", body: "{}", headers: { "Idempotency-Key": "abcdefgh-1234" } });
    expect(r.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // qayta yuborishda Idempotency-Key saqlanadi
    expect(new Headers(fetchMock.mock.calls[1][1]?.headers).get("Idempotency-Key")).toBe("abcdefgh-1234");
  });
  it("reauth bekor qilinsa qayta yuborilmaydi (401 qaytadi)", async () => {
    registerReauthHandler(async () => false);
    fetchMock.mockResolvedValueOnce(res(401, { error: "reauth_required" }));
    const r = await apiFetch("/api/c/commands", { method: "POST", body: "{}" });
    expect(r.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("reauth qayta ham reauth_required qaytarsa tsikl yo'q (faqat bir marta qayta yuboriladi)", async () => {
    const handler = vi.fn(async () => true);
    registerReauthHandler(handler);
    fetchMock.mockResolvedValue(res(401, { error: "reauth_required" }));
    const r = await apiFetch("/api/c/commands", { method: "POST", body: "{}" });
    expect(r.status).toBe(401);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("403 csrf: token yangilanib bir marta qayta uriniladi", async () => {
    fetchMock
      .mockResolvedValueOnce(res(403, { error: "csrf" }))
      .mockResolvedValueOnce(res(200, { authenticated: true, csrf: "CSRF2" })) // /api/auth/session
      .mockResolvedValueOnce(res(200, {}));
    const r = await apiFetch("/api/c/commands", { method: "POST", body: "{}" });
    expect(r.status).toBe(200);
    expect(new Headers(fetchMock.mock.calls[2][1]?.headers).get("x-csrf-token")).toBe("CSRF2");
  });
});

describe("authErrorText", () => {
  it("xato kodlari o'zbekcha matnga aylanadi", () => {
    expect(authErrorText("invalid_credentials")).toContain("Parol");
    expect(authErrorText("rate_limited", 300_000)).toContain("5 daqiqa");
    expect(authErrorText("setup_code_unavailable")).toContain("terminalda");
    expect(authErrorText(undefined)).toBe("Kirish amalga oshmadi");
  });
});
