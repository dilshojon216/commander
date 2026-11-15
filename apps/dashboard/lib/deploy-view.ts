import { DeploySummarySchema, RECIPE_HASH_RE, describeStep, describeTargetPlan } from "@commander/contracts";
import type { CommandDto, DeployInspectResult, DeployPhase, DeployRunBody, DeployRunDto, DeploySummary, DeployTarget } from "@commander/contracts";
import { deployErrorText } from "./deploy-ui";
import { formatDuration, formatRelative } from "./format";

/** Deploy (6.5) ko'rinish mantig'i: sof funksiyalar (testlanadi). Komponentlar faqat shu modellarni chizadi. */

export type Tone = "ok" | "warn" | "err" | "info" | "mute";
/** `pill` sinflari (light/dark mavjud tokenlar orqali). */
export const TONE_CLASS: Record<Tone, string> = {
  ok: "bg-grn-bg text-grn",
  warn: "bg-yel-bg text-yel",
  err: "bg-red-bg text-red",
  info: "bg-blue-bg text-blue",
  mute: "bg-gray-bg text-mu",
};

export interface Badge {
  label: string;
  tone: Tone;
}

export const short8 = (s: string | null | undefined): string => (s ? s.slice(0, 8) : "—");

export const ENABLE_DEPLOY_HINT = "Bu mashinada deploy o'chiq: `agentd policy allow-deploy`";
export const ENABLE_SHELL_HINT = "Retsept shell: qadamlarini ishlatadi, lekin mashinada ular o'chiq: `agentd policy allow-deploy-shell`";
export const RECIPE_NOT_COMMITTED_HINT = ".commander/deploy.yml commit qilinmagan: faylni commit qiling (deploy faqat commit'dagi retseptni ishlatadi), so'ng qayta tekshiring";
export const RECIPE_MISSING_HINT = "Bu commit'da .commander/deploy.yml yo'q: retsept yarating, commit qiling va qayta tekshiring";
export const OUTPUT_NOT_STORED = "Chiqish saqlanmaydi: faqat jonli ko'rinadi, keyin faqat qadamlar xulosasi qoladi";

// --- inspect -> karta modeli ---------------------------------------------------------------------

export interface TargetCardModel {
  name: string;
  machine: string;
  cwd: string;
  timeoutSec: number;
  usesShell: boolean;
  machineMatches: boolean;
  /** Egasi tasdiqlaydigan aniq buyruqlar (deploy): faqat React matn tuguni sifatida chiqariladi. */
  plan: string;
  /** Rollback qadamlari (bo'lsa). */
  rollbackPlan: string | null;
  healthText: string | null;
  rollbackDefined: boolean;
  badges: Badge[];
  /** Deploy'ni to'sadigan sabablar (bo'sh = mumkin). */
  blockReasons: string[];
  /** To'smaydigan ogohlantirishlar. */
  warnings: string[];
}

export interface InspectModel {
  commit: string;
  commit8: string;
  branch: string | null;
  dirty: boolean;
  recipeHash: string | null;
  recipeHash8: string;
  valid: boolean;
  issues: string[];
  /** Retsept bo'yicha umumiy yo'riqnoma/ogohlantirishlar (sarlavha qismi). */
  notices: { tone: Tone; text: string }[];
  /** `allowDeploy=false`: butun deploy bo'limi o'chiq. */
  policyOff: boolean;
  targets: TargetCardModel[];
}

function healthSummary(t: DeployTarget): string | null {
  const h = t.health;
  if (!h) return null;
  const what = h.kind === "http" ? `GET ${h.url ?? ""} (kutilgan: ${h.expectStatus.join(", ")})` : describeStep({ kind: "argv", argv: h.argv, shell: null });
  return `${what} · ${1 + h.retries} urinish, har ${h.intervalSec} s, urinish muddati ${h.timeoutSec} s`;
}

