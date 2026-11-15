import { describe, expect, it } from "vitest";
import { classifyProxyRequest, elevationFor, elevationRequired, isSameOrigin, maxBodyFor, needsIdempotencyKey } from "@/lib/proxy-rules";
import { filterSessions, isActiveSession } from "@/lib/sessions-view";
import { isHiddenMachine, shortSlug } from "@/lib/machines";
import type { SessionDto } from "@commander/contracts";

const ID = "11111111-1111-4111-8111-111111111111";

describe("classifyProxyRequest", () => {
  it("GET o'qish yo'llari read token bilan", () => {
    for (const p of [["machines"], ["sessions"], ["sessions", ID], ["sessions", ID, "events"], ["projects"], ["usage"], ["usage", "summary"], ["limits"], ["approvals"]]) {
      expect(classifyProxyRequest("GET", p)).toEqual({ ok: true, scope: "read", method: "GET" });
    }
  });
  it("decision faqat POST va approve token", () => {
    expect(classifyProxyRequest("POST", ["approvals", ID, "decision"])).toEqual({ ok: true, scope: "approve", method: "POST" });
    expect(classifyProxyRequest("GET", ["approvals", ID, "decision"])).toEqual({ ok: false, status: 405 });
  });
  it("noma'lum yo'l va traversal rad etiladi, o'qish yo'llariga POST yo'q", () => {
    expect(classifyProxyRequest("GET", ["devices", "me"])).toEqual({ ok: false, status: 404 });
    expect(classifyProxyRequest("GET", ["audit"])).toEqual({ ok: false, status: 404 });
    expect(classifyProxyRequest("GET", ["sessions", ".."])).toEqual({ ok: false, status: 404 });
    expect(classifyProxyRequest("POST", ["sessions"])).toEqual({ ok: false, status: 405 });
    expect(classifyProxyRequest("DELETE", ["machines"])).toEqual({ ok: false, status: 405 });
  });
});

describe("classifyProxyRequest: boshqaruv yo'llari", () => {
  it("POST commands va cancel faqat control token bilan", () => {
    expect(classifyProxyRequest("POST", ["commands"])).toEqual({ ok: true, scope: "control", method: "POST" });
    expect(classifyProxyRequest("POST", ["commands", ID, "cancel"])).toEqual({ ok: true, scope: "control", method: "POST" });
    // H-04/H-06: GET commands (tasdiq kutayotganlar ro'yxati) endi read token bilan ochiq
    expect(classifyProxyRequest("GET", ["commands"])).toEqual({ ok: true, scope: "read", method: "GET" });
    expect(classifyProxyRequest("GET", ["commands", ID, "cancel"])).toEqual({ ok: false, status: 405 });
  });
  it("buyruqlarni o'qish: GET commands/:id va sessions/:id/commands (read token)", () => {
    expect(classifyProxyRequest("GET", ["commands", ID])).toEqual({ ok: true, scope: "read", method: "GET" });
    expect(classifyProxyRequest("GET", ["sessions", ID, "commands"])).toEqual({ ok: true, scope: "read", method: "GET" });
    expect(classifyProxyRequest("POST", ["commands", ID])).toEqual({ ok: false, status: 405 });
  });
  it("noto'g'ri id, traversal va boshqa POST yo'llari rad etiladi", () => {
    expect(classifyProxyRequest("POST", ["commands", "x", "cancel"])).toEqual({ ok: false, status: 404 });
    expect(classifyProxyRequest("POST", ["commands", ID, "retry"])).toEqual({ ok: false, status: 404 });
    expect(classifyProxyRequest("POST", ["commands", "..", "cancel"])).toEqual({ ok: false, status: 404 });
    expect(classifyProxyRequest("POST", ["devices"])).toEqual({ ok: false, status: 404 });
  });
  it("tana chegarasi: buyruq yaratishda katta, qolganida kichik", () => {
    expect(maxBodyFor(["commands"])).toBeGreaterThan(16_000);
    expect(maxBodyFor(["commands", ID, "cancel"])).toBe(4096);
    expect(maxBodyFor(["approvals", ID, "decision"])).toBe(16 * 1024); // AskUserQuestion javoblari sig'sin (6.13)
  });
});

