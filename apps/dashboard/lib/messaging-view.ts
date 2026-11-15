import { MessageKindSchema, OwnerSendBodySchema, PutRulesBodySchema, RoleSchema, MESSAGE_KINDS, MESSAGE_LIMITS } from "@commander/contracts";
import type { GroupDto, GroupMember, ListGroupsResponse, MessageDto, MessageKind, MessageStatus, OwnerSendBody, PutRulesBody, Rule } from "@commander/contracts";
import { commandHttpErrorText } from "./control-ui";
import { formatClock } from "./format";

/** Sessiyalararo xabar (2.10) ko'rinish modellari (sof, testlanadi). */

export const KIND_LABEL: Record<MessageKind, string> = {
  api_change: "API o'zgarishi",
  question: "Savol",
  request: "So'rov",
  info: "Ma'lumot",
  answer: "Javob",
};

export const STATUS_LABEL: Record<MessageStatus, string> = { pending: "kutmoqda", delivered: "yetkazildi", read: "o'qildi" };

export const ROLE_PRESETS = ["backend", "frontend", "mobile"] as const;

/** Loyihaning xabarlashuv guruhi: `baseKeys` ichida loyihaning repo kaliti yoki `project:<uuid>` bo'lgan guruh. */
export function findProjectGroup(groups: GroupDto[], project: { id: string; repoKey: string | null }): GroupDto | null {
  const keys = new Set([project.repoKey, `project:${project.id}`].filter((k): k is string => !!k));
  return groups.find((g) => g.baseKeys.some((b) => keys.has(b))) ?? null;
}

/** "Loyiha bog'lash" ro'yxati: guruhga hali kirmaganlar. */
export function linkableFor(resp: Pick<ListGroupsResponse, "linkable">, group: GroupDto | null): ListGroupsResponse["linkable"] {
  const have = new Set(group?.baseKeys ?? []);
  return resp.linkable.filter((l) => !have.has(l.baseKey));
}

/** Workspace nomi: kichik harf, raqam, `_` `-` (≤40). */
export function slugWorkspace(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/-+$/g, "")
    .slice(0, 40);
  return s;
}

// --- rol ----------------------------------------------------------------------------------------------

export function roleBadge(m: Pick<GroupMember, "role" | "roleSource">): { text: string; guess: boolean } {
  if (!m.role) return { text: "rol yo'q", guess: false };
  return { text: m.role, guess: m.roleSource === "guess" };
}

/** Select qiymati: preset, "__custom__" yoki "" (taxminga qaytarish). */
export function roleSelectValue(m: Pick<GroupMember, "role" | "roleSource">): string {
  if (!m.role || m.roleSource === "guess") return "";
  return (ROLE_PRESETS as readonly string[]).includes(m.role) ? m.role : "__custom__";
}

/** Rol kiritmasi tekshiruvi: null = yaroqli (bo'sh = taxminga qaytish). */
export function roleIssue(raw: string): string | null {
  if (raw.trim() === "") return null;
  return RoleSchema.safeParse(raw).success ? null : "Rol: kichik harf/raqam/bo'shliq/_.-, ≤32 belgi; owner/all/auto/hammasi band";
}

export function roleBody(raw: string): { role: string | null } | null {
  if (raw.trim() === "") return { role: null };
  const r = RoleSchema.safeParse(raw);
  return r.success ? { role: r.data } : null;
}

// --- lenta ---------------------------------------------------------------------------------------------

export interface Recipient {
  messageId: string;
  role: string | null;
  label: string;
  status: MessageStatus;
  statusLabel: string;
  deliveredAt: string | null;
  readAt: string | null;
}

export interface FeedItem {
  /** Birinchi qabul qiluvchi xabar id'si (javob bog'lash uchun). */
  id: string;
  batchId: string;
  fromRole: string;
  fromLabel: string;
  kind: MessageKind;
  kindLabel: string;
  subject: string;
  body: string;
  createdAt: string;
  time: string;
  /** Manzil xulosasi: "frontend" | "hammasi (3)" | "backend, mobile". */
  toSummary: string;
  recipients: Recipient[];
  /** Eng sust holat (yetkazish xulosasi). */
  overall: MessageStatus;
  /** Ota xabar kitobda yuklanmagan bo'lsa: "javob: #abcd1234". */
  replyRef: string | null;
  replies: FeedItem[];
}

const RANK: Record<MessageStatus, number> = { pending: 0, delivered: 1, read: 2 };

export function overallStatus(recipients: Pick<Recipient, "status">[]): MessageStatus {
  return recipients.reduce<MessageStatus>((w, r) => (RANK[r.status] < RANK[w] ? r.status : w), "read");
}