/** Bitta maqsad uchun deploy to'siqlari (tartib: eng muhimi birinchi). */
export function targetBlockReasons(i: DeployInspectResult, t: DeployTarget): string[] {
  const r: string[] = [];
  if (!i.allowDeploy) r.push(ENABLE_DEPLOY_HINT);
  if (!i.recipePresent) r.push(i.workingTreeDiffers ? RECIPE_NOT_COMMITTED_HINT : RECIPE_MISSING_HINT);
  else if (!i.valid || i.recipeHash === null || !RECIPE_HASH_RE.test(i.recipeHash)) r.push("Retsept yaroqsiz: muammolar ro'yxatini tuzating");
  if (i.dirty) r.push("Ishchi daraxtda commit qilinmagan o'zgarish bor: deploy rad etiladi (commit yoki stash qiling)");
  if (i.machineMatches[t.name] !== true) r.push(`Maqsad mashina mos emas: retseptda machine: ${t.machine} (bu loyiha shu mashinada emas)`);
  if (t.usesShell && !i.allowDeployShell) r.push(ENABLE_SHELL_HINT);
  return r;
}

export function buildTargetCard(i: DeployInspectResult, t: DeployTarget): TargetCardModel {
  const machineMatches = i.machineMatches[t.name] === true;
  const badges: Badge[] = [{ label: machineMatches ? `mashina: ${t.machine}` : `mashina mos emas: ${t.machine}`, tone: machineMatches ? "mute" : "err" }];
  if (t.usesShell) badges.push({ label: "shell", tone: i.allowDeployShell ? "warn" : "err" });
  badges.push(t.rollback.length > 0 ? { label: "rollback bor", tone: "ok" } : { label: "rollback yo'q", tone: "mute" });
  const warnings: string[] = [];
  if (t.usesShell) warnings.push(i.allowDeployShell ? "Shell qadamlari bor: buyruqlarni diqqat bilan o'qing (sh -c)" : ENABLE_SHELL_HINT);
  if (t.rollback.length === 0) warnings.push("Retseptda rollback qadamlari yo'q: muvaffaqiyatsiz deploy avtomatik qaytarilmaydi");
  return {
    name: t.name,
    machine: t.machine,
    cwd: t.cwd,
    timeoutSec: t.timeoutSec,
    usesShell: t.usesShell,
    machineMatches,
    plan: describeTargetPlan(t, "run"),
    rollbackPlan: t.rollback.length > 0 ? describeTargetPlan(t, "rollback") : null,
    healthText: healthSummary(t),
    rollbackDefined: t.rollback.length > 0,
    badges,
    blockReasons: targetBlockReasons(i, t),
    warnings,
  };
}

export function buildInspectModel(i: DeployInspectResult): InspectModel {
  const notices: { tone: Tone; text: string }[] = [];
  if (!i.allowDeploy) notices.push({ tone: "warn", text: ENABLE_DEPLOY_HINT });
  if (!i.recipePresent) notices.push({ tone: "err", text: i.workingTreeDiffers ? RECIPE_NOT_COMMITTED_HINT : RECIPE_MISSING_HINT });
  else if (i.workingTreeDiffers) notices.push({ tone: "warn", text: "Ishchi daraxtdagi retsept commit'dagidan farq qiladi: deploy FAQAT commit'dagi retseptni ishlatadi" });
  if (i.dirty) notices.push({ tone: "warn", text: "Commit qilinmagan o'zgarishlar bor: deploy rad etiladi (commit yoki stash qiling)" });
  return {
    commit: i.commit,
    commit8: short8(i.commit),
    branch: i.branch,
    dirty: i.dirty,
    recipeHash: i.recipeHash,
    recipeHash8: short8(i.recipeHash),
    valid: i.valid,
    issues: i.issues,
    notices,
    policyOff: !i.allowDeploy,
    targets: i.recipe ? i.recipe.targets.map((t) => buildTargetCard(i, t)) : [],
  };
}

