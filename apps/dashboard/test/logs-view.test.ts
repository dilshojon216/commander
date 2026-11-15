import type { LogsReadResponse } from "@commander/contracts";
import { LOG_ASK_LIMITS } from "@commander/contracts";
import { describe, expect, it } from "vitest";
import { LOG_CLIENT_CAP, backoffDelay, buildAskPrompt, buildDownloadText, buildNameSuggestions, buildStartBody, defaultLogsForm, downloadFileName, filterLines, initialLogState, limitForAsk, logErrorText, logHttpErrorText, logNotes, logReducer, pendingCount, selectLine, selectedLines, streamStateLabel, visibleLines } from "@/lib/logs-view";
import type { LogViewState, LogsForm } from "@/lib/logs-view";

const ID = "11111111-1111-4111-8111-111111111111";
const read = (over: Partial<LogsReadResponse> = {}): LogsReadResponse => ({ commandId: ID, state: "live", lines: [], nextSeq: 0, dropped: 0, truncated: false, reason: null, error: null, ...over });
const lines = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `qator ${from + i}`);
const apply = (s: LogViewState, ...rs: Partial<LogsReadResponse>[]) => rs.reduce((acc, r) => logReducer(acc, { type: "read", response: read(r) }), s);

describe("logReducer", () => {
  it("qatorlarni id bilan qo'shadi va kursorni oshiradi", () => {
    const s = apply(initialLogState, { lines: ["a", "b"], nextSeq: 2 }, { lines: ["c"], nextSeq: 3 });
    expect(s.lines.map((l) => [l.id, l.text])).toEqual([[0, "a"], [1, "b"], [2, "c"]]);
    expect(s.nextSeq).toBe(3);
    expect(s.state).toBe("live");
  });
  it("kursor orqaga ketmaydi", () => {
    expect(apply(initialLogState, { nextSeq: 10 }, { nextSeq: 4 }).nextSeq).toBe(10);
  });
  it("5000 qatordan oshsa eng eskilari tashlanadi va hisoblanadi", () => {
    const s = apply(initialLogState, { lines: lines(4000) }, { lines: lines(2000, 4000) });
    expect(s.lines).toHaveLength(LOG_CLIENT_CAP);
    expect(s.clientTrimmed).toBe(1000);
    expect(s.lines[0]?.text).toBe("qator 1000");
    expect(s.lines.at(-1)?.text).toBe("qator 5999");
    // id'lar o'sishda davom etadi (barqaror key)
    expect(s.lines.at(-1)?.id).toBe(5999);
  });
  it("bitta sahifa chegaradan katta bo'lsa ham xavfsiz", () => {
    const s = apply(initialLogState, { lines: lines(LOG_CLIENT_CAP + 10) });
    expect(s.lines).toHaveLength(LOG_CLIENT_CAP);
    expect(s.clientTrimmed).toBe(10);
    expect(s.lines.at(-1)?.id).toBe(LOG_CLIENT_CAP + 9);
  });
  it("dropped yig'iladi, truncated yopishqoq, tugash sababi va xato saqlanadi", () => {
    const s = apply(initialLogState, { dropped: 3, truncated: true }, { dropped: 2 }, { state: "error", reason: "error", error: { code: "logs_not_found", message: "x" } }, { state: "done", reason: null, error: null });
    expect(s.dropped).toBe(5);
    expect(s.truncated).toBe(true);
    expect(s.reason).toBe("error");
    expect(s.error?.code).toBe("logs_not_found");
    expect(s.state).toBe("done");
  });
  it("clear qatorlarni tozalaydi, kursorni saqlaydi (qatorlar qayta kelmaydi)", () => {
    const s = logReducer(apply(initialLogState, { lines: ["a"], nextSeq: 5 }), { type: "clear" });
    expect(s.lines).toEqual([]);
    expect(s.nextSeq).toBe(5);
    expect(logReducer(s, { type: "reset" })).toEqual(initialLogState);
  });
});

describe("pauza va filtr", () => {
  const s = apply(initialLogState, { lines: ["INFO a", "ERROR b", "info c"] });
  it("pauza paytida yangi qatorlar ko'rinmaydi, lekin yo'qolmaydi", () => {
    const paused = s.nextId;
    const more = apply(s, { lines: ["d", "e"] });
    expect(visibleLines(more.lines, paused).map((l) => l.text)).toEqual(["INFO a", "ERROR b", "info c"]);
    expect(pendingCount(more.lines, paused)).toBe(2);
    expect(visibleLines(more.lines, null)).toHaveLength(5);
    expect(pendingCount(more.lines, null)).toBe(0);
  });
  it("filtr katta-kichik harfga e'tiborsiz", () => {
    expect(filterLines(s.lines, "info").map((l) => l.text)).toEqual(["INFO a", "info c"]);
    expect(filterLines(s.lines, "  ")).toHaveLength(3);
    expect(filterLines(s.lines, "zzz")).toEqual([]);
  });
});