function toItem(rows: MessageDto[]): FeedItem {
  const first = rows[0];
  const recipients = rows.map(
    (m): Recipient => ({ messageId: m.id, role: m.toRole, label: m.toLabel, status: m.status, statusLabel: STATUS_LABEL[m.status], deliveredAt: m.deliveredAt, readAt: m.readAt }),
  );
  const roles = [...new Set(rows.map((m) => m.toRole ?? m.toLabel))];
  const toSummary = first.toTarget === "all" || rows.length > 3 ? `hammasi (${rows.length})` : roles.join(", ");
  return {
    id: first.id,
    batchId: first.batchId,
    fromRole: first.fromRole,
    fromLabel: first.fromLabel,
    kind: first.kind,
    kindLabel: KIND_LABEL[first.kind],
    subject: first.subject,
    body: first.body,
    createdAt: first.createdAt,
    time: formatClock(Date.parse(first.createdAt)),
    toSummary,
    recipients,
    overall: overallStatus(recipients),
    replyRef: null,
    replies: [],
  };
}

/**
 * Lenta: bir `batchId` = bitta xabar (broadcast qabul qiluvchilari birlashadi); javoblar (`replyTo`) ota xabar ostida
 * (eskidan yangiga), yuklanmagan ota bo'lsa alohida "javob: #id". Yuqori daraja: yangisi birinchi.
 */
