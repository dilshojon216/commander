import type { GroupDto, GroupMember, MessageDto } from "@commander/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownView } from "@/components/MarkdownView";
import {
  EMPTY_COMPOSER,
  KIND_LABEL,
  STATUS_LABEL,
  buildFeed,
  buildRulesBody,
  buildSendBody,
  contextIssue,
  findProjectGroup,
  linkableFor,
  mergeOlder,
  messagingHttpErrorText,
  messagingWriteReason,
  overallStatus,
  roleBadge,
  roleBody,
  roleIssue,
  roleSelectValue,
  rowsFromRules,
  ruleIssues,
  slugWorkspace,
  targetOptions,
  upsertMessage,
} from "@/lib/messaging-view";

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function msg(n: number, over: Partial<MessageDto> = {}): MessageDto {
  return {
    id: U(n),
    groupKey: "github.com/o/r",
    batchId: U(1000 + n),
    fromSessionId: U(900),
    fromRole: "backend",
    fromLabel: "srv-01",
    toSessionId: U(800 + n),
    toRole: "frontend",
    toLabel: "mac",
    toTarget: "role:frontend",
    kind: "api_change",
    subject: `Mavzu ${n}`,
    body: "matn",
    replyTo: null,
    status: "pending",
    createdAt: `2026-11-13T10:0${n}:00.000Z`,
    deliveredAt: null,
    readAt: null,
    ...over,
  };
}
function member(n: number, over: Partial<GroupMember> = {}): GroupMember {
  return { sessionId: U(n), shortId: `abcd000${n}`, machineId: U(50), machineName: "mac", projectName: "proj", cwd: "/x", kind: "bg", status: "working", role: null, roleSource: null, taskKey: null, unread: 0, ...over };
}

describe("lenta modeli", () => {
  it("broadcast (bir batchId) bitta xabar, har qabul qiluvchi alohida holat bilan", () => {
    const b = U(2000);
    const feed = buildFeed([
      msg(1, { batchId: b, toRole: "frontend", status: "read", toTarget: "all", toLabel: "mac" }),
      msg(2, { batchId: b, toRole: "mobile", status: "delivered", toTarget: "all", toLabel: "win" }),
      msg(3, { batchId: b, toRole: "backend", status: "pending", toTarget: "all", toLabel: "srv" }),
    ]);
    expect(feed).toHaveLength(1);
    expect(feed[0].recipients.map((r) => r.statusLabel)).toEqual(["o'qildi", "yetkazildi", "kutmoqda"]);
    expect(feed[0].toSummary).toBe("hammasi (3)");
    expect(feed[0].overall).toBe("pending");
    expect(feed[0].kindLabel).toBe("API o'zgarishi");
  });
  it("tartib: yangisi birinchi; yakka manzil roli ko'rsatiladi", () => {
    const feed = buildFeed([msg(1), msg(3), msg(2)]);
    expect(feed.map((f) => f.subject)).toEqual(["Mavzu 3", "Mavzu 2", "Mavzu 1"]);
    expect(feed[0].toSummary).toBe("frontend");
  });
  it("javoblar ota ostida (eskidan yangiga); ota yuklanmagan bo'lsa 'javob: #id'", () => {
    const parent = msg(1);
    const r1 = msg(2, { replyTo: parent.id, kind: "answer", fromRole: "frontend" });
    const r2 = msg(3, { replyTo: parent.id, kind: "answer" });
    const orphan = msg(4, { replyTo: U(999) });
    const feed = buildFeed([r2, parent, orphan, r1]);
    const p = feed.find((f) => f.id === parent.id)!;
    expect(p.replies.map((r) => r.subject)).toEqual(["Mavzu 2", "Mavzu 3"]);
    expect(feed.map((f) => f.id)).not.toContain(r1.id);
    const o = feed.find((f) => f.id === orphan.id)!;
    expect(o.replyRef).toBe(`javob: #${U(999).slice(0, 8)}`);
  });
  it("holat xaritasi va tur belgilari", () => {
    expect(STATUS_LABEL).toEqual({ pending: "kutmoqda", delivered: "yetkazildi", read: "o'qildi" });
    expect(KIND_LABEL).toEqual({ api_change: "API o'zgarishi", question: "Savol", request: "So'rov", info: "Ma'lumot", answer: "Javob" });
    expect(overallStatus([{ status: "read" }, { status: "read" }])).toBe("read");
    expect(overallStatus([{ status: "read" }, { status: "delivered" }])).toBe("delivered");
  });
  it("jonli yangilanish: id bo'yicha almashadi (holat o'zgardi), yangisi boshiga; eski sahifa takrorsiz", () => {
    const a = msg(1);
    let l = upsertMessage([a], msg(2));
    expect(l.map((m) => m.id)).toEqual([U(2), U(1)]);
    l = upsertMessage(l, { ...a, status: "read", readAt: "2026-11-13T11:00:00.000Z" });
    expect(l).toHaveLength(2);
    expect(l.find((m) => m.id === a.id)?.status).toBe("read");
    expect(mergeOlder(l, [a, msg(5)]).map((m) => m.id)).toEqual([U(2), U(1), U(5)]);
  });
  it("tana xavfsiz markdown: raw HTML render bo'lmaydi", () => {
    const html = renderToStaticMarkup(<MarkdownView content={"**qalin** <script>alert(1)</script> <img src=x onerror=1>"} className="" />);
    expect(html).toContain("<strong>qalin</strong>");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
  });
});

