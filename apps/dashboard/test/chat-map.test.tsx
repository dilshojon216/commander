import type { ChatItem as W } from "@commander/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatStream } from "@/components/chat/ChatStream";
import { INITIAL_STORE, buildView, chatReducer, upsertItems } from "@/lib/chat-map";
import { checkChatParams, isUuid, isValidCursor } from "@/lib/chat-route";

const U = "11111111-1111-4111-8111-111111111111";
const user = (id: string, text: string, ts = 1000): W => ({ id, ts, kind: "user", text });
const asst = (id: string, text: string, requestId?: string): W => ({ id, ts: 2000, kind: "assistant", text, ...(requestId ? { requestId } : {}) });
const use = (id: string, toolUseId: string, summary: string, requestId?: string, lines?: { added: number; removed: number }): W => ({
  id,
  ts: 2100,
  kind: "tool_use",
  toolUseId,
  toolName: summary.split(":")[0],
  summary,
  ...(lines ? { lines } : {}),
  ...(requestId ? { requestId } : {}),
});
const res = (id: string, toolUseId: string, ok = true, text = "out", truncated = false): W => ({ id, ts: 2200, kind: "tool_result", toolUseId, ok, text, truncated });
const usage = (requestId: string, out: number): W => ({ id: `usage:${requestId}`, ts: 2300, kind: "usage", requestId, inputTokens: 1, outputTokens: out, cacheReadTokens: 100, cacheCreationTokens: 10 });

describe("upsert / reducer", () => {
  it("bir xil id joyida almashadi, yangisi oxiriga", () => {
    const a = upsertItems([], [user("1", "a"), asst("2", "x")]);
    const b = upsertItems(a, [asst("2", "xy"), user("3", "c")]);
    expect(b.map((i) => i.id)).toEqual(["1", "2", "3"]);
    expect((b[1] as { text: string }).text).toBe("xy");
  });
  it("replace to'liq almashtiradi, older boshiga qo'shadi (takrorsiz), cursor yangilanadi", () => {
    let s = chatReducer(INITIAL_STORE, { type: "items", payload: { items: [user("5", "e"), asst("6", "f")], replace: true, cursor: "c1" } });
    expect(s.raw.map((i) => i.id)).toEqual(["5", "6"]);
    expect(s.cursor).toBe("c1");
    s = chatReducer(s, { type: "loading-older", value: true });
    s = chatReducer(s, { type: "items", payload: { items: [user("3", "c"), user("4", "d"), user("5", "dup")], older: true, cursor: null } });
    expect(s.raw.map((i) => i.id)).toEqual(["3", "4", "5", "6"]);
    expect((s.raw[2] as { text: string }).text).toBe("e");
    expect(s.cursor).toBeNull();
    expect(s.loadingOlder).toBe(false);
    s = chatReducer(s, { type: "items", payload: { items: [user("9", "z")], replace: true } });
    expect(s.raw.map((i) => i.id)).toEqual(["9"]);
  });
  it("jonli element cursor'ga tegmaydi; state error code bilan", () => {
    let s = chatReducer(INITIAL_STORE, { type: "items", payload: { items: [], replace: true, cursor: "c" } });
    s = chatReducer(s, { type: "items", payload: { items: [user("1", "a")] } });
    expect(s.cursor).toBe("c");
    s = chatReducer(s, { type: "state", state: "error", code: "busy" });
    expect(s.state).toBe("error");
    expect(s.code).toBe("busy");
    expect(chatReducer(s, { type: "state", state: "live" }).code).toBeNull();
  });
});