export function buildFeed(messages: MessageDto[]): FeedItem[] {
  const byBatch = new Map<string, MessageDto[]>();
  for (const m of messages) {
    const list = byBatch.get(m.batchId);
    if (list) list.push(m);
    else byBatch.set(m.batchId, [m]);
  }
  const msgBatch = new Map(messages.map((m) => [m.id, m.batchId]));
  const items = new Map<string, FeedItem>();
  for (const [batch, rows] of byBatch) {
    rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    items.set(batch, toItem(rows));
  }
  const top: FeedItem[] = [];
  for (const [batch, rows] of byBatch) {
    const item = items.get(batch)!;
    const parentMsg = rows[0].replyTo;
    const parentBatch = parentMsg ? msgBatch.get(parentMsg) : undefined;
    if (parentBatch && parentBatch !== batch) items.get(parentBatch)!.replies.push(item);
    else {
      if (parentMsg) item.replyRef = `javob: #${parentMsg.slice(0, 8)}`;
      top.push(item);
    }
  }
  for (const it of items.values()) it.replies.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return top.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Push/yuklash: id bo'yicha almashtirish yoki qo'shish. */
export function upsertMessage(list: MessageDto[], m: MessageDto): MessageDto[] {
  const i = list.findIndex((x) => x.id === m.id);
  if (i === -1) return [m, ...list];
  const next = list.slice();
  next[i] = m;
  return next;
}

export function mergeOlder(list: MessageDto[], older: MessageDto[]): MessageDto[] {
  const have = new Set(list.map((m) => m.id));
  return [...list, ...older.filter((m) => !have.has(m.id))];
}

// --- yozuvchi (composer) ----------------------------------------------------------------------------------

export interface ComposerState {
  to: string;
  kind: MessageKind;
  subject: string;
  body: string;
  replyTo: string | null;
}

export const EMPTY_COMPOSER: ComposerState = { to: "all", kind: "info", subject: "", body: "", replyTo: null };

export interface TargetOption {
  value: string;
  label: string;
  group: "special" | "role" | "session";
}

/** Manzillar: avto, hammasi, rollar, aniq sessiyalar (qisqa id bilan). */
export function targetOptions(members: GroupMember[]): TargetOption[] {
  const out: TargetOption[] = [
    { value: "auto", label: "Avto (qoidalar bo'yicha)", group: "special" },
    { value: "all", label: "Hammasi", group: "special" },
  ];
  const roles = [...new Set(members.map((m) => m.role).filter((r): r is string => !!r))].sort();
  for (const r of roles) out.push({ value: r, label: `Rol: ${r}`, group: "role" });
  for (const m of members) out.push({ value: m.shortId, label: `${m.machineName} · ${m.projectName} · ${m.shortId}`, group: "session" });
  return out;
}

export function buildSendBody(groupKey: string, c: ComposerState): { ok: true; body: OwnerSendBody } | { ok: false; error: string } {
  const subject = c.subject.trim();
  if (!subject) return { ok: false, error: "Mavzuni kiriting" };
  if (subject.length > MESSAGE_LIMITS.subjectMaxChars) return { ok: false, error: `Mavzu ≤ ${MESSAGE_LIMITS.subjectMaxChars} belgi` };
  if (!c.body.trim()) return { ok: false, error: "Xabar matnini kiriting" };
  if (c.body.length > MESSAGE_LIMITS.bodyMaxChars) return { ok: false, error: `Matn ≤ ${MESSAGE_LIMITS.bodyMaxChars} belgi` };
  const parsed = OwnerSendBodySchema.safeParse({ key: groupKey, to: c.to, kind: c.kind, subject, body: c.body, ...(c.replyTo ? { replyTo: c.replyTo } : {}) });
  return parsed.success ? { ok: true, body: parsed.data } : { ok: false, error: "Xabar ma'lumoti yaroqsiz" };
}

// --- qoidalar muharriri -------------------------------------------------------------------------------------

export interface RuleRow {
  kind: MessageKind | "";
  keyword: string;
  toRole: string;
}

export const EMPTY_RULE: RuleRow = { kind: "", keyword: "", toRole: "" };

export function rowsFromRules(rules: Rule[]): RuleRow[] {
  return rules.map((r) => ({ kind: r.kind ?? "", keyword: r.keyword ?? "", toRole: r.toRole }));
}

export function ruleIssues(rows: RuleRow[]): { index: number; message: string }[] {
  const out: { index: number; message: string }[] = [];
  rows.forEach((r, index) => {
    if (!r.kind && !r.keyword.trim()) out.push({ index, message: "Tur yoki kalit so'z kerak" });
    else if (r.kind && !MESSAGE_KINDS.includes(MessageKindSchema.parse(r.kind))) out.push({ index, message: "Tur noto'g'ri" });
    if (r.keyword.length > MESSAGE_LIMITS.keywordMaxChars) out.push({ index, message: `Kalit so'z ≤ ${MESSAGE_LIMITS.keywordMaxChars} belgi` });
    if (!RoleSchema.safeParse(r.toRole).success) out.push({ index, message: "Qabul qiluvchi rol noto'g'ri" });
  });
  if (rows.length > MESSAGE_LIMITS.maxRules) out.push({ index: -1, message: `Qoidalar ≤ ${MESSAGE_LIMITS.maxRules} ta` });
  return out;
}

/** So'rov tanasi (tartib saqlanadi: birinchi mos qoida ishlaydi); yaroqsiz bo'lsa null. */
export function buildRulesBody(groupKey: string, rows: RuleRow[]): PutRulesBody | null {
  if (ruleIssues(rows).length > 0) return null;
  const rules = rows.map((r) => ({ ...(r.kind ? { kind: r.kind } : {}), ...(r.keyword.trim() ? { keyword: r.keyword.trim() } : {}), toRole: r.toRole.trim().toLowerCase() }));
  const parsed = PutRulesBodySchema.safeParse({ key: groupKey, rules });
  return parsed.success ? parsed.data : null;
}

export function contextIssue(text: string): string | null {
  return text.length > MESSAGE_LIMITS.contextMaxChars ? `Kontekst ≤ ${MESSAGE_LIMITS.contextMaxChars} belgi (hozir ${text.length})` : null;
}

// --- xatolar va yozish huquqi ------------------------------------------------------------------------------------

export function messagingHttpErrorText(status: number, body: unknown): string {
  const code = typeof body === "object" && body !== null && "error" in body ? String((body as { error: unknown }).error) : "";
  switch (code) {
    case "messaging_disabled":
      return "Xabarlashuv o'chiq: avval guruhda yoqing";
    case "rate_limited":
      return "Juda ko'p xabar: bir necha daqiqadan keyin urinib ko'ring";
    case "unknown_target":
      return "Manzil topilmadi (rol yoki sessiya yo'q)";
    case "no_rule_matched":
      return "Avto-yo'naltirish qoidalaridan hech biri mos kelmadi";
    case "no_recipients":
      return "Qabul qiluvchi yo'q";
    case "too_many_recipients":
      return "Qabul qiluvchilar juda ko'p";
    case "forbidden_role":
      return "Bu rolni egasi belgilagan: sessiya o'zgartira olmaydi";
    case "group_unavailable":
      return "Guruh mavjud emas";
  }
  if (status === 429) return "Juda ko'p xabar: bir necha daqiqadan keyin urinib ko'ring";
  if (status === 409) return "Xabarlashuv o'chiq yoki holat mos emas";
  if (status === 404) return "Guruh, sessiya yoki bog'lanish topilmadi";
  return commandHttpErrorText(status, body);
}

/** Xabarlashuv yozuvlari uchun sabab (markaz sozlamasi: mashina siyosatiga bog'liq emas). */
export function messagingWriteReason(o: { lockdown: boolean; canControl: boolean }): string | null {
  if (o.lockdown) return "Lockdown yoqiq: yozish amallari o'chirilgan";
  if (!o.canControl) return "COMMANDER_CONTROL_TOKEN sozlanmagan: dashboard boshqaruvi o'chiq";
  return null;
}

export const MCP_NOTICE = "Claude sessiyada `commander_*` vositalari birinchi marta ruxsat so'rashi mumkin";