describe("classifyProxyRequest: loyiha va vazifa yo'llari", () => {
  it("GET projects/:id, /tasks, /commits va /tasks (read token)", () => {
    for (const p of [["projects", ID], ["projects", ID, "tasks"], ["projects", ID, "commits"], ["tasks"]]) {
      expect(classifyProxyRequest("GET", p)).toEqual({ ok: true, scope: "read", method: "GET" });
    }
  });
  it("yozish yo'q, noma'lum ichki yo'l va noto'g'ri id rad etiladi", () => {
    expect(classifyProxyRequest("POST", ["projects", ID])).toEqual({ ok: false, status: 405 });
    expect(classifyProxyRequest("POST", ["tasks"])).toEqual({ ok: false, status: 405 });
    expect(classifyProxyRequest("GET", ["projects", ID, "snapshots"])).toEqual({ ok: false, status: 404 });
    expect(classifyProxyRequest("GET", ["projects", "x", "tasks"])).toEqual({ ok: false, status: 404 });
    expect(classifyProxyRequest("GET", ["projects", "..", "tasks"])).toEqual({ ok: false, status: 404 });
  });
});

describe("classifyProxyRequest: ish maydoni (2.15)", () => {
  it("GET daily va md-files (read token)", () => {
    expect(classifyProxyRequest("GET", ["projects", ID, "daily"])).toEqual({ ok: true, scope: "read", method: "GET" });
    expect(classifyProxyRequest("GET", ["projects", ID, "md-files"])).toEqual({ ok: true, scope: "read", method: "GET" });
  });
  it("yozuvlar faqat POST/PATCH va control token bilan", () => {
    for (const p of [["projects", ID, "daily", "2026-11-13", "summary"], ["projects", ID, "md-extract"], ["projects", ID, "tasks", "append"], ["projects", ID, "refresh"]]) {
      expect(classifyProxyRequest("POST", p)).toEqual({ ok: true, scope: "control", method: "POST" });
      expect(classifyProxyRequest("GET", p)).toEqual({ ok: false, status: 405 });
    }
    expect(classifyProxyRequest("PATCH", ["projects", ID, "tasks", "2.15", "board"])).toEqual({ ok: true, scope: "control", method: "PATCH" });
    expect(classifyProxyRequest("POST", ["projects", ID, "tasks", "2.15", "board"])).toEqual({ ok: false, status: 405 });
    expect(classifyProxyRequest("GET", ["projects", ID, "tasks", "2.15", "board"])).toEqual({ ok: false, status: 405 });
  });
  it("noto'g'ri sana, vazifa id, id va traversal rad etiladi; boshqa PATCH yo'q", () => {
    expect(classifyProxyRequest("POST", ["projects", ID, "daily", "kecha", "summary"])).toEqual({ ok: false, status: 404 });
    expect(classifyProxyRequest("PATCH", ["projects", ID, "tasks", "A B", "board"])).toEqual({ ok: false, status: 404 });
    expect(classifyProxyRequest("PATCH", ["projects", ID, "tasks", "..", "board"])).toEqual({ ok: false, status: 404 });
    expect(classifyProxyRequest("PATCH", ["projects", "x", "tasks", "1", "board"])).toEqual({ ok: false, status: 404 });
    expect(classifyProxyRequest("PATCH", ["sessions", ID])).toEqual({ ok: false, status: 405 });
    expect(classifyProxyRequest("POST", ["projects", ID, "md-extract", "x"])).toEqual({ ok: false, status: 404 });
  });
  it("tana chegarasi: append katta, qolgan yozuvlar kichik; Idempotency-Key yaratiladigan yo'llar", () => {
    expect(maxBodyFor(["projects", ID, "tasks", "append"])).toBeGreaterThan(16_000);
    expect(maxBodyFor(["projects", ID, "md-extract"])).toBe(4096);
    expect(maxBodyFor(["projects", ID, "refresh"])).toBe(4096);
    expect(needsIdempotencyKey(["commands"])).toBe(true);
    expect(needsIdempotencyKey(["projects", ID, "tasks", "append"])).toBe(true);
    expect(needsIdempotencyKey(["projects", ID, "refresh"])).toBe(true);
    expect(needsIdempotencyKey(["projects", ID, "tasks"])).toBe(false);
  });
});

