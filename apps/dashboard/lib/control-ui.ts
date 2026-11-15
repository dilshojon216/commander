import { isTerminalCommandState } from "@commander/contracts";
import type { CommandDto, CommandState, ControlReason, MachineDto, RemotePermissionMode, SessionDto } from "@commander/contracts";

import { CONFIG_ERROR_TEXT } from "./config-errors";
import { DEPLOY_ERROR_TEXT } from "./deploy-errors";
import { GIT_ERROR_TEXT } from "./git-view";
import { LOG_ERROR_TEXT } from "./logs-view";

/** Masofaviy boshqaruv UI mantig'i (sof, testlanadi). */

const ERROR_TEXT: Record<string, string> = {
  // Deploy (6.5) / checkpoint (6.9): umumiy (git) matnlar ustun, yangi kodlar shu yerdan
  ...DEPLOY_ERROR_TEXT,
  ...GIT_ERROR_TEXT,
  ...CONFIG_ERROR_TEXT,
  ...LOG_ERROR_TEXT,
  machine_offline: "Mashina oflayn",
  ask_failed: "Yordamchi (Claude) savolga javob bera olmadi",
  policy_disabled: "Bu mashinada masofaviy boshqaruv o'chiq",
  interactive_session: "Terminal sessiyasi: faqat ko'rish",
  session_ended: "Sessiya tugagan",
  step_up_unavailable: "Telegram tasdig'i yuborilmadi (bot ulanmagan)",
  step_up_expired: "Tasdiqlash vaqti tugadi (2 daqiqa)",
  step_up_cancelled: "Tasdiqlash bekor qilindi",
  command_in_flight: "Bu sessiyada boshqa buyruq bajarilmoqda",
  dispatch_expired: "Buyruq mashinaga yetib bormadi (muddat tugadi)",
  agent_timeout: "Mashina javob bermadi (vaqt tugadi)",
  lockdown: "Lockdown yoqiq: boshqaruv o'chirilgan",
  center_restarted: "Markaz qayta ishga tushdi, buyruq bekor bo'ldi",
  agent_error: "Mashinada xatolik yuz berdi",
  agent_outdated: "Mashinadagi agentd eski: masofaviy boshqaruvni qo'llamaydi",
  idempotency_conflict: "Bu so'rov allaqachon boshqa ma'lumot bilan yuborilgan",
  bad_signature: "Buyruq imzosi noto'g'ri",
  expired: "Buyruq muddati o'tgan",
  replay: "Buyruq takrorlangan",
  wrong_target: "Buyruq boshqa mashina uchun",
  center_key_unpinned: "Mashina markaz kalitini hali tasdiqlamagan",
  center_key_mismatch: "Markaz kaliti mos kelmadi",
  invalid_payload: "Buyruq ma'lumoti noto'g'ri",
  action_not_allowed: "Bu amal mashina siyosatida taqiqlangan",
  cwd_not_allowed: "Bu papka mashinada ruxsat etilgan ro'yxatda yo'q",
  cwd_invalid: "Papka topilmadi yoki yaroqsiz",
  mode_forbidden: "Bu ruxsat rejimi masofadan taqiqlangan",
  mode_not_allowed: "Bu rejim mashina siyosatida yoqilmagan",
  too_many_sessions: "Mashinada masofaviy sessiyalar chegarasi to'lgan",
  running_as_root: "agentd root bilan ishlayapti: masofaviy boshqaruv rad etildi",
  session_not_found: "Sessiya mashinada topilmadi",
  session_busy: "Sessiya band: avval to'xtating yoki ish tugashini kuting",
  set_mode_unsupported: "Ishlab turgan sessiyada rejimni almashtirib bo'lmaydi",
  shim_unsupported: "Bu mashinadagi claude (.cmd) masofadan ishga tushirishni qo'llamaydi",
  claude_failed: "Claude ishga tushmadi",
  resume_forked: "Sessiya davom ettirilmadi (nusxa ochilgan va to'xtatildi)",
  correlation_timeout: "Yangi sessiya vaqtida topilmadi",
  close_failed: "Sessiya yopilmadi (Claude /exit dan keyin chiqmadi)",
  session_still_running: "Sessiya hali terminalda ochiq — avval undan chiqing",
  resume_unsupported: "Bu mashinada tmux yo'q yoki Windows: sessiyani davom ettirib bo'lmaydi",
  stop_failed: "Sessiyani to'xtatib bo'lmadi",
  not_owned: "Bu jarayon agentd foydalanuvchisiga tegishli emas",
  project_not_found: "Loyiha papkasi mashinada topilmadi",
  path_invalid: "Yo'l yaroqsiz yoki loyiha ildizidan tashqarida",
  file_too_large: "Fayl juda katta",
  file_not_found: "Fayl topilmadi",
  tasks_md_changed: "TASKS.md o'zgargan — yangilang va qayta urinib ko'ring",
  tasks_md_missing: "Loyihada TASKS.md yo'q",
  tasks_md_invalid: "TASKS.md UTF-8 emas: qayta yozilmadi",
  nothing_to_add: "Barcha vazifa id'lari TASKS.md'da allaqachon bor",
  summarize_failed: "Kun xulosasini olib bo'lmadi (claude -p ishlamadi)",
  invalid_result: "Agent noto'g'ri natija qaytardi",
  internal: "Ichki xatolik",
  // Remote Control (3.10) va shablonlar (3.4)
  remote_control_failed: "Remote Control o'zgartirilmadi",
  remote_control_unsupported: "Remote Control faqat tmux sessiyada yoqiladi (fon sessiyada faqat ochishda)",
  remote_control_unverified: "Remote Control holati tasdiqlanmadi (claude.ai bilan kirilganmi?)",
  missing_variables: "Shablondagi o'zgaruvchilar uchun qiymat topilmadi",
  prompt_too_long: "Shablondan tuzilgan matn juda uzun",
  secret_detected: "Shablon matnida sir (token/kalit) bor ko'rinadi",
  template_exists: "Bu ko'lamda shu nomli shablon allaqachon bor",
  // Xavfsizlik tekshiruvi (6.10) va kunlik byudjet (6.11)
  scan_failed: "Xavfsizlik tekshiruvi bajarilmadi",
  budget_exceeded: "Kunlik byudjet tugadi: yangi sessiya ochilmaydi. Yarim kechada (Toshkent) yangilanadi yoki Byudjetlar sahifasida \"bugun uchun +X\" bilan oshiring",
  weekly_pace_exceeded: "Haftalik limitning bugungi ulushi tugadi: yangi sessiya kechiktirildi. Yarim kechada (Toshkent) yangilanadi yoki \"bugun uchun ruxsat\" bering",
};