/** Deploy tanasi: AYNAN tekshirilgan (target, recipeHash, commit) uchlik; to'siq bo'lsa `null`. */
export function buildRunBody(i: DeployInspectResult, targetName: string): DeployRunBody | null {
  const t = i.recipe?.targets.find((x) => x.name === targetName);
  if (!t || i.recipeHash === null || !RECIPE_HASH_RE.test(i.recipeHash)) return null;
  if (targetBlockReasons(i, t).length > 0) return null;
  return { target: t.name, recipeHash: i.recipeHash, commit: i.commit };
}

// --- tasdiq dialogi --------------------------------------------------------------------------------

export interface ConfirmModel {
  kind: "run" | "rollback";
  title: string;
  target: string;
  commit: string;
  commit8: string;
  recipeHash: string;
  recipeHash8: string;
  machine: string | null;
  cwd: string | null;
  /** Bajariladigan buyruqlar (bo'lsa): rollback uchun inspect hozirgi retsept bilan mos kelmasa `null`. */
  plan: string | null;
  planNote: string | null;
  warnings: string[];
}

export function buildRunConfirm(i: DeployInspectResult, targetName: string): ConfirmModel | null {
  const body = buildRunBody(i, targetName);
  const t = i.recipe?.targets.find((x) => x.name === targetName);
  if (!body || !t) return null;
  return {
    kind: "run",
    title: `Deploy: ${t.name}`,
    target: body.target,
    commit: body.commit,
    commit8: short8(body.commit),
    recipeHash: body.recipeHash,
    recipeHash8: short8(body.recipeHash),
    machine: t.machine,
    cwd: t.cwd,
    plan: describeTargetPlan(t, "run"),
    planNote: null,
    warnings: buildTargetCard(i, t).warnings,
  };
}

/** Rollback tasdig'i: tarix qatoridagi (target, commit, hash). Buyruqlar faqat oxirgi tekshiruv shu commit/xeshga mos bo'lsa ko'rsatiladi. */
export function buildRollbackConfirm(run: Pick<DeployRunDto, "target" | "commit" | "recipeHash">, inspect: DeployInspectResult | null): ConfirmModel {
  const t = inspect && inspect.commit === run.commit && inspect.recipeHash === run.recipeHash ? (inspect.recipe?.targets.find((x) => x.name === run.target) ?? null) : null;
  return {
    kind: "rollback",
    title: `Rollback: ${run.target}`,
    target: run.target,
    commit: run.commit,
    commit8: short8(run.commit),
    recipeHash: run.recipeHash,
    recipeHash8: short8(run.recipeHash),
    machine: t?.machine ?? null,
    cwd: t?.cwd ?? null,
    plan: t ? describeTargetPlan(t, "rollback") : null,
    planNote: t ? null : "Buyruqlar shu commit'dagi retseptdan agentd tomonidan o'qiladi (xesh mos kelmasa rad etiladi). Aniq buyruqlarni ko'rish uchun avval \"Retseptni tekshirish\" ni bosing.",
    warnings: ["Rollback shu commit va retsept xeshi uchun retseptdagi rollback qadamlarini mashinada bajaradi"],
  };
}

/** Dialogning "Tasdiqlash" tugmasi yuboradigan tana: modeldan, hech narsa qo'shilmaydi/o'zgarmaydi. */
export const confirmBody = (m: ConfirmModel): DeployRunBody => ({ target: m.target, recipeHash: m.recipeHash, commit: m.commit });

// --- natija xulosasi --------------------------------------------------------------------------------

/** `command.result.deploy` -> tekshirilgan xulosa (yaroqsiz bo'lsa `null`). */
export function parseDeploySummary(result: unknown): DeploySummary | null {
  const d = typeof result === "object" && result !== null && "deploy" in result ? (result as { deploy: unknown }).deploy : null;
  const r = DeploySummarySchema.safeParse(d);
  return r.success ? r.data : null;
}

export const PHASE_LABEL: Record<DeployPhase, string> = {
  preflight: "Oldindan tekshiruv",
  steps: "Qadamlar",
  health: "Sog'liq tekshiruvi",
  rollback: "Rollback",
  rollback_health: "Rollback sog'liq tekshiruvi",
};