describe("classifyProxyRequest: sessiyalararo xabar (2.10)", () => {
  it("GET settings/groups/group/messages (read token)", () => {
    for (const n of ["settings", "groups", "group", "messages"]) expect(classifyProxyRequest("GET", ["messaging", n])).toEqual({ ok: true, scope: "read", method: "GET" });
  });
  it("yozuvlar: to'g'ri usul + control token", () => {
    const w = (method: string, path: string[]) => classifyProxyRequest(method, ["messaging", ...path]);
    expect(w("PUT", ["settings"])).toEqual({ ok: true, scope: "control", method: "PUT" });
    expect(w("PATCH", ["groups"])).toEqual({ ok: true, scope: "control", method: "PATCH" });
    expect(w("PUT", ["groups", "context"])).toEqual({ ok: true, scope: "control", method: "PUT" });
    expect(w("PUT", ["groups", "rules"])).toEqual({ ok: true, scope: "control", method: "PUT" });
    expect(w("PUT", ["sessions", ID, "role"])).toEqual({ ok: true, scope: "control", method: "PUT" });
    expect(w("PUT", ["links"])).toEqual({ ok: true, scope: "control", method: "PUT" });
    expect(w("DELETE", ["links"])).toEqual({ ok: true, scope: "control", method: "DELETE" });
    expect(w("POST", ["messages"])).toEqual({ ok: true, scope: "control", method: "POST" });
  });
  it("noto'g'ri usul 405, noma'lum yo'l/id/traversal 404", () => {
    expect(classifyProxyRequest("POST", ["messaging", "settings"])).toEqual({ ok: false, status: 405 });
    expect(classifyProxyRequest("DELETE", ["messaging", "messages"])).toEqual({ ok: false, status: 405 });
    expect(classifyProxyRequest("GET", ["messaging", "links"])).toEqual({ ok: false, status: 405 });
    expect(classifyProxyRequest("PUT", ["messaging", "sessions", "x", "role"])).toEqual({ ok: false, status: 404 });
    expect(classifyProxyRequest("GET", ["messaging", "admin"])).toEqual({ ok: false, status: 404 });
    expect(classifyProxyRequest("PUT", ["messaging", "..", "settings"])).toEqual({ ok: false, status: 404 });
  });
  it("tana chegaralari: kontekst katta, xabar/qoidalar o'rtacha, qolgani kichik", () => {
    expect(maxBodyFor(["messaging", "groups", "context"])).toBeGreaterThan(32_000);
    expect(maxBodyFor(["messaging", "messages"])).toBeGreaterThan(8_000);
    expect(maxBodyFor(["messaging", "groups", "rules"])).toBeGreaterThan(8_000);
    expect(maxBodyFor(["messaging", "settings"])).toBe(4096);
  });
});

describe("isSameOrigin", () => {
  it("Origin Host bilan mos bo'lishi shart", () => {
    expect(isSameOrigin("http://127.0.0.1:4318", "127.0.0.1:4318")).toBe(true);
    expect(isSameOrigin("http://evil.example", "127.0.0.1:4318")).toBe(false);
    expect(isSameOrigin(null, "127.0.0.1:4318")).toBe(false);
  });
});