describe("guruh topish va bog'lash", () => {
  const g = (key: string, baseKeys: string[], workspace: string | null = null): GroupDto => ({ key, label: key, baseKeys, workspace, enabled: false, autoWake: false, telegramQuestions: false, rules: [], contextLength: 0, contextUpdatedAt: null, members: [], unread: 0 });
  it("loyiha repoKey yoki project:<uuid> bo'yicha", () => {
    const groups = [g("github.com/o/a", ["github.com/o/a"]), g("workspace:w", ["github.com/o/b", `project:${U(7)}`], "w")];
    expect(findProjectGroup(groups, { id: U(1), repoKey: "github.com/o/a" })?.key).toBe("github.com/o/a");
    expect(findProjectGroup(groups, { id: U(7), repoKey: null })?.key).toBe("workspace:w");
    expect(findProjectGroup(groups, { id: U(8), repoKey: null })).toBeNull();
  });
  it("bog'lash ro'yxatidan guruhdagilar chiqariladi; workspace nomi slug", () => {
    const resp = { linkable: [{ baseKey: "a", label: "A", workspace: null }, { baseKey: "b", label: "B", workspace: null }] };
    expect(linkableFor(resp, g("k", ["a"])).map((l) => l.baseKey)).toEqual(["b"]);
    expect(linkableFor(resp, null)).toHaveLength(2);
    expect(slugWorkspace("Acme App AI!")).toBe("acme-app-ai");
    expect(slugWorkspace(".cmdr-live")).toBe("cmdr-live");
  });
});

describe("rol", () => {
  it("taxmin belgisi va select qiymati", () => {
    expect(roleBadge({ role: "backend", roleSource: "guess" })).toEqual({ text: "backend", guess: true });
    expect(roleBadge({ role: "frontend", roleSource: "owner" })).toEqual({ text: "frontend", guess: false });
    expect(roleBadge({ role: null, roleSource: null }).text).toBe("rol yo'q");
    expect(roleSelectValue({ role: "backend", roleSource: "guess" })).toBe("");
    expect(roleSelectValue({ role: "mobile", roleSource: "owner" })).toBe("mobile");
    expect(roleSelectValue({ role: "ml-ops", roleSource: "owner" })).toBe("__custom__");
  });
  it("rol tanasi: bo'sh = taxminga qaytish (null), band so'zlar rad", () => {
    expect(roleBody("")).toEqual({ role: null });
    expect(roleBody(" Backend ")).toEqual({ role: "backend" });
    expect(roleBody("owner")).toBeNull();
    expect(roleIssue("all")).toContain("band");
    expect(roleIssue("")).toBeNull();
  });
});

