import type { ChangedFile } from "./chat-map";
/**
 * Sessiya chati: backend (2-bosqich, JSONL oqimi) tayyor bo'lganda `useSessionChat` shu tiplarda qaytaradi.
 * UI komponentlari (components/chat/*) faqat shu tiplarga tayanadi.
 *
 * Sir saqlash: matnlar center tomonda `redact()` dan o'tgan bo'lishi kerak; `[REDACTED]` joylar
 * klientda hech qachon ochilmaydi.
 */

/** Javob ostidagi token izohi: "↳ 1.2M token · cache read 1.18M · output 3.4K · 41 s". */
export interface TokenFootnote {
  totalTokens: number;
  cacheReadTokens?: number;
  outputTokens?: number;
  /** Javob davomiyligi, ms. */
  durationMs?: number;
}

export type ToolMetaTone = "mu" | "grn" | "red";

/** Claude javobi ichidagi matn bo'lagi (markdown). */
export interface AssistantTextPart {
  type: "text";
  markdown: string;
}

/** Yig'ilgan tool bloki: `Bash: npm test`, `Edit: src/app.ts (+12 −3)`, `Read: …`. Bosilsa ochiladi. */
export interface AssistantToolPart {
  type: "tool";
  id: string;
  /** Tool nomi: Bash, Edit, Read, ... */
  tool: string;
  /** Qisqa argument (buyruq yoki fayl yo'li). */
  arg: string;
  /** O'ng tomondagi qisqa natija: "3 yiqildi", "+12 −3", "142 qator". */
  meta?: { text: string; tone: ToolMetaTone };
  /** Ochilganda ko'rinadigan matn (redakt qilingan). Yo'q bo'lsa blok ochilmaydi. */
  output?: string;
}

/** Token izohi: shu `requestId` li oxirgi elementdan keyin. */
export interface AssistantFootnotePart {
  type: "footnote";
  id: string;
  footnote: TokenFootnote;
}

export type AssistantPart = AssistantTextPart | AssistantToolPart | AssistantFootnotePart;

export interface UserChatItem {
  kind: "user";
  id: string;
  /** ISO vaqt. */
  ts: string;
  text: string;
}

export interface AssistantChatItem {
  kind: "assistant";
  id: string;
  ts: string;
  parts: AssistantPart[];
}

/** Tizim xabari: compact, interrupted, denied, error, info. `level=error` qizil ko'rsatiladi. */
export interface NoticeChatItem {
  kind: "notice";
  id: string;
  ts: string;
  code: "compact" | "interrupted" | "error" | "denied" | "info";
  level: "info" | "error";
  text: string;
}

/** Chat ichidagi ruxsat kartasi: approval ma'lumoti (holat/taymer) jonli `approvals` dan olinadi. */
export interface ApprovalChatItem {
  kind: "approval";
  id: string;
  approvalId: string;
  ts: string;
}

export type ChatItem = UserChatItem | AssistantChatItem | NoticeChatItem | ApprovalChatItem;

/**
 * unavailable: transcript topilmadi; connecting: ulanmoqda; live: jonli;
 * offline: mashina oflayn (oxirgi ma'lum xabarlar qoladi); error: o'qib bo'lmadi (`code`).
 */
export type ChatState = "unavailable" | "connecting" | "live" | "offline" | "error";

export type ChatErrorCode = "not_found" | "forbidden_path" | "busy" | "read_failed" | "internal";

export interface SessionChat {
  /** Eng eskisi birinchi. */
  items: ChatItem[];
  state: ChatState;
  /** `state === "error"` bo'lganda sabab. */
  code: ChatErrorCode | null;
  /** Eskiroq xabarlar bor (fayl boshiga yetilmagan). */
  hasOlder: boolean;
  loadingOlder: boolean;
  loadOlder: () => void;
  /** Yuklangan chat oynasidagi Edit/Write bloklaridan yig'ilgan fayllar. */
  changedFiles: ChangedFile[];
}