describe("buildView", () => {
  it("thinking ko'rsatilmaydi; user va javob navbati", () => {
    const v = buildView([user("1", "salom"), { id: "t", ts: 1, kind: "thinking", text: "sir" }, asst("2", "javob")]);
    expect(v.map((i) => i.kind)).toEqual(["user", "assistant"]);
    expect(JSON.stringify(v)).not.toContain("sir");
  });
  it("tool_use + tool_result toolUseId bo'yicha bitta blok", () => {
    const v = buildView([user("1", "x"), asst("2", "boshlayman"), use("3", "tu1", "Bash: npm test"), res("4", "tu1", false, "FAIL"), asst("5", "tuzatdim")]);
    expect(v).toHaveLength(2);
    const turn = v[1];
    if (turn.kind !== "assistant") throw new Error();
    expect(turn.parts.map((p) => p.type)).toEqual(["text", "tool", "text"]);
    const tool = turn.parts[1];
    if (tool.type !== "tool") throw new Error();
    expect(tool.tool).toBe("Bash");
    expect(tool.arg).toBe("npm test");
    expect(tool.output).toBe("FAIL");
    expect(tool.meta).toEqual({ text: "xato", tone: "red" });
  });
  it("natijasiz tool '…', Edit qatorlari, yakka natija (tool_use oynadan tashqarida)", () => {
    const v = buildView([use("1", "a", "Edit: src/app.ts", undefined, { added: 12, removed: 3 }), use("2", "b", "Read: x"), res("3", "orphan", true, "text", true)]);
    const turn = v[0];
    if (turn.kind !== "assistant") throw new Error();
    const [edit, read, orphan] = turn.parts;
    expect(edit.type === "tool" && edit.meta).toEqual({ text: "+12 −3", tone: "mu" });
    expect(read.type === "tool" && read.meta?.text).toBe("…");
    expect(orphan.type === "tool" && orphan.output).toContain("qisqartirilgan");
  });
  it("usage shu requestId li OXIRGI element ostida (va yangilanganda almashadi)", () => {
    const raw = [asst("a1", "bir", "r1"), use("u1", "t1", "Bash: ls", "r1"), res("rr", "t1"), asst("a2", "ikki", "r2")];
    let v = buildView([...raw, usage("r1", 50), usage("r2", 7)]);
    const turn = v[0];
    if (turn.kind !== "assistant") throw new Error();
    expect(turn.parts.map((p) => p.type)).toEqual(["text", "tool", "footnote", "text", "footnote"]);
    const f1 = turn.parts[2];
    expect(f1.type === "footnote" && f1.footnote.outputTokens).toBe(50);
    // upsert: usage:r1 o'sdi
    const raw2 = upsertItems([...raw, usage("r1", 50), usage("r2", 7)], [usage("r1", 90)]);
    v = buildView(raw2);
    const t2 = v[0];
    expect(t2.kind === "assistant" && t2.parts.filter((p) => p.type === "footnote")).toHaveLength(2);
    const f = t2.kind === "assistant" ? t2.parts[2] : null;
    expect(f && f.type === "footnote" && f.footnote.outputTokens).toBe(90);
  });
  it("notice navbatni bo'ladi", () => {
    const v = buildView([asst("1", "a"), { id: "n", ts: 5, kind: "notice", code: "interrupted", level: "info", text: "To'xtatildi" }, asst("2", "b")]);
    expect(v.map((i) => i.kind)).toEqual(["assistant", "notice", "assistant"]);
  });
});

describe("<ChatStream />: matn xavfsiz render", () => {
  it("raw HTML bajarilmaydi, [REDACTED] o'zgarishsiz", () => {
    const view = buildView([user("1", "<img src=x onerror=alert(1)>"), asst("2", "bir **qalin** <script>alert(1)</script> REDIS_URL=[REDACTED]")]);
    const html = renderToStaticMarkup(<ChatStream items={view} renderApproval={() => null} />);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("<strong>qalin</strong>");
    expect(html).toContain("[REDACTED]");
  });
  it("older tugmasi", () => {
    const html = renderToStaticMarkup(<ChatStream items={[]} renderApproval={() => null} hasOlder />);
    expect(html).toContain("Oldingi xabarlarni yuklash");
  });
});

describe("chat route validatsiyasi", () => {
  it("uuid va cursor", () => {
    expect(isUuid(U)).toBe(true);
    expect(isUuid("../etc/passwd")).toBe(false);
    expect(isUuid(null)).toBe(false);
    expect(isValidCursor("abc:123")).toBe(true);
    expect(isValidCursor("")).toBe(false);
    expect(isValidCursor("a b")).toBe(false);
    expect(isValidCursor("x".repeat(65))).toBe(false);
  });
  it("sessionId va cid ikkalasi uuid bo'lishi shart", () => {
    expect(checkChatParams(U, U)).toEqual({ ok: true, sessionId: U, cid: U });
    expect(checkChatParams("nope", U)).toMatchObject({ ok: false, status: 400, error: "invalid_session_id" });
    expect(checkChatParams(U, null)).toMatchObject({ ok: false, error: "invalid_cid" });
  });
});