describe("yozuvchi (composer) tanasi", () => {
  const key = "github.com/o/r";
  it("manzillar: avto, hammasi, rollar, aniq sessiyalar", () => {
    const o = targetOptions([member(1, { role: "backend" }), member(2, { role: "backend" }), member(3, { role: "frontend" }), member(4)]);
    expect(o.map((x) => x.value)).toEqual(["auto", "all", "backend", "frontend", "abcd0001", "abcd0002", "abcd0003", "abcd0004"]);
    expect(o[0].label).toContain("Avto");
  });
  it("to'g'ri tana", () => {
    const r = buildSendBody(key, { ...EMPTY_COMPOSER, to: "frontend", kind: "question", subject: " Sahifalash? ", body: "cursor yoki offset?" });
    expect(r).toEqual({ ok: true, body: { key, to: "frontend", kind: "question", subject: "Sahifalash?", body: "cursor yoki offset?" } });
  });
  it("javob: replyTo qo'shiladi", () => {
    const r = buildSendBody(key, { ...EMPTY_COMPOSER, to: "all", kind: "answer", subject: "Re: x", body: "ok", replyTo: U(5) });
    expect(r.ok && r.body.replyTo).toBe(U(5));
  });
  it("xatolar: mavzu/matn bo'sh yoki uzun", () => {
    expect(buildSendBody(key, { ...EMPTY_COMPOSER, subject: " ", body: "x" })).toEqual({ ok: false, error: "Mavzuni kiriting" });
    expect(buildSendBody(key, { ...EMPTY_COMPOSER, subject: "s", body: " " })).toEqual({ ok: false, error: "Xabar matnini kiriting" });
    expect(buildSendBody(key, { ...EMPTY_COMPOSER, subject: "s".repeat(121), body: "x" }).ok).toBe(false);
    expect(buildSendBody(key, { ...EMPTY_COMPOSER, subject: "s", body: "x".repeat(4001) }).ok).toBe(false);
  });
});

describe("qoidalar muharriri tanasi", () => {
  const key = "github.com/o/r";
  it("tartib saqlanadi, bo'sh maydonlar tushadi, rol kichik harf", () => {
    const body = buildRulesBody(key, [
      { kind: "api_change", keyword: "", toRole: "Frontend" },
      { kind: "", keyword: " pdf ", toRole: "backend" },
      { kind: "question", keyword: "db", toRole: "backend" },
    ]);
    expect(body).toEqual({ key, rules: [{ kind: "api_change", toRole: "frontend" }, { keyword: "pdf", toRole: "backend" }, { kind: "question", keyword: "db", toRole: "backend" }] });
  });
  it("tur ham kalit so'z ham yo'q yoki rol yaroqsiz bo'lsa null va xato ko'rsatiladi", () => {
    const rows = [{ kind: "" as const, keyword: "", toRole: "backend" }, { kind: "info" as const, keyword: "", toRole: "owner" }];
    expect(buildRulesBody(key, rows)).toBeNull();
    const msgs = ruleIssues(rows).map((i) => [i.index, i.message]);
    expect(msgs).toContainEqual([0, "Tur yoki kalit so'z kerak"]);
    expect(msgs).toContainEqual([1, "Qabul qiluvchi rol noto'g'ri"]);
  });
  it("bo'sh ro'yxat yaroqli (qoidalarni tozalash); 20 tadan ko'p rad; rowsFromRules aylanishi", () => {
    expect(buildRulesBody(key, [])).toEqual({ key, rules: [] });
    expect(buildRulesBody(key, Array.from({ length: 21 }, () => ({ kind: "info" as const, keyword: "", toRole: "a" })))).toBeNull();
    expect(rowsFromRules([{ kind: "info", toRole: "mobile" }, { keyword: "x", toRole: "a" }])).toEqual([{ kind: "info", keyword: "", toRole: "mobile" }, { kind: "", keyword: "x", toRole: "a" }]);
  });
  it("kontekst chegarasi", () => {
    expect(contextIssue("x".repeat(16000))).toBeNull();
    expect(contextIssue("x".repeat(16001))).toContain("16000");
  });
});

describe("xatolar va yozish huquqi", () => {
  it("xato kodlari o'zbekcha", () => {
    expect(messagingHttpErrorText(409, { error: "messaging_disabled" })).toContain("o'chiq");
    expect(messagingHttpErrorText(429, { error: "rate_limited" })).toContain("Juda ko'p");
    expect(messagingHttpErrorText(400, { error: "no_rule_matched" })).toContain("qoidalar");
    expect(messagingHttpErrorText(400, { error: "unknown_target" })).toContain("topilmadi");
    expect(messagingHttpErrorText(404, null)).toContain("topilmadi");
    expect(messagingHttpErrorText(403, { error: "lockdown" })).toContain("Lockdown");
  });
  it("lockdown / token sababi", () => {
    expect(messagingWriteReason({ lockdown: false, canControl: true })).toBeNull();
    expect(messagingWriteReason({ lockdown: true, canControl: true })).toContain("Lockdown");
    expect(messagingWriteReason({ lockdown: false, canControl: false })).toContain("COMMANDER_CONTROL_TOKEN");
  });
});