describe("machines/sessions helpers", () => {
  it("legacy va nom bo'yicha yashirish", () => {
    const rules = { legacy: true, names: ["zz-test-0.6-host"] };
    expect(isHiddenMachine({ hostname: "x", slug: "x-1", identityStatus: "legacy_unverified" }, rules)).toBe(true);
    expect(isHiddenMachine({ hostname: "ZZ-test-0.6-host", slug: "q", identityStatus: "verified" }, rules)).toBe(true);
    expect(isHiddenMachine({ hostname: "mac", slug: "mac-1", identityStatus: "verified" }, rules)).toBe(false);
  });
  it("shortSlug", () => {
    expect(shortSlug("acmeapp-ai-" + "a1".repeat(32) + "-c5d25d")).toBe("acmeapp-ai");
    expect(shortSlug("plain")).toBe("plain");
  });
  it("faol sessiya va filtr", () => {
    const now = Date.parse("2026-11-13T12:00:00Z");
    const base = { endedAt: null, lastSeenAt: "2026-11-13T11:00:00Z" };
    expect(isActiveSession(base, now)).toBe(true);
    expect(isActiveSession({ ...base, lastSeenAt: "2026-11-12T11:00:00Z" }, now)).toBe(false);
    expect(isActiveSession({ ...base, endedAt: "2026-11-13T11:30:00Z" }, now)).toBe(false);
    const mk = (id: string, machineId: string, status: SessionDto["status"]) =>
      ({ id, machineId, status, projectName: "p" + id, machineName: "m", cwd: "/x", message: null, ...base }) as SessionDto;
    const list = [mk("1", "a", "working"), mk("2", "b", "waiting"), mk("3", "c", "working")];
    const out = filterSessions(list, { machineId: null, status: "working", text: "", showAll: false }, new Set(["c"]), now);
    expect(out.map((s) => s.id)).toEqual(["1"]);
  });
});

describe("classifyProxyRequest: avto-ruxsat qoidalari (2.13)", () => {
  it("GET read, POST/DELETE control token bilan; boshqa metodlar rad", () => {
    expect(classifyProxyRequest("GET", ["approval-rules"])).toEqual({ ok: true, scope: "read", method: "GET" });
    expect(classifyProxyRequest("POST", ["approval-rules"])).toEqual({ ok: true, scope: "control", method: "POST" });
    expect(classifyProxyRequest("DELETE", ["approval-rules", "42"])).toEqual({ ok: true, scope: "control", method: "DELETE" });
    expect(classifyProxyRequest("PUT", ["approval-rules"])).toEqual({ ok: false, status: 405 });
    expect(classifyProxyRequest("GET", ["approval-rules", "42"])).toEqual({ ok: false, status: 405 });
    expect(classifyProxyRequest("DELETE", ["approval-rules"])).toEqual({ ok: false, status: 405 });
    expect(classifyProxyRequest("DELETE", ["approval-rules", "abc"])).toEqual({ ok: false, status: 404 });
    expect(classifyProxyRequest("DELETE", ["approval-rules", "1", "x"])).toEqual({ ok: false, status: 404 });
  });
});

describe("classifyProxyRequest: ogohlantirishlar va hisobotlar (3.2/3.3)", () => {
  const read = { ok: true, scope: "read", method: "GET" };
  const control = (method: string) => ({ ok: true, scope: "control", method });
  it("GET o'qish yo'llari read token bilan", () => {
    for (const p of [["alerts"], ["watchdog", "settings"], ["reports"], ["reports", "settings"], ["reports", ID]]) {
      expect(classifyProxyRequest("GET", p)).toEqual(read);
    }
  });
  it("yozuvlar control token bilan", () => {
    expect(classifyProxyRequest("POST", ["alerts", ID, "dismiss"])).toEqual(control("POST"));
    expect(classifyProxyRequest("PUT", ["watchdog", "settings"])).toEqual(control("PUT"));
    expect(classifyProxyRequest("PUT", ["reports", "settings"])).toEqual(control("PUT"));
    expect(classifyProxyRequest("POST", ["reports", "generate"])).toEqual(control("POST"));
  });
  it("noto'g'ri metod 405", () => {
    expect(classifyProxyRequest("GET", ["alerts", ID, "dismiss"])).toEqual({ ok: false, status: 405 });
    expect(classifyProxyRequest("PUT", ["alerts", ID, "dismiss"])).toEqual({ ok: false, status: 405 });
    expect(classifyProxyRequest("POST", ["watchdog", "settings"])).toEqual({ ok: false, status: 405 });
    expect(classifyProxyRequest("DELETE", ["reports", "settings"])).toEqual({ ok: false, status: 405 });
    expect(classifyProxyRequest("GET", ["reports", "generate"])).toEqual({ ok: false, status: 405 });
    expect(classifyProxyRequest("POST", ["alerts"])).toEqual({ ok: false, status: 405 });
    expect(classifyProxyRequest("POST", ["reports", ID])).toEqual({ ok: false, status: 405 });
  });
  it("noma'lum yo'llar 404", () => {
    expect(classifyProxyRequest("GET", ["alerts", "x"])).toEqual({ ok: false, status: 404 });
    expect(classifyProxyRequest("POST", ["alerts", "abc", "dismiss"])).toEqual({ ok: false, status: 404 });
    expect(classifyProxyRequest("GET", ["watchdog"])).toEqual({ ok: false, status: 404 });
    expect(classifyProxyRequest("GET", ["reports", "x", "y"])).toEqual({ ok: false, status: 404 });
  });
  it("tana chegarasi: watchdog sozlamalari kattaroq", () => {
    expect(maxBodyFor(["watchdog", "settings"])).toBe(64 * 1024);
    expect(maxBodyFor(["reports", "settings"])).toBe(4096);
  });
});

