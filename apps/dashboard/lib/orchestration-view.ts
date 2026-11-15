import type { OrchStatus, OrchStepDto, OrchestrationDto, SessionDto, StepStatus } from "@commander/contracts";

/** Orkestratsiya (3.9) uchun sof ko'rsatish modellari. Prompt/natija matni bu yerda qisqartirilgan ko'rinishda, hech qachon xom emas. */

export type Tone = "blue" | "yel" | "grn" | "red" | "gray";

export const ORCH_STATUS_UZ: Record<OrchStatus, { label: string; tone: Tone }> = {
  planning: { label: "Rejalashtirilmoqda", tone: "yel" },
  running: { label: "Ishlamoqda", tone: "blue" },
  completed: { label: "Tugadi", tone: "grn" },
  failed: { label: "Xato", tone: "red" },
  cancelled: { label: "To'xtatildi", tone: "gray" },
};

export const STEP_STATUS_UZ: Record<StepStatus, { label: string; tone: Tone }> = {
  pending: { label: "Kutmoqda", tone: "gray" },
  dispatched: { label: "Topshirildi", tone: "yel" },
  running: { label: "Jarayonda", tone: "blue" },
  done: { label: "Bajarildi", tone: "grn" },
  failed: { label: "Xato", tone: "red" },
  cancelled: { label: "Bekor", tone: "gray" },
};

export const STEP_ERROR_UZ: Record<string, string> = {
  session_ended: "Ishchi sessiya hisobotsiz tugadi",
  step_up_unavailable: "Telegram tasdig'i mavjud emas",
  step_up_expired: "Tasdiq muddati o'tdi",
  step_up_cancelled: "Tasdiq bekor qilindi",
  confirmation_required: "Navbat uchun egasi tasdig'i kerak",
  machine_offline: "Mashina oflayn",
  action_not_allowed: "Mashina siyosati ruxsat bermadi",
  cwd_not_allowed: "Papka ruxsat etilgan ildizdan tashqarida",
  interactive_session: "Terminal sessiyani boshqarib bo'lmaydi",
  command_in_flight: "Bu sessiyada buyruq hali bajarilmoqda",
  lockdown: "Lockdown yoqilgan",
  queue_cancelled: "Navbat elementi bekor qilindi",
  queue_failed: "Navbat elementi bajarilmadi",
};

export const stepErrorText = (code: string | null): string | null => (code ? (STEP_ERROR_UZ[code] ?? code) : null);

export const isActiveOrch = (o: Pick<OrchestrationDto, "status">): boolean => o.status === "planning" || o.status === "running" || o.status === "failed";

