import type { ChatItem as WireItem, ChatItemsToClientPayload, ChatState as WireState } from "@commander/contracts";
import type { AssistantPart, ChatErrorCode, ChatItem, ChatState } from "./chat-types";

/**
 * Center `chat.items` -> ko'rinish modeli (sof, testlanadi).
 *  - bir xil `id` oldingisini ALMASHTIRADI (joyida);
 *  - `replace` ro'yxatni to'liq almashtiradi, `older` boshiga qo'shadi;
 *  - tool_use + tool_result `toolUseId` bo'yicha bitta yig'iladigan blok;
 *  - usage shu `requestId` li OXIRGI element ostida token izohi;
 *  - thinking hech qachon ko'rsatilmaydi.
 */

export interface ChatStore {
  raw: WireItem[];
  state: ChatState;
  code: ChatErrorCode | null;
  /** Keyingi eski sahifa kursori; null = boshiga yetildi; undefined = noma'lum. */
  cursor: string | null | undefined;
  loadingOlder: boolean;
}

export const INITIAL_STORE: ChatStore = { raw: [], state: "connecting", code: null, cursor: undefined, loadingOlder: false };

export type ChatAction =
  | { type: "reset" }
  | { type: "items"; payload: Pick<ChatItemsToClientPayload, "items" | "replace" | "older" | "cursor"> }
  | { type: "state"; state: WireState; code?: ChatErrorCode }
  | { type: "link-down" }
  | { type: "loading-older"; value: boolean };

/** `items` ni id bo'yicha upsert qiladi (mavjud id joyida almashadi, yangisi oxiriga). */
export function upsertItems(list: WireItem[], items: WireItem[]): WireItem[] {
  const next = list.slice();
  const index = new Map(next.map((it, i) => [it.id, i]));
  for (const it of items) {
    const at = index.get(it.id);
    if (at === undefined) {
      index.set(it.id, next.length);
      next.push(it);
    } else {
      next[at] = it;
    }
  }
  return next;
}

export function chatReducer(s: ChatStore, a: ChatAction): ChatStore {
  switch (a.type) {
    case "reset":
      return INITIAL_STORE;
    case "link-down":
      return s.state === "live" || s.state === "connecting" ? { ...s, state: "connecting" } : s;
    case "loading-older":
      return { ...s, loadingOlder: a.value };
    case "state":
      return { ...s, state: a.state, code: a.state === "error" ? (a.code ?? "internal") : null };
    case "items": {
      const { items, replace, older, cursor } = a.payload;
      let raw: WireItem[];
      if (replace) raw = upsertItems([], items);
      else if (older) {
        const have = new Set(s.raw.map((x) => x.id));
        const fresh = upsertItems([], items.filter((x) => !have.has(x.id)));
        raw = [...fresh, ...s.raw];
      } else raw = upsertItems(s.raw, items);
      return {
        ...s,
        raw,
        cursor: (replace || older) && cursor !== undefined ? cursor : s.cursor,
        loadingOlder: older ? false : s.loadingOlder,
      };
    }
  }
}

const iso = (ts: number): string => (ts > 0 ? new Date(ts).toISOString() : "");

function toolArg(toolName: string, summary: string): string {
  const prefix = `${toolName}: `;
  return summary.startsWith(prefix) ? summary.slice(prefix.length) : summary;
}

type ToolUse = Extract<WireItem, { kind: "tool_use" }>;
type ToolResult = Extract<WireItem, { kind: "tool_result" }>;

function toolPart(use: ToolUse | null, result: ToolResult | undefined, fallbackId: string): AssistantPart {
  const tool = use?.toolName ?? result?.toolName ?? "Tool";
  const arg = use ? toolArg(use.toolName, use.summary) : "(natija)";
  let meta: { text: string; tone: "mu" | "grn" | "red" } | undefined;
  if (result && !result.ok) meta = { text: "xato", tone: "red" };
  else if (use?.lines) meta = { text: `+${use.lines.added} −${use.lines.removed}`, tone: "mu" };
  else if (result) meta = { text: "✓", tone: "grn" };
  else meta = { text: "…", tone: "mu" };
  const output = result ? (result.text + (result.truncated ? "\n…[qisqartirilgan]" : "")).trim() : "";
  return { type: "tool", id: use?.id ?? fallbackId, tool, arg, meta, ...(output ? { output } : {}) };
}