/** Buyruq xato kodini o'zbekcha matnga o'giradi (noma'lum kod: umumiy matn). */
export function commandErrorText(code: string | null | undefined): string {
  if (!code) return "Buyruq bajarilmadi";
  return ERROR_TEXT[code] ?? `Buyruq bajarilmadi (${code})`;
}

/** HTTP xatolari (biznes rad emas): 400/403/404/409/429/503. */
export function commandHttpErrorText(status: number, body: unknown): string {
  const code = typeof body === "object" && body !== null && "error" in body ? String((body as { error: unknown }).error) : "";
  if (status === 403 && code === "lockdown") return commandErrorText("lockdown");
  if (status === 403) return "Boshqaruv uchun token ruxsati yetarli emas";
  if (status === 409) return code === "idempotency_conflict" ? commandErrorText("idempotency_conflict") : "Bu sessiyada boshqa buyruq bajarilmoqda";
  if (status === 404) return "Sessiya yoki mashina topilmadi";
  if (status === 429) return "Juda ko'p so'rov: birozdan keyin urinib ko'ring";
  if (status === 400) return "So'rov ma'lumoti noto'g'ri";
  if (status === 503) return "COMMANDER_CONTROL_TOKEN sozlanmagan: boshqaruv o'chiq";
  if (status === 401) return "Token rad etildi";
  return `Xatolik (${status || "tarmoq"})`;
}

// --- prompt maydoni holati ------------------------------------------------------------------------

export type PromptBoxKind = "active" | "readonly" | "offline" | "blocked";

export interface PromptBoxState {
  kind: PromptBoxKind;
  /** Faol bo'lmaganda ko'rsatiladigan sabab. */
  reason: string | null;
}