describe("yorliqlar va xatolar", () => {
  it("oqim holati", () => {
    expect(streamStateLabel(null, null)).toBe("Boshlanmagan");
    expect(streamStateLabel("starting", null)).toContain("Ulanmoqda");
    expect(streamStateLabel("live", null)).toBe("Jonli");
    expect(streamStateLabel("done", "timeout")).toContain("10 daqiqa");
    expect(streamStateLabel("done", null)).toBe("Tugadi");
    expect(streamStateLabel("error", "error")).toBe("Xato");
  });
  it("buyruq xato kodlari o'zbekcha va yo'riqnoma bilan", () => {
    expect(logErrorText("logs_not_allowed")).toContain("agentd policy allow-log-root");
    expect(logErrorText("action_not_allowed")).toContain("agentd policy allow-logs");
    expect(logErrorText("logs_not_found")).toContain("topilmadi");
    expect(logErrorText("logs_source_unavailable")).toContain("mavjud emas");
    expect(logErrorText("machine_offline")).toContain("oflayn");
    expect(logErrorText("agent_outdated")).toContain("yangilang");
    expect(logErrorText("policy_disabled")).toContain("agentd policy enable");
    expect(logErrorText("zzz", "agent aytdi")).toContain("zzz");
    expect(logErrorText("zzz", "agent aytdi")).toContain("agent aytdi");
    expect(logErrorText(null)).toContain("olib bo'lmadi");
  });
  it("HTTP xatolari", () => {
    expect(logHttpErrorText(429, { error: "logs_busy" })).toContain("ko'p log oqimi");
    expect(logHttpErrorText(429, { error: "rate_limited" })).toContain("tez-tez");
    expect(logHttpErrorText(403, null)).toContain("Ruxsat");
    expect(logHttpErrorText(0, null)).toContain("Tarmoq");
    expect(logHttpErrorText(400, null)).toContain("noto'g'ri");
  });
  it("eslatmalar", () => {
    expect(logNotes({ dropped: 0, truncated: false, clientTrimmed: 0 })).toEqual([]);
    const n = logNotes({ dropped: 4, truncated: true, clientTrimmed: 7 });
    expect(n).toHaveLength(3);
    expect(n[1]).toContain("4 qator");
  });
  it("backoff: 1,2,4,8 s, eng ko'pi 10 s", () => {
    expect([0, 1, 2, 3, 4, 9].map(backoffDelay)).toEqual([1000, 2000, 4000, 8000, 10_000, 10_000]);
  });
});

describe("forma", () => {
  const f = (over: Partial<LogsForm>): LogsForm => ({ ...defaultLogsForm, ...over });
  it("to'g'ri forma tanaga aylanadi (since/follow ixtiyoriy)", () => {
    expect(buildStartBody(f({ name: " web " })).body).toEqual({ source: "docker", name: "web", lines: 200, follow: true });
    expect(buildStartBody(f({ name: "nginx.service", source: "journal", since: "10m", follow: false, lines: 500 })).body).toEqual({ source: "journal", name: "nginx.service", lines: 500, since: "10m" });
    expect(buildStartBody(f({ name: "/var/log/syslog", source: "file" })).error).toBeNull();
  });
  it("noto'g'ri qiymatlar rad etiladi", () => {
    expect(buildStartBody(f({ name: "" })).error).toContain("Nomni");
    expect(buildStartBody(f({ name: "", source: "file" })).error).toContain("Fayl");
    expect(buildStartBody(f({ name: "--all" })).body).toBeNull();
    expect(buildStartBody(f({ name: "a b" })).body).toBeNull();
    expect(buildStartBody(f({ name: "var/log/x", source: "file" })).body).toBeNull();
    expect(buildStartBody(f({ name: "/var/log/../etc/passwd", source: "file" })).body).toBeNull();
    expect(buildStartBody(f({ name: "web", since: "kecha" })).error).toContain("Vaqt");
    expect(buildStartBody(f({ name: "web", lines: 5000 })).error).toContain("2000");
    expect(buildStartBody(f({ name: "web", lines: 0 })).body).toBeNull();
  });
  it("nom takliflari", () => {
    const c = [{ name: "b", state: "exited" }, { name: "a", state: "running" }, { name: "a", state: "running" }, { name: "c", state: "running" }];
    expect(buildNameSuggestions("docker", c, ["x.service"])).toEqual(["a", "c", "b"]);
    expect(buildNameSuggestions("journal", c, ["z.service", "x.service", "x.service"])).toEqual(["x.service", "z.service"]);
    expect(buildNameSuggestions("file", c, ["x"])).toEqual([]);
  });
});