const STEP_STATUS: Record<string, Badge> = {
  ok: { label: "OK", tone: "ok" },
  failed: { label: "xato", tone: "err" },
  timeout: { label: "vaqt tugadi", tone: "err" },
  skipped: { label: "o'tkazildi", tone: "mute" },
};

export interface StepRow {
  key: string;
  phase: string;
  name: string;
  status: Badge;
  exit: string;
  duration: string;
}

export function summaryRows(s: DeploySummary): StepRow[] {
  return s.steps.map((st, idx) => ({
    key: `${idx}-${st.phase}-${st.name}`,
    phase: PHASE_LABEL[st.phase],
    name: st.name,
    status: STEP_STATUS[st.status] ?? { label: st.status, tone: "mute" },
    exit: st.exitCode === null ? "—" : String(st.exitCode),
    duration: formatDuration(st.durationMs),
  }));
}

export const OUTCOME_BADGE: Record<DeploySummary["outcome"], Badge> = {
  success: { label: "Muvaffaqiyatli", tone: "ok" },
  failed: { label: "Muvaffaqiyatsiz", tone: "err" },
  rolled_back: { label: "Qaytarildi (rollback)", tone: "warn" },
  rollback_failed: { label: "Rollback bajarilmadi", tone: "err" },
};

/** Natija sarlavhasi (progress panelida): outcome + muvaffaqiyatsiz bosqich/qadam. */
export function summaryHeadline(s: DeploySummary): { badge: Badge; detail: string | null } {
  const badge = OUTCOME_BADGE[s.outcome];
  const failed = s.failedStep ? `${s.failedPhase ? PHASE_LABEL[s.failedPhase] : "Bosqich"}: ${s.failedStep}` : s.failedPhase ? PHASE_LABEL[s.failedPhase] : null;
  const health = s.health ? `Sog'liq: ${s.health.ok ? "OK" : "o'tmadi"} (${s.health.attempts} urinish${s.health.lastStatus === null ? "" : `, oxirgi HTTP ${s.health.lastStatus}`})` : null;
  return { badge, detail: [failed, health, s.outputTruncated ? "chiqish qisqartirilgan" : null].filter((x): x is string => x !== null).join(" · ") || null };
}

// --- buyruq jarayoni (run/rollback) --------------------------------------------------------------------

export type RunPhase = "confirm_telegram" | "confirm_dashboard" | "waiting" | "running" | "done" | "failed";

export interface RunProgress {
  phase: RunPhase;
  label: string;
  /** Jonli chiqishni o'qish kerakmi (sent/acked/running va tugagan holatlar: tugagach ham oxirgi qatorlar o'qiladi). */
  streaming: boolean;
  error: string | null;
  summary: DeploySummary | null;
}

export function runProgress(c: Pick<CommandDto, "status" | "errorCode" | "errorMessage" | "result" | "review">): RunProgress {
  const summary = parseDeploySummary(c.result);
  const st = c.status;
  if (st === "awaiting_confirmation") {
    return c.review?.required === true
      ? { phase: "confirm_dashboard", label: "To'liq ko'rib chiqib, shu yerda tasdiqlang", streaming: false, error: null, summary }
      : { phase: "confirm_telegram", label: "Telegram'da tasdiqlang (2 daqiqa)", streaming: false, error: null, summary };
  }
  if (st === "pending") return { phase: "waiting", label: "Yuborilmoqda…", streaming: false, error: null, summary };
  if (st === "sent" || st === "acked" || st === "running") return { phase: "running", label: st === "sent" ? "Mashinaga yuborildi" : "Bajarilmoqda", streaming: true, error: null, summary };
  if (st === "done") return { phase: "done", label: "Tayyor", streaming: true, error: null, summary };
  const code = c.errorCode ?? (st === "expired" ? "expired" : null);
  const label = st === "rejected" ? "Rad etildi" : st === "expired" ? "Muddati o'tdi" : "Bajarilmadi";
  // deploy xatosida (qadam muvaffaqiyatsiz) chiqish ham bor: o'qishda davom etamiz
  return { phase: "failed", label, streaming: summary !== null || code === "deploy_failed" || code === "health_check_failed", error: deployErrorText(code), summary };
}