const REASON_TEXT: Record<ControlReason, { kind: Exclude<PromptBoxKind, "active">; text: (machine: string) => string }> = {
  interactive: { kind: "readonly", text: () => "Terminal sessiyasi: faqat ko'rish. Prompt yuborish uchun sessiyani tmux ichida oching yoki Commander orqali boshlang." },
  policy_disabled: { kind: "blocked", text: () => "Bu mashinada masofaviy boshqaruv o'chiq" },
  machine_offline: { kind: "offline", text: (m) => `Chat mavjud emas: ${m} oflayn. Mashina qayta ulanganda boshqaruv tiklanadi.` },
  session_ended: { kind: "blocked", text: () => "Sessiya tugagan: prompt yuborib bo'lmaydi" },
  prompt_not_allowed: { kind: "blocked", text: () => "Bu mashina siyosati prompt yuborishga ruxsat bermaydi" },
  agent_not_ready: { kind: "blocked", text: () => "agentd hali tayyor emas: birozdan keyin urinib ko'ring" },
  agent_outdated: { kind: "blocked", text: () => "Mashinadagi agentd eski: masofaviy boshqaruvni qo'llamaydi" },
};

/** `controlReason` -> prompt-box holati; lockdown va token yo'qligi ham faol maydonni o'chiradi. */
export function promptBoxState(
  s: Pick<SessionDto, "controls" | "controlReason">,
  opts: { lockdown: boolean; canControl: boolean; machine: string },
): PromptBoxState {
  if (!s.controls.prompt) {
    const r = s.controlReason ? REASON_TEXT[s.controlReason] : null;
    return r ? { kind: r.kind, reason: r.text(opts.machine) } : { kind: "readonly", reason: "Bu sessiyaga prompt yuborib bo'lmaydi" };
  }
  if (opts.lockdown) return { kind: "blocked", reason: "Lockdown yoqiq: masofaviy boshqaruv o'chirilgan" };
  if (!opts.canControl) return { kind: "blocked", reason: "COMMANDER_CONTROL_TOKEN sozlanmagan: dashboard boshqaruvi o'chiq" };
  return { kind: "active", reason: null };
}

/** To'xtatish tugmasi: yoqilganmi va nega yo'q. */
export function stopState(s: Pick<SessionDto, "controls">, opts: { lockdown: boolean; canControl: boolean }): { enabled: boolean; hint: string } {
  if (!s.controls.stop) return { enabled: false, hint: "Bu sessiyani to'xtatib bo'lmaydi" };
  if (opts.lockdown) return { enabled: false, hint: "Lockdown yoqiq: boshqaruv o'chirilgan" };
  if (!opts.canControl) return { enabled: false, hint: "COMMANDER_CONTROL_TOKEN sozlanmagan" };
  return { enabled: true, hint: "Sessiyani to'xtatish" };
}

export const SET_MODE_HINT = "Ishlab turgan sessiyada rejimni almashtirib bo'lmaydi; yangi sessiyada tanlang";

// --- buyruq jarayoni -------------------------------------------------------------------------------

export type CommandPhase = "confirming" | "sending" | "running" | "done" | "failed";

export interface CommandProgress {
  phase: CommandPhase;
  /** Qisqa belgi: "Tasdiq kutilmoqda", "Yuborildi", ... */
  label: string;
  /** Qadamlar (`pending` yo'q): faol qadam indeksi. */
  steps: string[];
  active: number;
  error: string | null;
}

const STEPS = ["Yuborildi", "Qabul qilindi", "Bajarilmoqda", "Tayyor"];

export function commandProgress(c: Pick<CommandDto, "status" | "errorCode">): CommandProgress {
  const st: CommandState = c.status;
  if (st === "awaiting_confirmation") return { phase: "confirming", label: "Telegram'da tasdiq kutilmoqda", steps: STEPS, active: -1, error: null };
  if (st === "done") return { phase: "done", label: "Tayyor", steps: STEPS, active: 3, error: null };
  if (st === "failed" || st === "rejected" || st === "expired") {
    const code = c.errorCode ?? (st === "expired" ? "expired" : null);
    return { phase: "failed", label: st === "rejected" ? "Rad etildi" : st === "expired" ? "Muddati o'tdi" : "Bajarilmadi", steps: STEPS, active: -1, error: commandErrorText(code) };
  }
  const active = st === "pending" ? 0 : st === "sent" ? 0 : st === "acked" ? 1 : 2;
  return { phase: active >= 2 ? "running" : "sending", label: STEPS[active], steps: STEPS, active, error: null };
}

