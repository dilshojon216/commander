import type { CreateDecisionBody, DecisionDto, PatchDecisionBody } from "@commander/contracts";
import { DECISION_LIMITS } from "@commander/contracts";

/** Qarorlar jurnali: guruhlash, forma tekshiruvi (zod chegaralariga mos), PATCH tanasi (sof). */

export interface DecisionGroups {
  proposed: DecisionDto[];
  active: DecisionDto[];
  archived: DecisionDto[];
}

function newestFirst(a: DecisionDto, b: DecisionDto): number {
  const d = Date.parse(b.createdAt) - Date.parse(a.createdAt);
  return d !== 0 && !Number.isNaN(d) ? d : a.id.localeCompare(b.id);
}

/** Holat bo'yicha ajratadi, har guruh eng yangisi birinchi. */
export function groupDecisions(items: DecisionDto[]): DecisionGroups {
  const g: DecisionGroups = { proposed: [], active: [], archived: [] };
  for (const d of items) g[d.status].push(d);
  g.proposed.sort(newestFirst);
  g.active.sort(newestFirst);
  g.archived.sort(newestFirst);
  return g;
}

/** Yangilangan yozuvni ro'yxatga qo'yadi (id bo'yicha almashtiradi yoki qo'shadi). */
export function upsertDecision(items: DecisionDto[], d: DecisionDto): DecisionDto[] {
  const i = items.findIndex((x) => x.id === d.id);
  if (i === -1) return [d, ...items];
  const next = items.slice();
  next[i] = d;
  return next;
}

export const SOURCE_LABEL: Record<DecisionDto["source"], string> = {
  session: "sessiya yozgan",
  owner: "egasi yozgan",
  summary: "xulosadan taklif",
};

export interface DecisionForm {
  title: string;
  decision: string;
  reason: string;
  /** Har qatorda bitta muqobil. */
  alternatives: string;
}

export const EMPTY_DECISION_FORM: DecisionForm = { title: "", decision: "", reason: "", alternatives: "" };

export function formFromDecision(d: DecisionDto): DecisionForm {
  return { title: d.title, decision: d.decision, reason: d.reason, alternatives: d.alternatives.join("\n") };
}

export function parseAlternatives(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

export type DecisionField = "title" | "decision" | "reason" | "alternatives";
export type DecisionErrors = Partial<Record<DecisionField, string>>;

function textError(label: string, raw: string, max: number): string | undefined {
  const t = raw.trim();
  if (t === "") return `${label} bo'sh bo'lmasin`;
  if (t.length > max) return `${label} ${max} belgidan oshmasin (${t.length})`;
  return undefined;
}

export function validateDecisionForm(f: DecisionForm): { value: CreateDecisionBody | null; errors: DecisionErrors } {
  const errors: DecisionErrors = {};
  const t = textError("Sarlavha", f.title, DECISION_LIMITS.titleMaxChars);
  if (t) errors.title = t;
  const d = textError("Qaror", f.decision, DECISION_LIMITS.decisionMaxChars);
  if (d) errors.decision = d;
  const r = textError("Sabab", f.reason, DECISION_LIMITS.reasonMaxChars);
  if (r) errors.reason = r;
  const alts = parseAlternatives(f.alternatives);
  if (alts.length > DECISION_LIMITS.maxAlternatives) errors.alternatives = `Muqobillar ${DECISION_LIMITS.maxAlternatives} tadan oshmasin (${alts.length})`;
  else {
    const long = alts.find((a) => a.length > DECISION_LIMITS.alternativeMaxChars);
    if (long !== undefined) errors.alternatives = `Har muqobil ${DECISION_LIMITS.alternativeMaxChars} belgidan oshmasin`;
  }
  if (Object.keys(errors).length > 0) return { value: null, errors };
  return { value: { title: f.title.trim(), decision: f.decision.trim(), reason: f.reason.trim(), alternatives: alts }, errors };
}

/** Tahrirda faqat o'zgargan maydonlar; hech narsa o'zgarmagan bo'lsa `value: null, unchanged: true`. */
export function buildPatch(orig: DecisionDto, f: DecisionForm): { value: PatchDecisionBody | null; errors: DecisionErrors; unchanged: boolean } {
  const v = validateDecisionForm(f);
  if (!v.value) return { value: null, errors: v.errors, unchanged: false };
  const patch: PatchDecisionBody = {};
  if (v.value.title !== orig.title) patch.title = v.value.title;
  if (v.value.decision !== orig.decision) patch.decision = v.value.decision;
  if (v.value.reason !== orig.reason) patch.reason = v.value.reason;
  const alts = v.value.alternatives;
  if (alts.length !== orig.alternatives.length || alts.some((a, i) => a !== orig.alternatives[i])) patch.alternatives = alts;
  if (Object.keys(patch).length === 0) return { value: null, errors: {}, unchanged: true };
  return { value: patch, errors: {}, unchanged: false };
}

/** Taklifni qabul qilish / rad etish va arxivlash PATCH tanalari. */
export const ACCEPT_PATCH: PatchDecisionBody = { status: "active" };
export const ARCHIVE_PATCH: PatchDecisionBody = { status: "archived" };