/** Xom elementlardan ko'rinish elementlari. */
export function buildView(raw: WireItem[]): ChatItem[] {
  const results = new Map<string, ToolResult>();
  const usages = new Map<string, Extract<WireItem, { kind: "usage" }>>();
  const lastOfRequest = new Map<string, string>(); // requestId -> oxirgi element id
  const usedUses = new Set<string>();
  for (const it of raw) {
    if (it.kind === "tool_result") results.set(it.toolUseId, it);
    else if (it.kind === "usage") usages.set(it.requestId, it);
    else if ((it.kind === "assistant" || it.kind === "tool_use") && it.requestId) lastOfRequest.set(it.requestId, it.id);
  }
  for (const it of raw) if (it.kind === "tool_use") usedUses.add(it.toolUseId);

  const out: ChatItem[] = [];
  let turn: Extract<ChatItem, { kind: "assistant" }> | null = null;
  const push = (part: AssistantPart, id: string, ts: number) => {
    if (!turn) {
      turn = { kind: "assistant", id, ts: iso(ts), parts: [] };
      out.push(turn);
    }
    turn.parts.push(part);
  };

  for (const it of raw) {
    switch (it.kind) {
      case "thinking":
      case "usage":
        break;
      case "user":
        turn = null;
        out.push({ kind: "user", id: it.id, ts: iso(it.ts), text: it.text });
        break;
      case "notice":
        turn = null;
        out.push({ kind: "notice", id: it.id, ts: iso(it.ts), code: it.code, level: it.level, text: it.text });
        break;
      case "assistant":
        if (it.text.trim()) push({ type: "text", markdown: it.text }, it.id, it.ts);
        break;
      case "tool_use":
        push(toolPart(it, results.get(it.toolUseId), it.id), it.id, it.ts);
        break;
      case "tool_result":
        // Mos tool_use ko'rinsa, u bilan birlashgan; aks holda yakka blok
        if (!usedUses.has(it.toolUseId)) push(toolPart(null, it, it.id), it.id, it.ts);
        break;
    }
    // Usage: shu requestId bo'yicha oxirgi element ostida
    const rid = it.kind === "assistant" || it.kind === "tool_use" ? it.requestId : undefined;
    if (rid && lastOfRequest.get(rid) === it.id) {
      const u = usages.get(rid);
      if (u) {
        const total = u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens;
        push({ type: "footnote", id: u.id, footnote: { totalTokens: total, cacheReadTokens: u.cacheReadTokens, outputTokens: u.outputTokens } }, u.id, u.ts);
      }
    }
  }
  // bo'sh qolgan navbatlar (faqat bo'sh matn) olib tashlanadi
  return out.filter((x) => x.kind !== "assistant" || x.parts.length > 0);
}

/** Sessiya o'zgartirgan fayl (yuklangan chat oynasidagi Edit/Write bloklaridan). */
export interface ChangedFile {
  path: string;
  added: number;
  removed: number;
  edits: number;
  /** Oxirgi o'zgarish (ms). */
  lastTs: number;
}

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

/** `Edit: src/app.ts (+3 -1)` → `src/app.ts`. Yo'l bo'lmasa `null`. */
export function editPath(toolName: string, summary: string): string | null {
  const arg = toolArg(toolName === "MultiEdit" ? "Edit" : toolName, summary).replace(/ \(\+\d+(?: -\d+)?\)$/, "").trim();
  return arg.length > 0 ? arg : null;
}

/** Fayl bo'yicha jamlaydi; eng so'nggi o'zgargani birinchi. */
export function changedFiles(raw: readonly WireItem[]): ChangedFile[] {
  const byPath = new Map<string, ChangedFile>();
  for (const it of raw) {
    if (it.kind !== "tool_use" || !EDIT_TOOLS.has(it.toolName)) continue;
    const path = editPath(it.toolName, it.summary);
    if (!path) continue;
    const f = byPath.get(path) ?? { path, added: 0, removed: 0, edits: 0, lastTs: 0 };
    f.added += it.lines?.added ?? 0;
    f.removed += it.lines?.removed ?? 0;
    f.edits += 1;
    f.lastTs = Math.max(f.lastTs, it.ts);
    byPath.set(path, f);
  }
  return [...byPath.values()].sort((a, b) => b.lastTs - a.lastTs);
}
