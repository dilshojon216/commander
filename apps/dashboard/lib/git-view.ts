import { OpenPrBodySchema, buildPrDefaults, taskKeyFromBranch } from "@commander/contracts";
import type { CommandDto, DiffFile, DiffResponse, ProjectCiDto, ProjectPrDto, TaskCommitDto } from "@commander/contracts";

/** Git/PR (3.5) ko'rinish mantiqi: sof funksiyalar (testlanadi). Diff matni FAQAT React matn tugunlari sifatida chiqariladi (HTML emas). */

// --- patch ko'rinishi ---------------------------------------------------------------------------

export type PatchLineKind = "add" | "del" | "hunk" | "meta" | "ctx";
export interface PatchLine {
  kind: PatchLineKind;
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
export const MAX_RENDER_LINES = 1500;

/**
 * Bitta fayl patch'i -> qatorlar (qo'shilgan/o'chirilgan/kontekst, qator raqamlari). Birinchi `@@` gacha sarlavha (`meta`):
 * undan keyin `---`/`+++` bilan boshlanuvchi qatorlar ham oddiy o'chirilgan/qo'shilgan hisoblanadi. Juda uzun patch kesiladi.
 */
export function parsePatchLines(patch: string, maxLines: number = MAX_RENDER_LINES): { lines: PatchLine[]; truncated: boolean } {
  const lines: PatchLine[] = [];
  let inHunk = false;
  let oldNo = 0;
  let newNo = 0;
  const raw = patch.split("\n");
  if (raw[raw.length - 1] === "") raw.pop();
  for (const text of raw) {
    if (lines.length >= maxLines) return { lines, truncated: true };
    const h = HUNK_RE.exec(text);
    if (h) {
      inHunk = true;
      oldNo = Number(h[1]);
      newNo = Number(h[2]);
      lines.push({ kind: "hunk", text, oldNo: null, newNo: null });
      continue;
    }
    if (text.startsWith("diff --git ")) {
      inHunk = false;
      lines.push({ kind: "meta", text, oldNo: null, newNo: null });
      continue;
    }
    if (!inHunk) {
      lines.push({ kind: "meta", text, oldNo: null, newNo: null });
      continue;
    }
    if (text.startsWith("\\")) lines.push({ kind: "meta", text, oldNo: null, newNo: null });
    else if (text.startsWith("+")) lines.push({ kind: "add", text, oldNo: null, newNo: newNo++ });
    else if (text.startsWith("-")) lines.push({ kind: "del", text, oldNo: oldNo++, newNo: null });
    else lines.push({ kind: "ctx", text, oldNo: oldNo++, newNo: newNo++ });
  }
  return { lines, truncated: false };
}

export const FILE_STATUS_LABEL: Record<DiffFile["status"], string> = {
  added: "yangi",
  modified: "o'zgargan",
  deleted: "o'chirilgan",
  renamed: "nomi o'zgargan",
  copied: "nusxa",
  typechange: "turi o'zgargan",
};

export const HIDDEN_TEXT: Record<NonNullable<DiffFile["hidden"]>, string> = {
  secret: "Maxfiy bo'lishi mumkin bo'lgan fayl: matni ko'rsatilmaydi (faqat +/− soni).",
  binary: "Binar fayl: matni ko'rsatilmaydi.",
  budget: "Diff hajm chegarasi tugadi: bu fayl matni qisqartirildi.",
  stat_only: "Faqat statistika so'ralgan.",
};

export function diffSummaryText(d: DiffResponse["diff"]): string {
  if (d.filesTotal === 0) return "O'zgarish yo'q";
  return `${d.filesTotal} fayl · +${d.totalAdditions} / −${d.totalDeletions}`;
}

export const BASE_SOURCE_TEXT: Record<DiffResponse["baseSource"], string> = {
  session_start: "Sessiya boshidagi commit (SessionStart) bilan taqqoslangan",
  snapshot: "Sessiya boshiga eng yaqin snapshot commit'i bilan taqqoslangan (taxminiy)",
  head: "HEAD bilan taqqoslangan (sessiya boshi noma'lum: faqat commit qilinmagan o'zgarishlar)",
  explicit: "Tanlangan baza bilan taqqoslangan",
};

// --- xato matnlari ------------------------------------------------------------------------------

export const GIT_ERROR_TEXT: Record<string, string> = {
  git_failed: "git buyrug'i bajarilmadi (mashinada git xatosi)",
  machine_offline: "Mashina offline (agentd ulanmagan)",
  agent_outdated: "agentd git buyruqlarini bilmaydi: yangilang",
  policy_disabled: "Bu mashinada masofaviy boshqaruv o'chiq",
  action_not_allowed: "Mashinaning lokal siyosati bu amalga ruxsat bermaydi (allowProjectRead/allowProjectWrite)",
  cwd_not_allowed: "Loyiha papkasi siyosatdagi ruxsat etilgan ildizlardan tashqarida",
  lockdown: "Lockdown yoqilgan: masofaviy amallar bloklangan",
  not_a_git_repo: "Loyiha git repozitoriysi emas",
  base_invalid: "Baza (commit/branch) topilmadi",
  gh_unavailable: "Mashinada GitHub CLI (gh) o'rnatilmagan",
  gh_unauthenticated: "GitHub CLI avtorizatsiyadan o'tmagan: mashinada `gh auth login`",
  no_remote: "Repozitoriyda «origin» yo'q",
  dirty_worktree: "Commit qilinmagan o'zgarishlar bor: avval commit qiling yoki stash qiling",
  on_default_branch: "Asosiy branch'dan (yoki base bilan bir xil branch'dan) PR ochib bo'lmaydi",
  nothing_to_pr: "Branch'da base'dan keyingi commit yo'q",
  push_failed: "Branch'ni origin'ga yuborib bo'lmadi (force ishlatilmaydi)",
  pr_failed: "gh PR ocholmadi",
  step_up_unavailable: "Telegram tasdig'i mavjud emas: buyruq bajarilmadi",
  step_up_expired: "Tasdiq muddati o'tdi",
  step_up_cancelled: "Tasdiq bekor qilindi",
  agent_timeout: "Mashina javob bermadi (vaqt tugadi)",
  dispatch_expired: "Mashina buyruqni qabul qilmadi (vaqt tugadi)",
  invalid_result: "Mashina yaroqsiz natija qaytardi",
  command_in_flight: "Shu loyiha uchun boshqa PR buyrug'i bajarilmoqda",
  no_project: "Sessiya loyihaga bog'lanmagan",
  too_many_open_commands: "Mashinada juda ko'p ochiq buyruq bor",
};

export function gitErrorText(code: string | null | undefined): string {
  if (!code) return "Bajarilmadi";
  return GIT_ERROR_TEXT[code] ?? `Bajarilmadi (${code})`;
}

/** REST xatolari (diff, PR, CI) -> o'zbekcha. */
export function gitHttpErrorText(status: number, body: unknown): string {
  const code = typeof body === "object" && body !== null && "error" in body ? String((body as { error: unknown }).error) : "";
  if (code && GIT_ERROR_TEXT[code]) return GIT_ERROR_TEXT[code]!;
  if (status === 403) return "Boshqaruv uchun token ruxsati yetarli emas";
  if (status === 404) return "Loyiha yoki sessiya topilmadi";
  if (status === 400) return "So'rov ma'lumoti noto'g'ri";
  if (status === 429) return "Juda ko'p so'rov: birozdan keyin urinib ko'ring";
  if (status === 503) return "COMMANDER_CONTROL_TOKEN sozlanmagan: boshqaruv o'chiq";
  if (status === 401) return "Token rad etildi";
  return `Xatolik (${status || "tarmoq"})`;
}

// --- CI --------------------------------------------------------------------------------------------

export interface CiBadge {
  label: string;
  /** `pill` rang klassi. */
  cls: string;
}

export function ciBadge(state: ProjectCiDto["state"]): CiBadge {
  switch (state) {
    case "success":
      return { label: "CI: o'tdi", cls: "bg-grn-bg text-grn" };
    case "failure":
      return { label: "CI: xato", cls: "bg-red-bg text-red" };
    case "pending":
      return { label: "CI: ishlamoqda", cls: "bg-yel-bg text-yel" };
    case "none":
      return { label: "CI: yo'q", cls: "bg-gray-bg text-mu" };
    default:
      return { label: "CI: noma'lum", cls: "bg-gray-bg text-mu" };
  }
}

/** Loyiha uchun asosiy CI qatori: berilgan branch bo'lsa shu, aks holda eng yangisi (ro'yxat yangidan eskiga). */
export function pickCi(ci: readonly ProjectCiDto[], branch: string | null | undefined): ProjectCiDto | null {
  if (branch) {
    const hit = ci.find((c) => c.branch === branch);
    if (hit) return hit;
  }
  return ci[0] ?? null;
}

export const PR_STATE_TEXT: Record<ProjectPrDto["state"], string> = { open: "ochiq", closed: "yopilgan", merged: "birlashtirilgan" };

// --- vazifa bilan bog'lash ------------------------------------------------------------------------------

export function commitsByTask(commits: readonly TaskCommitDto[]): Map<string, TaskCommitDto[]> {
  const m = new Map<string, TaskCommitDto[]>();
  for (const c of commits) {
    const list = m.get(c.taskKey) ?? [];
    list.push(c);
    m.set(c.taskKey, list);
  }
  for (const list of m.values()) list.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  return m;
}

/** Vazifaga tegishli PR'lar: branch nomidan (`task/3.5-x`) yoki sarlavha `[3.5] ...` boshlanishidan. */
export function prsForTask(prs: readonly ProjectPrDto[], taskKey: string): ProjectPrDto[] {
  return prs.filter((p) => taskKeyFromBranch(p.branch) === taskKey || p.title.toLowerCase().startsWith(`[${taskKey.toLowerCase()}]`));
}

export interface TaskGitInfo {
  commits: TaskCommitDto[];
  prs: ProjectPrDto[];
}

export function taskGitInfo(taskKey: string, byTask: ReadonlyMap<string, TaskCommitDto[]>, prs: readonly ProjectPrDto[]): TaskGitInfo | null {
  const commits = byTask.get(taskKey) ?? [];
  const p = prsForTask(prs, taskKey);
  return commits.length === 0 && p.length === 0 ? null : { commits, prs: p };
}

// --- PR formasi ----------------------------------------------------------------------------------------

export const BASE_CHOICES = ["main", "master", "develop", "staging"] as const;
export const OTHER_BASE = "__other__";

export interface PrForm {
  title: string;
  body: string;
  base: string;
  head: string;
  draft: boolean;
}

export function prFormDefaults(i: { branch: string | null; taskKey?: string | null; taskTitle?: string | null; sessionName?: string | null; commitSubjects: readonly string[]; bodyTemplate?: string | null }): PrForm {
  const d = buildPrDefaults({ branch: i.branch, taskKey: i.taskKey ?? null, taskTitle: i.taskTitle ?? null, sessionName: i.sessionName ?? null, commitSubjects: i.commitSubjects, bodyTemplate: i.bodyTemplate ?? null });
  return { title: d.title, body: d.body, base: "main", head: i.branch ?? "", draft: false };
}

export type PrFormErrors = Partial<Record<keyof PrForm, string>>;

/** Forma tekshiruvi: markazdagi sxema bilan bir xil (yagona manba). */
export function validatePrForm(f: PrForm): { ok: true; body: ReturnType<typeof OpenPrBodySchema.parse> } | { ok: false; errors: PrFormErrors } {
  const r = OpenPrBodySchema.safeParse({ title: f.title.trim(), body: f.body, base: f.base.trim(), draft: f.draft, ...(f.head.trim() ? { head: f.head.trim() } : {}) });
  if (r.success) return { ok: true, body: r.data };
  const errors: PrFormErrors = {};
  for (const issue of r.error.issues) {
    const k = issue.path[0];
    if (k === "title") errors.title = f.title.trim() ? "Sarlavha bitta qator bo'lsin (≤ 256 belgi)" : "Sarlavha kerak";
    else if (k === "body") errors.body = "Tana ≤ 16000 belgi, boshqaruv belgilarisiz";
    else if (k === "base") errors.base = "Base branch nomi yaroqsiz";
    else if (k === "head") errors.head = "Head branch nomi yaroqsiz";
  }
  return { ok: false, errors };
}

export function prBlockReason(o: { canControl: boolean; lockdown: boolean; hasProject: boolean }): string | null {
  if (!o.hasProject) return "Sessiya loyihaga bog'lanmagan";
  if (o.lockdown) return "Lockdown yoqilgan: masofaviy amallar bloklangan";
  if (!o.canControl) return "Boshqaruv tokeni sozlanmagan: faqat ko'rish rejimi";
  return null;
}

/** `project.open_pr` buyrug'idan PR natijasi (faqat https URL). */
export function prResultOf(c: Pick<CommandDto, "status" | "result">): { url: string; number: number; existing: boolean } | null {
  if (c.status !== "done") return null;
  const pr = c.result?.pr as { url?: unknown; number?: unknown; existing?: unknown } | undefined;
  if (!pr || typeof pr.url !== "string" || typeof pr.number !== "number" || !/^https:\/\//.test(pr.url)) return null;
  return { url: pr.url, number: pr.number, existing: pr.existing === true };
}
