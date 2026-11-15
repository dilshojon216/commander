import { PLAN_REMOTE_APPROVE_SUPPORTED } from "@commander/contracts";
import type { ApprovalBehavior, ApprovalDto } from "@commander/contracts";
import { formatClock, formatCountdown } from "./format";

/** Approval tugmalari holati va xato xaritalash (sof, testlanadi). */

export type SubmitState = { kind: "idle" } | { kind: "submitting"; behavior: ApprovalBehavior } | { kind: "error"; message: string };

export interface ButtonState {
  disabled: boolean;
  label: string;
}

export interface ApprovalButtons {
  allow: ButtonState;
  deny: ButtonState;
  /** Tugmalar yonidagi tushuntirish (bo'sh = kerak emas). */
  hint: string | null;
}

export function approvalButtons(
  approval: Pick<ApprovalDto, "status" | "deadline">,
  opts: { lockdown: boolean; canApprove: boolean; submit: SubmitState; now: number },
): ApprovalButtons {
  const allowIdle = "Ruxsat";
  const denyIdle = "Rad";

  if (!opts.canApprove) {
    return {
      allow: { disabled: true, label: allowIdle },
      deny: { disabled: true, label: denyIdle },
      hint: "COMMANDER_APPROVE_TOKEN sozlanmagan: faqat ko'rish mumkin",
    };
  }
  if (approval.status !== "pending") {
    return { allow: { disabled: true, label: allowIdle }, deny: { disabled: true, label: denyIdle }, hint: "allaqachon hal qilingan" };
  }
  if (Date.parse(approval.deadline) <= opts.now) {
    return { allow: { disabled: true, label: allowIdle }, deny: { disabled: true, label: denyIdle }, hint: "muddati o'tgan" };
  }
  if (opts.submit.kind === "submitting") {
    const allowing = opts.submit.behavior === "allow";
    return {
      allow: { disabled: true, label: allowing ? "Yuborilmoqda..." : allowIdle },
      deny: { disabled: true, label: allowing ? denyIdle : "Yuborilmoqda..." },
      hint: null,
    };
  }
  return {
    allow: { disabled: opts.lockdown, label: allowIdle },
    deny: { disabled: false, label: denyIdle },
    hint: opts.lockdown ? "lockdown: faqat rad etish mumkin" : null,
  };
}

/** Reja (ExitPlanMode): Claude Code hook `allow` ni qabul qilmaydi (tekshirilgan, 2.1.304): tasdiq terminalda. */
export const PLAN_APPROVE_NOTE = "Rejani masofadan tasdiqlab bo'lmaydi (Claude Code buni qo'llamaydi): terminalda tasdiqlang yoki fikr yozib rad eting, Claude rejani qayta ko'rib chiqadi.";
export const PLAN_FEEDBACK_MAX = 1000;
export { PLAN_REMOTE_APPROVE_SUPPORTED };

/** Center javobini foydalanuvchi xabariga aylantiradi. */
export function mapDecisionError(status: number, body: unknown): string {
  const code = typeof body === "object" && body !== null && "error" in body ? String((body as { error: unknown }).error) : "";
  if (status === 409) return code === "approval_expired" ? "muddati o'tgan" : "allaqachon hal qilingan";
  if (status === 403 && code === "lockdown") return "lockdown: faqat rad etish mumkin";
  if (status === 403) return "Ruxsat yo'q (token scope yetarli emas)";
  if (status === 422 && code === "plan_approve_unsupported") return PLAN_APPROVE_NOTE;
  if (status === 422 && (code === "question_answers_required" || code === "invalid_answers")) return "Javob qabul qilinmadi: har savolga javob bering";
  if (status === 404) return "So'rov topilmadi";
  if (status === 503) return "COMMANDER_APPROVE_TOKEN sozlanmagan";
  if (status === 401) return "Token rad etildi";
  return `Xatolik (${status || "tarmoq"})`;
}

/** Xato xabarini dizayndagi matnga o'tkazadi (409 -> terminalda javob berilgan, lockdown ...). */
export function decisionErrorText(message: string): string {
  switch (message) {
    case "allaqachon hal qilingan":
      return "Allaqachon hal qilingan (terminalda javob berildi)";
    case "muddati o'tgan":
      return "Muddati o'tdi";
    case PLAN_APPROVE_NOTE:
      return PLAN_APPROVE_NOTE;
    case "lockdown: faqat rad etish mumkin":
      return "Lockdown: faqat rad etish mumkin";
    default:
      return message.charAt(0).toUpperCase() + message.slice(1);
  }
}

// --- Ruxsat kartasi holat modeli -------------------------------------------------------------

export type ApprovalCardKind = "pending" | "confirm" | "approved" | "denied" | "expired" | "cancelled";
export type CardTone = "org" | "red" | "grn" | "gray";

export interface ApprovalCardModel {
  kind: ApprovalCardKind;
  title: string;
  tone: CardTone;
  /** Sarlavha/chegara/nuqta rangi (karta boshida "ko'zga tashlanadigan" faqat pending/confirm). */
  active: boolean;
  /** Vaqt < 1 daqiqa: taymer va chiziq qizil. */
  urgent: boolean;
  /** Taymer matni ("4:12 qoldi" yoki hal qilingan vaqt "09:51"). */
  timer: string;
  /** 0..100: qolgan vaqt ulushi (faqat pending). */
  timerPct: number;
  /** Karta tanasi xiralashadimi. */
  dim: boolean;
  /** Karta ostidagi xabar (xato, lockdown, natija). */
  message: string | null;
  messageTone: "tx" | "mu" | "red";
  showButtons: boolean;
  buttons: ApprovalButtons;
}