describe("tanlov va so'rash", () => {
  const vis = apply(initialLogState, { lines: lines(10) }).lines;
  it("bosish va Shift oralig'i", () => {
    let sel = selectLine(null, 3, false);
    expect(sel).toEqual({ anchor: 3, focus: 3 });
    expect(selectLine(sel, 3, false)).toBeNull();
    sel = selectLine(sel, 6, true);
    expect(selectedLines(vis, sel).map((l) => l.id)).toEqual([3, 4, 5, 6]);
    expect(selectedLines(vis, selectLine({ anchor: 6, focus: 6 }, 2, true)).map((l) => l.id)).toEqual([2, 3, 4, 5, 6]);
    expect(selectLine(null, 4, true)).toEqual({ anchor: 4, focus: 4 });
    expect(selectedLines(vis, null)).toEqual([]);
    expect(selectedLines(vis, { anchor: 99, focus: 2 })).toEqual([]);
  });
  it("filtrlangan ro'yxatda oraliq faqat ko'rinadigan qatorlar", () => {
    const filtered = vis.filter((l) => l.id % 2 === 0);
    expect(selectedLines(filtered, { anchor: 2, focus: 6 }).map((l) => l.id)).toEqual([2, 4, 6]);
  });
  it("200 qator chegarasi: oxirgi qatorlar qoladi", () => {
    const r = limitForAsk(lines(500));
    expect(r.lines).toHaveLength(LOG_ASK_LIMITS.maxLines);
    expect(r.truncated).toBe(true);
    expect(r.lines.at(-1)).toBe("qator 499");
    expect(r.originalCount).toBe(500);
  });
  it("8000 belgi chegarasi", () => {
    const r = limitForAsk(Array.from({ length: 150 }, () => "x".repeat(99)));
    expect(r.lines.join("\n").length).toBeLessThanOrEqual(LOG_ASK_LIMITS.maxChars);
    expect(r.lines.length).toBeLessThan(150);
    expect(r.truncated).toBe(true);
  });
  it("bitta juda uzun qator kesiladi; kichik tanlov kesilmaydi", () => {
    const one = limitForAsk(["y".repeat(20_000)]);
    expect(one.lines[0]?.length).toBeLessThanOrEqual(LOG_ASK_LIMITS.maxChars);
    expect(one.truncated).toBe(true);
    expect(limitForAsk(["a", "b"])).toEqual({ lines: ["a", "b"], truncated: false, originalCount: 2 });
  });
  it("prompt: iqtibos bloki, plan (faqat o'qish) ko'rsatmasi", () => {
    const p = buildAskPrompt({ source: "docker", name: "web", machineLabel: "srv1" }, limitForAsk(["boom", "bam"]));
    expect(p).toContain("> boom\n> bam");
    expect(p).toContain("srv1");
    expect(p).toContain('"web"');
    expect(p).toContain("Hech narsani o'zgartirma");
    const t = buildAskPrompt({ source: "file", name: "/x", machineLabel: "m" }, limitForAsk(lines(300)));
    expect(t).toContain("oxirgi 200 tasi");
    expect(p.length).toBeLessThan(16_000);
  });
});

describe("yuklab olish", () => {
  it("matn: har qator \\n bilan, bo'sh = bo'sh", () => {
    expect(buildDownloadText([{ text: "a" }, { text: "b" }])).toBe("a\nb\n");
    expect(buildDownloadText([])).toBe("");
  });
  it("fayl nomi xavfsiz", () => {
    const d = new Date("2026-11-14T10:20:30.456Z");
    expect(downloadFileName("docker", "my app/..", d)).toMatch(/^docker-[A-Za-z0-9_.@-]+-20261114T102030Z\.txt$/);
    expect(downloadFileName("file", "/var/log/syslog", d)).toBe("file-syslog-20261114T102030Z.txt");
    expect(downloadFileName("journal", "///", d)).toBe("journal-log-20261114T102030Z.txt");
  });
});
