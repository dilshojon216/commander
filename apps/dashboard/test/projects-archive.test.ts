import type { ProjectDto, TokenTotals } from "@commander/contracts";
import { describe, expect, it } from "vitest";
import { classifyProxyRequest, elevationFor, elevationRequired, maxBodyFor, needsIdempotencyKey } from "@/lib/proxy-rules";
import { OTHERS_ROW_KEY, archiveActionLabel, archiveErrorText, archivePath, archivedToggleLabel, showArchivedToggle, todayTokensByMachine, topProjectsToday } from "@/lib/projects-view";

const ID = "123e4567-e89b-42d3-a456-426614174000";
const seg = (p: string) => p.split("/");

const totals = (n: number, requests = 1): TokenTotals => ({ inputTokens: n, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: n, costUsd: null, requests });
const proj = (id: string, name: string, today: number, machineId = "m1", archivedAt: string | null = null): ProjectDto => ({
  id, machineId, machineSlug: machineId, name, path: `/${name}`, repoKey: null, kind: "dir", today: totals(today), allTime: totals(today), firstUsedAt: null, lastUsedAt: null, openSessions: 0, archivedAt,
});

describe("loyiha arxivi: proksi qoidalari (6.16)", () => {
  it.each(["archive", "unarchive"])("POST projects/:id/%s = control + elevation (fail-closed)", (action) => {
    const p = seg(`projects/${ID}/${action}`);
    expect(classifyProxyRequest("POST", p)).toEqual({ ok: true, scope: "control", method: "POST" });
    expect(elevationRequired(elevationFor("POST", p), {})).toBe(true);
    expect(needsIdempotencyKey(p)).toBe(false);
    expect(maxBodyFor(p)).toBeLessThan(10_000);
  });

  it("boshqa usullar, noto'g'ri id va noma'lum amal rad etiladi", () => {
    for (const m of ["GET", "PUT", "PATCH", "DELETE"]) expect(classifyProxyRequest(m, seg(`projects/${ID}/archive`)), m).toMatchObject({ ok: false });
    expect(classifyProxyRequest("POST", seg("projects/x/archive"))).toMatchObject({ ok: false, status: 404 });
    expect(classifyProxyRequest("POST", seg(`projects/${ID}/delete`))).toMatchObject({ ok: false });
    expect(classifyProxyRequest("POST", seg(`projects/${ID}/archive/x`))).toMatchObject({ ok: false });
    expect(classifyProxyRequest("POST", seg(`projects/${ID}/../archive`))).toMatchObject({ ok: false });
  });

  it("GET /projects (?archived=1 query bilan) read token bilan o'tadi", () => {
    expect(classifyProxyRequest("GET", ["projects"])).toEqual({ ok: true, scope: "read", method: "GET" });
  });
});

describe("loyiha arxivi: yorliqlar va yo'l", () => {
  it("amal yorlig'i va yo'l", () => {
    expect(archiveActionLabel(null)).toBe("Arxivlash");
    expect(archiveActionLabel("2026-11-14T00:00:00.000Z")).toBe("Arxivdan chiqarish");
    expect(archivePath(ID, true)).toBe(`/projects/${ID}/archive`);
    expect(archivePath(ID, false)).toBe(`/projects/${ID}/unarchive`);
  });

  it("'Arxivlanganlar (N)' tugmasi: bo'sh arxivda yashirin, ochiq bo'lsa doim ko'rinadi", () => {
    expect(archivedToggleLabel(3, false)).toBe("Arxivlanganlar (3)");
    expect(archivedToggleLabel(3, true)).toBe("Faol loyihalar");
    expect(showArchivedToggle(0, false)).toBe(false);
    expect(showArchivedToggle(2, false)).toBe(true);
    expect(showArchivedToggle(0, true)).toBe(true);
  });

  it("xato matnlari", () => {
    expect(archiveErrorText({ status: 404 }, true)).toMatch(/topilmadi/);
    expect(archiveErrorText({ status: 403 }, true)).toMatch(/Ruxsat/);
    expect(archiveErrorText(new Error("x"), true)).toBe("Loyihani arxivlab bo'lmadi");
    expect(archiveErrorText(new Error("x"), false)).toBe("Loyihani arxivdan chiqarib bo'lmadi");
  });
});

describe("arxivlangan loyiha tokenlari hisobda qoladi, reytingda yo'q", () => {
  const items = [proj("a", "alpha", 500), proj("b", "beta", 300, "m2"), proj("z", "zero", 0), proj("x", "stale", 999, "m1", "2026-11-14T00:00:00.000Z")];

  it("topProjectsToday: faol loyihalar tartibda, arxivlangan 'Boshqalar' qatoriga jamlanadi", () => {
    const rows = topProjectsToday(items, { today: totals(40, 3) });
    expect(rows.map((r) => r.name)).toEqual(["alpha", "beta", "Boshqalar (arxivlangan)"]);
    const others = rows.at(-1)!;
    expect(others).toMatchObject({ key: OTHERS_ROW_KEY, tokens: 40, requests: 3, projectId: null });
  });

  it("arxivlangan bo'lmasa 'Boshqalar' yo'q; limit loyiha qatorlariga tegadi", () => {
    expect(topProjectsToday(items, null).map((r) => r.name)).toEqual(["alpha", "beta"]);
    expect(topProjectsToday(items, { today: totals(0) }).map((r) => r.name)).toEqual(["alpha", "beta"]);
    expect(topProjectsToday(items, { today: totals(40) }, 1).map((r) => r.name)).toEqual(["alpha", "Boshqalar (arxivlangan)"]);
  });

  it("todayTokensByMachine: arxiv hissasi mashina jamiga qo'shiladi", () => {
    const m = todayTokensByMachine(items.filter((p) => p.archivedAt === null), { todayByMachine: [{ machineId: "m1", totalTokens: 40 }, { machineId: "m3", totalTokens: 7 }] });
    expect(m.get("m1")).toBe(540);
    expect(m.get("m2")).toBe(300);
    expect(m.get("m3")).toBe(7);
    expect(todayTokensByMachine([], undefined).size).toBe(0);
  });
});