describe("navbat (3.1)", () => {
  const ID = "11111111-1111-4111-8111-111111111111";
  it("GET read; POST/PATCH/DELETE/run-now/cancel control token bilan", () => {
    expect(classifyProxyRequest("GET", ["queue"])).toEqual({ ok: true, scope: "read", method: "GET" });
    expect(classifyProxyRequest("GET", ["queue", ID])).toEqual({ ok: true, scope: "read", method: "GET" });
    expect(classifyProxyRequest("POST", ["queue"])).toEqual({ ok: true, scope: "control", method: "POST" });
    expect(classifyProxyRequest("PATCH", ["queue", ID])).toEqual({ ok: true, scope: "control", method: "PATCH" });
    expect(classifyProxyRequest("DELETE", ["queue", ID])).toEqual({ ok: true, scope: "control", method: "DELETE" });
    expect(classifyProxyRequest("POST", ["queue", ID, "run-now"])).toEqual({ ok: true, scope: "control", method: "POST" });
    expect(classifyProxyRequest("POST", ["queue", ID, "cancel"])).toEqual({ ok: true, scope: "control", method: "POST" });
  });
  it("boshqa metodlar va yo'llar rad", () => {
    expect(classifyProxyRequest("PUT", ["queue"])).toEqual({ ok: false, status: 405 });
    expect(classifyProxyRequest("DELETE", ["queue"])).toEqual({ ok: false, status: 405 });
    expect(classifyProxyRequest("PUT", ["queue", ID])).toEqual({ ok: false, status: 405 });
    expect(classifyProxyRequest("GET", ["queue", ID, "run-now"])).toEqual({ ok: false, status: 405 });
    expect(classifyProxyRequest("POST", ["queue", ID, "other"])).toEqual({ ok: false, status: 404 });
    expect(classifyProxyRequest("GET", ["queue", "not-a-uuid"])).toEqual({ ok: false, status: 404 });
  });
  it("tana chegarasi: prompt uchun katta", () => {
    expect(maxBodyFor(["queue"])).toBe(64 * 1024);
    expect(maxBodyFor(["queue", ID])).toBe(64 * 1024);
    expect(maxBodyFor(["queue", ID, "cancel"])).toBe(4096);
  });
});