/** Faol birinchi, keyin yangisidan eskisiga. */
export function sortOrchestrations(list: readonly OrchestrationDto[]): OrchestrationDto[] {
  return [...list].sort((a, b) => Number(isActiveOrch(b)) - Number(isActiveOrch(a)) || Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/** Token byudjeti: foiz (0..100, chegaralangan) va rang. */
export function budgetView(o: Pick<OrchestrationDto, "tokensUsed" | "tokenBudget" | "budgetExceeded">): { pct: number; tone: Tone; text: string } {
  const pct = o.tokenBudget > 0 ? Math.min(100, Math.round((o.tokensUsed / o.tokenBudget) * 100)) : 0;
  const tone: Tone = o.budgetExceeded || pct >= 100 ? "red" : pct >= 80 ? "yel" : "blue";
  return { pct, tone, text: `${o.tokensUsed.toLocaleString("en-US")} / ${o.tokenBudget.toLocaleString("en-US")} token` };
}

export interface StepNode {
  step: OrchStepDto;
  /** Bog'liqlik chuqurligi (0 = bog'liqlik yo'q). */
  level: number;
}

/**
 * Daraxt/graf joylashuvi: chuqurlik = eng uzun bog'liqlik zanjiri. Sikl bo'lmasligi serverda kafolatlanadi, lekin bu funksiya
 * himoya uchun cheksiz rekursiyaga tushmaydi (ziyoratlar chegaralanadi).
 */
export function layoutSteps(steps: readonly OrchStepDto[]): StepNode[][] {
  const byKey = new Map(steps.map((s) => [s.key, s]));
  const memo = new Map<string, number>();
  const depth = (key: string, seen: Set<string>): number => {
    const known = memo.get(key);
    if (known !== undefined) return known;
    if (seen.has(key)) return 0;
    seen.add(key);
    const s = byKey.get(key);
    const d = s && s.dependsOn.length > 0 ? 1 + Math.max(...s.dependsOn.map((k) => depth(k, seen))) : 0;
    seen.delete(key);
    memo.set(key, d);
    return d;
  };
  const levels: StepNode[][] = [];
  for (const s of steps) {
    const level = depth(s.key, new Set());
    (levels[level] ??= []).push({ step: s, level });
  }
  return levels.map((l) => l ?? []);
}

export interface TimelineItem {
  at: number;
  text: string;
  tone: Tone;
}

/** Vaqt chizig'i: boshlandi, har qadam topshirildi/yakunlandi, orkestratsiya yakuni. Vaqti noma'lum yozuvlar tushmaydi. */
export function buildTimeline(o: OrchestrationDto): TimelineItem[] {
  const items: TimelineItem[] = [{ at: Date.parse(o.createdAt), text: `Orkestratsiya yaratildi (${o.origin === "lead" ? "bosh sessiya" : "dashboard"})`, tone: "gray" }];
  for (const s of o.steps) {
    if (s.dispatchedAt) items.push({ at: Date.parse(s.dispatchedAt), text: `"${s.key}" topshirildi${s.assignedLabel ? ` -> ${s.assignedLabel}` : ""}`, tone: "yel" });
    if (s.finishedAt) {
      const t = STEP_STATUS_UZ[s.status];
      items.push({ at: Date.parse(s.finishedAt), text: `"${s.key}" ${t.label.toLowerCase()}${s.status === "failed" && s.lastError ? ` (${stepErrorText(s.lastError)})` : ""}`, tone: t.tone });
    }
  }
  if (o.finishedAt) items.push({ at: Date.parse(o.finishedAt), text: `Orkestratsiya: ${ORCH_STATUS_UZ[o.status].label.toLowerCase()}`, tone: ORCH_STATUS_UZ[o.status].tone });
  return items.filter((i) => Number.isFinite(i.at)).sort((a, b) => a.at - b.at);
}

export interface LeadChoice {
  id: string;
  label: string;
}

/** Lead sifatida tanlanadigan sessiyalar: loyihaning faol, boshqariladigan (prompt qabul qiladigan) sessiyalari. */
export function leadCandidates(sessions: readonly SessionDto[], projectId: string, busyLeadIds: ReadonlySet<string>): LeadChoice[] {
  return sessions
    .filter((s) => s.projectId === projectId && s.endedAt === null && s.controls.prompt && !busyLeadIds.has(s.id))
    .map((s) => ({ id: s.id, label: `${s.name ?? s.projectName} · ${s.id.slice(0, 8)} · ${s.status}` }));
}

export interface CreateForm {
  goal: string;
  leadKind: "session" | "new";
  sessionId: string;
  tokenBudget: string;
  maxConcurrent: string;
}

export const EMPTY_CREATE_FORM: CreateForm = { goal: "", leadKind: "new", sessionId: "", tokenBudget: "", maxConcurrent: "3" };

export type CreateResult = { ok: true; body: Record<string, unknown> } | { ok: false; error: string };

/** Formadan REST tanasi. `taskKey` vazifa kartasidan keladi ("Bosh sessiyaga topshirish"). */
export function buildCreateBody(f: CreateForm, ctx: { projectId: string; machineId: string; cwd: string; taskKey?: string | null }): CreateResult {
  const goal = f.goal.trim();
  if (goal.length === 0) return { ok: false, error: "Maqsadni yozing" };
  if (goal.length > 2000) return { ok: false, error: "Maqsad 2000 belgidan oshmasin" };
  const conc = Number(f.maxConcurrent);
  if (!Number.isInteger(conc) || conc < 1 || conc > 8) return { ok: false, error: "Parallel sessiyalar 1 dan 8 gacha" };
  let budget: number | undefined;
  if (f.tokenBudget.trim() !== "") {
    budget = Number(f.tokenBudget.replace(/[\s_,]/g, ""));
    if (!Number.isInteger(budget) || budget < 10_000 || budget > 100_000_000) return { ok: false, error: "Token byudjeti 10 ming dan 100 mln gacha" };
  }
  if (f.leadKind === "session" && f.sessionId === "") return { ok: false, error: "Bosh sessiyani tanlang" };
  const lead = f.leadKind === "session" ? { type: "session", sessionId: f.sessionId } : { type: "new", machineId: ctx.machineId, cwd: ctx.cwd, permissionMode: "default" };
  return { ok: true, body: { goal, projectId: ctx.projectId, lead, maxConcurrent: conc, ...(budget ? { tokenBudget: budget } : {}), ...(ctx.taskKey ? { taskKey: ctx.taskKey } : {}) } };
}

/** HTTP xato -> o'zbekcha matn. */
export function orchHttpErrorText(status: number, body: unknown): string {
  const code = typeof body === "object" && body !== null && "error" in body ? String((body as { error: unknown }).error) : "";
  switch (code) {
    case "step_up_unavailable":
      return "Yangi bosh sessiya ochish uchun Telegram tasdig'i kerak, lekin Telegram mavjud emas";
    case "step_up_required":
      return "Bu qurilmadan tasdiq talab qilinadi";
    case "lead_busy":
      return "Bu sessiya allaqachon boshqa orkestratsiyani boshqarmoqda";
    case "lead_not_in_group":
      return "Bosh sessiya shu loyiha guruhiga kirmaydi";
    case "cwd_not_in_group":
      return "Papka shu guruh loyihalaridan biri ichida bo'lishi shart";
    case "invalid_task_key":
      return "Vazifa id'si yaroqsiz";
    case "machine_offline":
      return "Mashina oflayn";
    case "action_not_allowed":
    case "policy_disabled":
      return "Mashina siyosati bu amalni taqiqlaydi";
    default:
      break;
  }
  if (status === 403) return "Ruxsat yo'q (lockdown yoki token)";
  if (status === 404) return "Topilmadi";
  if (status === 409) return "Holat mos emas (band yoki allaqachon bajarilgan)";
  if (status === 429) return "Juda tez-tez urinish";
  if (status >= 500) return "Server xatosi";
  return "So'rov bajarilmadi";
}

/** "To'xtatish" tugmasi faolmi, o'chiq bo'lsa sababi. Lockdown'da ham ruxsat (xavfsiz tomonga), faqat token kerak. */
export function stopReason(o: Pick<OrchestrationDto, "status">, ctx: { canControl: boolean }): string | null {
  if (!isActiveOrch(o)) return "Orkestratsiya allaqachon yakunlangan";
  if (!ctx.canControl) return "Boshqaruv tokeni sozlanmagan";
  return null;
}

/** Yaratish tugmasi o'chiq sababi (lockdown yoki token). */
export function createReason(ctx: { lockdown: boolean; canControl: boolean }): string | null {
  if (ctx.lockdown) return "Lockdown yoqiq";
  if (!ctx.canControl) return "Boshqaruv tokeni sozlanmagan";
  return null;
}

export function progressText(o: Pick<OrchestrationDto, "counts" | "steps">): string {
  return o.steps.length === 0 ? "Reja hali tuzilmagan" : `${o.counts.done}/${o.steps.length} qadam`;
}
