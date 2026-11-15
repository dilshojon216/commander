import { RULE_DURATIONS, RULE_LIMITS, validatePathGlob } from "@commander/contracts";
import type { ApprovalRuleDto, CreateApprovalRuleBody, RuleScope } from "@commander/contracts";

/** Avto-ruxsat qoidalari UI mantig'i (sof, testlanadi). Markaz (Zod) baribir qayta tekshiradi. */

export const RULE_TOOL_OPTIONS = [
  { id: "Edit", label: "Edit", hint: "Faylni tahrirlash" },
  { id: "Write", label: "Write", hint: "Fayl yozish" },
  { id: "MultiEdit", label: "MultiEdit", hint: "Ko'p joyni tahrirlash" },
  { id: "NotebookEdit", label: "NotebookEdit", hint: "Notebook tahriri" },
  { id: "Read", label: "Read", hint: "Fayl o'qish" },
  { id: "Glob", label: "Glob", hint: "Fayl qidirish" },
  { id: "Grep", label: "Grep", hint: "Matn qidirish" },
] as const;

export const RULE_DURATION_OPTIONS = RULE_DURATIONS;
export type RuleDurationId = (typeof RULE_DURATIONS)[number]["id"];
export const DEFAULT_RULE_DURATION: RuleDurationId = "1h";
export const DEFAULT_RULE_TOOLS: readonly string[] = ["Edit", "Write", "MultiEdit"];

export const RULES_SAFETY_NOTE = "Bash va shell vositalari hech qachon avto-ruxsat olmaydi. .git, .claude, .env va kalit fayllari doim qo'lda tasdiqlanadi.";

export interface RuleFormState {
  tools: string[];
  globsText: string;
  duration: RuleDurationId;
}

export const initialRuleForm = (): RuleFormState => ({ tools: [...DEFAULT_RULE_TOOLS], globsText: "", duration: DEFAULT_RULE_DURATION });

/** Glob'lar vergul yoki yangi qator bilan ajratiladi; bo'sh qatorlar tashlanadi, takrorlar olib tashlanadi. */
export function parseGlobs(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(/[\n,]/)) {
    const g = part.trim();
    if (g !== "" && !out.includes(g)) out.push(g);
  }
  return out;
}

export type RuleFormResult = { ok: true; body: CreateApprovalRuleBody } | { ok: false; error: string };

export function buildRuleBody(scope: RuleScope, scopeRef: string, form: RuleFormState): RuleFormResult {
  if (form.tools.length === 0) return { ok: false, error: "Kamida bitta vosita tanlang" };
  const globs = parseGlobs(form.globsText);
  if (globs.length > RULE_LIMITS.maxGlobs) return { ok: false, error: `Eng ko'pi bilan ${RULE_LIMITS.maxGlobs} ta yo'l andozasi` };
  for (const g of globs) {
    if (validatePathGlob(g) !== null) return { ok: false, error: `Yo'l andozasi yaroqsiz: «${g}» (nisbiy bo'lishi, «..» va «/» bilan boshlanmasligi kerak)` };
  }
  const d = RULE_DURATIONS.find((x) => x.id === form.duration);
  if (!d) return { ok: false, error: "Muddat tanlang" };
  return { ok: true, body: { scope, scopeRef, tools: form.tools, pathGlobs: globs, ttlSeconds: d.seconds } };
}

/** Markaz xatosini foydalanuvchi matniga aylantiradi. */
export function ruleErrorText(status: number, body: unknown): string {
  const code = typeof body === "object" && body !== null && "error" in body ? String((body as { error: unknown }).error) : "";
  if (status === 403 && code === "step_up_required") return "Qoida yaratish Telegram tasdig'ini talab qiladi: uni Telegram'dagi ruxsat xabaridan yarating (yoki lokal dashboard)";
  if (status === 403 && code === "lockdown") return "Lockdown yoqiq: qoida yaratib bo'lmaydi";
  if (status === 403) return "Ruxsat yo'q (control token kerak)";
  if (status === 404 && code === "scope_not_found") return "Sessiya yoki loyiha topilmadi";
  if (status === 404) return "Qoida topilmadi";
  if (status === 409) return "Faol qoidalar soni chegarasiga yetildi";
  if (status === 400) return "So'rov yaroqsiz (vosita yoki yo'l andozasi)";
  if (status === 503) return "COMMANDER_CONTROL_TOKEN sozlanmagan";
  if (status === 401) return "Token rad etildi";
  return `Xatolik (${status || "tarmoq"})`;
}

/** Qoida muddati: "58 daq qoldi" / "2 soat 5 daq qoldi" / "tugagan". */
export function ruleRemaining(rule: Pick<ApprovalRuleDto, "expiresAt" | "status">, now: number): string {
  if (rule.status === "revoked") return "bekor qilingan";
  const left = Date.parse(rule.expiresAt) - now;
  if (rule.status === "expired" || left <= 0) return "muddati tugagan";
  const min = Math.ceil(left / 60_000);
  if (min < 60) return `${min} daq qoldi`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} soat ${min % 60} daq qoldi`;
  return `${Math.floor(h / 24)} kun ${h % 24} soat qoldi`;
}

export function ruleSummary(rule: Pick<ApprovalRuleDto, "tools" | "pathGlobs">): string {
  const tools = rule.tools.join(", ");
  return rule.pathGlobs.length === 0 ? `${tools}: loyiha papkasi ichidagi hamma fayl` : `${tools}: ${rule.pathGlobs.join(", ")}`;
}

export const SCOPE_LABEL: Record<RuleScope, string> = { session: "sessiya", project: "loyiha", repo: "repo" };

/** Yig'ilgan panel bir qatorli xulosasi: faol qoidalar soni (yuklanmagan bo'lsa `null`). */
export function rulesCollapsedSummary(rules: readonly Pick<ApprovalRuleDto, "status">[] | null): string | null {
  if (rules === null) return null;
  const n = rules.filter((r) => r.status === "active").length;
  return n === 0 ? "Faol qoida yo'q" : `${n} ta faol qoida`;
}