describe("shablonlar (3.4)", () => {
  const T = "11111111-1111-4111-8111-111111111111";
  it("GET ro'yxat/detal read; render read (POST); yozuvlar va send-prompt control", () => {
    expect(classifyProxyRequest("GET", ["templates"])).toEqual({ ok: true, scope: "read", method: "GET" });
    expect(classifyProxyRequest("GET", ["templates", T])).toEqual({ ok: true, scope: "read", method: "GET" });
    expect(classifyProxyRequest("POST", ["templates", T, "render"])).toEqual({ ok: true, scope: "read", method: "POST" });
    expect(classifyProxyRequest("POST", ["templates"])).toEqual({ ok: true, scope: "control", method: "POST" });
    expect(classifyProxyRequest("PATCH", ["templates", T])).toEqual({ ok: true, scope: "control", method: "PATCH" });
    expect(classifyProxyRequest("DELETE", ["templates", T])).toEqual({ ok: true, scope: "control", method: "DELETE" });
    expect(classifyProxyRequest("POST", ["templates", T, "send-prompt"])).toEqual({ ok: true, scope: "control", method: "POST" });
  });
  it("boshqa metodlar va yo'llar rad", () => {
    expect(classifyProxyRequest("PUT", ["templates"])).toEqual({ ok: false, status: 405 });
    expect(classifyProxyRequest("DELETE", ["templates"])).toEqual({ ok: false, status: 405 });
    expect(classifyProxyRequest("PUT", ["templates", T])).toEqual({ ok: false, status: 405 });
    expect(classifyProxyRequest("GET", ["templates", T, "render"])).toEqual({ ok: false, status: 405 });
    expect(classifyProxyRequest("GET", ["templates", T, "send-prompt"])).toEqual({ ok: false, status: 405 });
    expect(classifyProxyRequest("POST", ["templates", T, "other"])).toEqual({ ok: false, status: 404 });
    expect(classifyProxyRequest("GET", ["templates", "not-a-uuid"])).toEqual({ ok: false, status: 404 });
  });
  it("tana chegarasi (16 000 belgili matn) va send-prompt uchun Idempotency-Key", () => {
    expect(maxBodyFor(["templates"])).toBe(64 * 1024);
    expect(maxBodyFor(["templates", T])).toBe(64 * 1024);
    expect(needsIdempotencyKey(["templates", T, "send-prompt"])).toBe(true);
    expect(needsIdempotencyKey(["templates", T, "render"])).toBe(false);
  });
});

describe("H-04/H-06: buyruqni dashboard'da tasdiqlash", () => {
  it("commands/:id/confirm qayta ochildi (H-01/5.6): faqat POST va `approve` token; elevation talab qilinadi", () => {
    expect(classifyProxyRequest("POST", ["commands", ID, "confirm"])).toEqual({ ok: true, scope: "approve", method: "POST" });
    expect(classifyProxyRequest("GET", ["commands", ID, "confirm"])).toEqual({ ok: false, status: 405 });
    expect(classifyProxyRequest("DELETE", ["commands", ID, "confirm"])).toEqual({ ok: false, status: 405 });
    expect(classifyProxyRequest("POST", ["commands", "x", "confirm"])).toEqual({ ok: false, status: 404 });
    expect(elevationRequired(elevationFor("POST", ["commands", ID, "confirm"]), {})).toBe(true);
    expect(classifyProxyRequest("GET", ["commands"])).toEqual({ ok: true, scope: "read", method: "GET" });
    expect(classifyProxyRequest("POST", ["commands"])).toEqual({ ok: true, scope: "control", method: "POST" });
    expect(classifyProxyRequest("PUT", ["commands"])).toEqual({ ok: false, status: 405 });
  });
});

describe("loyiha qismlari (6.15) proxy yo'llari", () => {
  it("GET projects/:id/parts read token bilan", () => {
    expect(classifyProxyRequest("GET", ["projects", ID, "parts"])).toEqual({ ok: true, scope: "read", method: "GET" });
  });
  it("qism vazifasi kaliti (`slug:key`, `%3A` ham) bilan board PATCH ruxsat; noto'g'ri kalit rad", () => {
    for (const k of ["1.2", "ai-ml-services:1", "documentation~audit%3A12"]) {
      expect(classifyProxyRequest("PATCH", ["projects", ID, "tasks", k, "board"]).ok).toBe(true);
    }
    expect(classifyProxyRequest("PATCH", ["projects", ID, "tasks", "A:B", "board"]).ok).toBe(false);
  });
});