/** Ruxsat so'rovining umumiy kutish oynasi (taymer chizig'i uchun): 5 daqiqa. */
export const APPROVAL_WINDOW_MS = 5 * 60_000;

export function approvalCardModel(
  a: ApprovalDto,
  opts: { now: number; lockdown: boolean; canApprove: boolean; submit: SubmitState; confirming: boolean },
): ApprovalCardModel {
  const buttons = approvalButtons(a, opts);
  const left = Date.parse(a.deadline) - opts.now;
  const resolvedMs = Date.parse(a.decidedAt ?? a.resolvedAt ?? "");
  const resolvedClock = Number.isNaN(resolvedMs) ? "" : formatClock(resolvedMs);
  const base = { active: false, urgent: false, timerPct: 0, dim: true, showButtons: false, buttons };

  const isPlan = a.kind === "plan";
  const isQuestion = a.kind === "question";
  if (a.status === "approved") {
    const auto = a.autoRuleId !== null;
    const title = auto ? `Avto-ruxsat (qoida #${a.autoRuleId})` : isPlan ? "Reja tasdiqlandi" : isQuestion ? "Javob berildi" : "Ruxsat berildi";
    return { ...base, kind: "approved", title, tone: "grn", timer: resolvedClock, message: a.decisionMessage ?? title, messageTone: "mu" };
  }
  if (a.status === "denied") {
    const message = isPlan ? (a.decisionMessage ? `Fikr yuborildi: ${a.decisionMessage}` : "Rad etildi, Claude rejani qayta ko'rib chiqadi") : (a.decisionMessage ?? "Rad etildi, Claude boshqa yo'l qidiradi");
    return { ...base, kind: "denied", title: isPlan ? "Reja rad etildi" : isQuestion ? "Savol rad etildi" : "Rad etildi", tone: "red", timer: resolvedClock, message, messageTone: "mu" };
  }
  if (a.status === "expired" || (a.status === "pending" && left <= 0 && opts.now > 0)) {
    return { ...base, kind: "expired", title: "Muddati o'tdi", tone: "gray", timer: "0:00", message: "5 daqiqada javob berilmadi", messageTone: "mu" };
  }
  if (a.status === "cancelled") {
    return { ...base, kind: "cancelled", title: "Allaqachon hal qilingan", tone: "gray", timer: resolvedClock, message: "Terminalda javob berildi", messageTone: "mu", dim: true };
  }

  const pendingTitle = isPlan ? "Reja tasdig'i" : isQuestion ? "Claude savol bermoqda" : "Ruxsat so'rovi";
  const urgent = opts.now > 0 && left < 60_000;
  const timer = opts.now > 0 ? `${formatCountdown(left)} qoldi` : "";
  const timerPct = opts.now > 0 ? Math.max(0, Math.min(100, (left / APPROVAL_WINDOW_MS) * 100)) : 100;
  const common = { active: true, urgent, timer, timerPct, dim: false, showButtons: true, buttons };

  if (opts.submit.kind === "error") {
    return { ...common, kind: "pending", title: pendingTitle, tone: urgent ? "red" : "org", message: decisionErrorText(opts.submit.message), messageTone: "red" };
  }
  if (opts.confirming) {
    return { ...common, kind: "confirm", title: "Ruxsat so'rovi · tasdiqlang", tone: urgent ? "red" : "org", message: null, messageTone: "tx" };
  }
  if (opts.lockdown) {
    return { ...common, kind: "pending", title: pendingTitle, tone: urgent ? "red" : "org", message: "Lockdown: faqat rad etish mumkin", messageTone: "red" };
  }
  return {
    ...common,
    kind: "pending",
    title: pendingTitle,
    tone: urgent ? "red" : "org",
    message: urgent ? "Vaqt tugayapti" : (isPlan && !buttons.hint ? PLAN_APPROVE_NOTE : buttons.hint),
    messageTone: urgent ? "red" : "mu",
  };
}

// --- Tool kiritmasini qisqa ko'rsatish ---------------------------------------------------------

export interface ToolSummary {
  /** Bir qatorli qisqa ko'rinish (buyruq yoki fayl yo'li). */
  headline: string;
  /** To'liq (redakt qilingan) matn. */
  detail: string;
}

/** `toolInputRedacted` odatda JSON: Bash -> command, fayl toollari -> file_path. Aks holda xom matn. */
export function toolSummary(input: string): ToolSummary {
  const raw = input.trim();
  if (!raw) return { headline: "(bo'sh)", detail: "(bo'sh)" };
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return { headline: firstLine(raw), detail: raw };
  }
  if (typeof obj !== "object" || obj === null) return { headline: firstLine(raw), detail: raw };
  const rec = obj as Record<string, unknown>;
  const str = (k: string): string | null => (typeof rec[k] === "string" && rec[k] !== "" ? (rec[k] as string) : null);
  const cmd = str("command");
  if (cmd) return { headline: firstLine(cmd), detail: cmd };
  const path = str("file_path") ?? str("path") ?? str("notebook_path");
  if (path) return { headline: path, detail: JSON.stringify(obj, null, 2) };
  const alt = str("pattern") ?? str("url") ?? str("query") ?? str("prompt");
  if (alt) return { headline: firstLine(alt), detail: JSON.stringify(obj, null, 2) };
  return { headline: firstLine(raw), detail: JSON.stringify(obj, null, 2) };
}

function firstLine(s: string): string {
  const line = s.split("\n").find((l) => l.trim() !== "") ?? s;
  return line.length > 400 ? `${line.slice(0, 400)}…` : line;
}