// --- tarix --------------------------------------------------------------------------------------------

export interface RunRow {
  commandId: string;
  time: string;
  kindLabel: string;
  kind: "run" | "rollback";
  target: string;
  commit8: string;
  hash8: string;
  status: Badge;
  outcome: Badge | null;
  duration: string;
  failedStep: string | null;
  steps: StepRow[];
  canRollback: boolean;
  /** Rollback tanasi uchun to'liq (target, commit, hash). */
  run: Pick<DeployRunDto, "target" | "commit" | "recipeHash">;
}

const TERMINAL = new Set(["done", "failed", "rejected", "expired"]);

function statusBadge(r: DeployRunDto): Badge {
  switch (r.status) {
    case "done":
      return { label: "Tayyor", tone: "ok" };
    case "failed":
      return { label: "Xato", tone: "err" };
    case "rejected":
      return { label: "Rad etildi", tone: "err" };
    case "expired":
      return { label: "Muddati o'tdi", tone: "mute" };
    case "awaiting_confirmation":
      return { label: "Tasdiq kutilmoqda", tone: "warn" };
    case "pending":
    case "sent":
    case "acked":
    case "running":
      return { label: "Bajarilmoqda", tone: "info" };
    default:
      return { label: r.status, tone: "mute" };
  }
}

/** Yangi birinchi. */
export const sortRuns = (items: DeployRunDto[]): DeployRunDto[] => [...items].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

/**
 * Rollback tugmasi: faqat shu maqsadning ENG OXIRGI deploy'i (`run`), xulosada rollback bor, hali qaytarilmagan
 * (o'zi `rolled_back` emas va undan keyin muvaffaqiyatli rollback yo'q) va shu maqsadda bajarilayotgan buyruq yo'q.
 */
export function canRollbackRun(row: DeployRunDto, sortedAll: DeployRunDto[]): boolean {
  if (row.kind !== "run" || !row.summary || !row.summary.rollbackDefined) return false;
  if (!TERMINAL.has(row.status) || row.status === "rejected" || row.status === "expired") return false;
  const sameTarget = sortedAll.filter((r) => r.target === row.target);
  const latestRun = sameTarget.find((r) => r.kind === "run");
  if (!latestRun || latestRun.commandId !== row.commandId) return false;
  if (row.summary.outcome === "rolled_back") return false;
  if (sameTarget.some((r) => !TERMINAL.has(r.status))) return false;
  const rowTs = Date.parse(row.createdAt);
  const rolledBackLater = sameTarget.some((r) => r.kind === "rollback" && Date.parse(r.createdAt) > rowTs && r.status === "done" && r.summary?.outcome === "success");
  return !rolledBackLater;
}

export function runHistoryRows(items: DeployRunDto[], now: number): RunRow[] {
  const sorted = sortRuns(items);
  return sorted.map((r) => ({
    commandId: r.commandId,
    time: formatRelative(Date.parse(r.createdAt) / 1000, now),
    kindLabel: r.kind === "rollback" ? "Rollback" : "Deploy",
    kind: r.kind,
    target: r.target,
    commit8: short8(r.commit),
    hash8: short8(r.recipeHash),
    status: statusBadge(r),
    outcome: r.summary ? OUTCOME_BADGE[r.summary.outcome] : null,
    duration: r.summary ? formatDuration(r.summary.durationMs) : r.finishedAt ? formatDuration(Date.parse(r.finishedAt) - Date.parse(r.createdAt)) : "—",
    failedStep: r.summary?.failedStep ?? (r.errorCode && r.status !== "done" ? deployErrorText(r.errorCode) : null),
    steps: r.summary ? summaryRows(r.summary) : [],
    canRollback: canRollbackRun(r, sorted),
    run: { target: r.target, commit: r.commit, recipeHash: r.recipeHash },
  }));
}