export const isInFlight = (c: Pick<CommandDto, "status"> | undefined): boolean => !!c && !isTerminalCommandState(c.status);

// --- Yangi sessiya: mashinalar va rejimlar ------------------------------------------------------------

export interface StartableMachine {
  machine: MachineDto;
  enabled: boolean;
  /** O'chiq bo'lsa sabab. */
  reason: string | null;
}

/** Faqat onlayn va `control.enabled && allowStart` bo'lganlar tanlanadi; qolganlari sababi bilan o'chiq ro'yxatda. */
export function startableMachines(machines: MachineDto[]): StartableMachine[] {
  return machines
    .map((machine): StartableMachine => {
      if (!machine.online) return { machine, enabled: false, reason: "oflayn" };
      if (!machine.control) return { machine, enabled: false, reason: "agentd eski versiya" };
      if (!machine.control.enabled) return { machine, enabled: false, reason: "masofaviy boshqaruv o'chiq" };
      if (!machine.control.allowStart) return { machine, enabled: false, reason: "yangi sessiya ochish taqiqlangan" };
      return { machine, enabled: true, reason: null };
    })
    .sort((a, b) => Number(b.enabled) - Number(a.enabled));
}

export const MODEL_OPTIONS: { id: string; label: string }[] = [
  { id: "opus", label: "opus" },
  { id: "sonnet", label: "sonnet" },
  { id: "haiku", label: "haiku" },
];

export interface ModeOption {
  id: RemotePermissionMode;
  desc: string;
}

const MODE_DESC: Record<RemotePermissionMode, string> = {
  default: "Har amalda so'raydi",
  acceptEdits: "Tahrirlar avtomatik",
  plan: "Faqat reja, o'zgarishsiz",
  auto: "Avtomatik (siyosat ruxsati bilan)",
};

/** `auto` faqat mashina siyosati `allowAutoMode` bo'lsa. */
export function modeOptions(machine: Pick<MachineDto, "control"> | null): ModeOption[] {
  const base: RemotePermissionMode[] = ["default", "acceptEdits", "plan"];
  if (machine?.control?.allowAutoMode) base.push("auto");
  return base.map((id) => ({ id, desc: MODE_DESC[id] }));
}

/** Siyosatni yoqish bo'yicha yo'riqnoma (agentd CLI). */
const POLICY_HINT = "yoqish: `agentd policy enable` va `agentd policy allow-root <papka>`";

/**
 * Mashinada yangi sessiya ochib bo'lmasa sabab (o'zbekcha, yo'riqnoma bilan); mumkin bo'lsa null.
 * Loyiha sahifasi va ro'yxatidagi "Sessiya ochish" tugmalari shuni ishlatadi.
 */
export function startBlockReason(machine: Pick<MachineDto, "online" | "control"> | null | undefined): string | null {
  if (!machine) return "Mashina topilmadi";
  if (!machine.online) return "Mashina oflayn: sessiya ochib bo'lmaydi";
  const c = machine.control;
  if (!c) return "Mashinadagi agentd eski versiya: masofaviy boshqaruvni qo'llamaydi";
  if (!c.enabled) return `Bu mashinada masofaviy boshqaruv o'chiq — ${POLICY_HINT}`;
  if (!c.allowStart) return "Bu mashinada yangi sessiya ochish taqiqlangan (siyosatda allowStart o'chiq)";
  if (c.allowedRootCount === 0) return `Ruxsat etilgan papka yo'q — ${POLICY_HINT}`;
  return null;
}

/** Yangi sessiya oynasining boshlang'ich mashina/papkasi: prefill mashinasi tanlanadigan bo'lsa shu, aks holda birinchi faol. */
export function initialNewSession(prefill: { machineId: string; cwd: string; prompt?: string } | null, list: StartableMachine[]): { machineId: string | null; cwd: string } {
  const firstEnabled = list.find((m) => m.enabled)?.machine.id ?? null;
  if (!prefill) return { machineId: firstEnabled, cwd: "" };
  const ok = list.some((m) => m.enabled && m.machine.id === prefill.machineId);
  return ok ? { machineId: prefill.machineId, cwd: prefill.cwd } : { machineId: firstEnabled, cwd: "" };
}
