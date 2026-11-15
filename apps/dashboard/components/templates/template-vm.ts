import { CreateTemplateBodySchema, TEMPLATE_LIMITS, TEMPLATE_VARIABLES, TEMPLATE_VARIABLE_HELP, UpdateTemplateBodySchema } from "@commander/contracts";
import type { CreateTemplateBody, ListProjectsResponse, RemotePermissionMode, RenderTemplateResponse, TemplateDto, TemplateScope, UpdateTemplateBody } from "@commander/contracts";

/** Shablonlar UI mantig'i (sof, testlanadi): guruhlash, forma, o'zgaruvchi yordami, preview, xato matnlari. */

export const SCOPE_LABEL: Record<TemplateScope, string> = { project: "Loyiha", repo: "Repo", global: "Global" };
export const SCOPE_ORDER: TemplateScope[] = ["project", "repo", "global"];
/** Shablonda default sifatida tanlanadigan rejimlar: `bypassPermissions`/`dontAsk` ataylab yo'q. */
export const TEMPLATE_MODES: RemotePermissionMode[] = ["default", "acceptEdits", "plan", "auto"];

export interface TemplateGroup {
  scope: TemplateScope;
  label: string;
  items: TemplateDto[];
}

/** Ko'lam bo'yicha guruh (loyiha, repo, global), ichida nom bo'yicha; bo'sh guruhlar tashlanadi. */
export function groupTemplates(items: TemplateDto[]): TemplateGroup[] {
  return SCOPE_ORDER.map((scope) => ({
    scope,
    label: SCOPE_LABEL[scope],
    items: items.filter((t) => t.scope === scope).sort((a, b) => (a.projectName ?? a.repoKey ?? "").localeCompare(b.projectName ?? b.repoKey ?? "") || a.name.localeCompare(b.name)),
  })).filter((g) => g.items.length > 0);
}

/** Ko'lam nishoni matni: loyiha nomi yoki repo kaliti. */
export function scopeBadge(t: Pick<TemplateDto, "scope" | "projectName" | "repoKey">): string {
  if (t.scope === "project") return `Loyiha: ${t.projectName ?? "?"}`;
  if (t.scope === "repo") return `Repo: ${t.repoKey ?? "?"}`;
  return "Global";
}

export interface VariableHelpRow {
  name: string;
  token: string;
  help: string;
}
export const variableHelpRows = (): VariableHelpRow[] => TEMPLATE_VARIABLES.map((name) => ({ name, token: `{{${name}}}`, help: TEMPLATE_VARIABLE_HELP[name] }));

/** Matnga `{{nom}}` ni kursor (tanlov) o'rniga qo'shadi; yangi kursor o'rnini qaytaradi. */
export function insertVariable(body: string, start: number, end: number, name: string): { body: string; cursor: number } {
  const s = Math.max(0, Math.min(start, body.length));
  const e = Math.max(s, Math.min(end, body.length));
  const token = `{{${name}}}`;
  return { body: body.slice(0, s) + token + body.slice(e), cursor: s + token.length };
}

export interface TemplateForm {
  scope: TemplateScope;
  projectId: string;
  repoKey: string;
  name: string;
  description: string;
  body: string;
  model: string;
  permissionMode: "" | RemotePermissionMode;
  /** 6.9: "katta vazifa" (sessiya ochishdan oldin avto-checkpoint). */
  bigTask: boolean;
}

export const EMPTY_FORM: TemplateForm = { scope: "global", projectId: "", repoKey: "", name: "", description: "", body: "", model: "", permissionMode: "", bigTask: false };

export function formFromDto(t: TemplateDto): TemplateForm {
  return { scope: t.scope, projectId: t.projectId ?? "", repoKey: t.repoKey ?? "", name: t.name, description: t.description ?? "", body: t.body, model: t.model ?? "", permissionMode: t.permissionMode ?? "", bigTask: t.bigTask === true };
}

export type FormErrors = Partial<Record<"name" | "body" | "projectId" | "repoKey", string>>;

export function validateForm(f: TemplateForm, editing: boolean): FormErrors {
  const e: FormErrors = {};
  if (f.name.trim() === "") e.name = "Nom kiriting";
  else if (f.name.trim().length > TEMPLATE_LIMITS.nameMaxChars) e.name = `Nom ${TEMPLATE_LIMITS.nameMaxChars} belgidan oshmasin`;
  if (f.body.trim() === "") e.body = "Shablon matni bo'sh";
  else if (f.body.length > TEMPLATE_LIMITS.bodyMaxChars) e.body = `Matn ${TEMPLATE_LIMITS.bodyMaxChars} belgidan oshmasin`;
  if (!editing) {
    if (f.scope === "project" && f.projectId === "") e.projectId = "Loyihani tanlang";
    if (f.scope === "repo" && f.repoKey.trim() === "") e.repoKey = "Repo kalitini kiriting";
  }
  return e;
}

/** Yaratish tanasi (sxema bilan tekshirilgan); noto'g'ri bo'lsa `null`. */
export function buildCreateBody(f: TemplateForm): CreateTemplateBody | null {
  const r = CreateTemplateBodySchema.safeParse({
    scope: f.scope,
    ...(f.scope === "project" ? { projectId: f.projectId } : {}),
    ...(f.scope === "repo" ? { repoKey: f.repoKey.trim() } : {}),
    name: f.name.trim(),
    ...(f.description.trim() !== "" ? { description: f.description.trim() } : {}),
    body: f.body,
    ...(f.model !== "" ? { model: f.model } : {}),
    ...(f.permissionMode !== "" ? { permissionMode: f.permissionMode } : {}),
    ...(f.bigTask ? { bigTask: true } : {}),
  });
  return r.success ? r.data : null;
}

/** Faqat o'zgargan maydonlar (bo'sh model/rejim/tavsif = `null`: tozalash). Hech narsa o'zgarmasa `null`. */
export function buildUpdateBody(f: TemplateForm, orig: TemplateDto): UpdateTemplateBody | null {
  const out: Record<string, unknown> = {};
  if (f.name.trim() !== orig.name) out.name = f.name.trim();
  if ((f.description.trim() || null) !== orig.description) out.description = f.description.trim() || null;
  if (f.body !== orig.body) out.body = f.body;
  if ((f.model || null) !== orig.model) out.model = f.model || null;
  if ((f.permissionMode || null) !== orig.permissionMode) out.permissionMode = f.permissionMode || null;
  if (f.bigTask !== (orig.bigTask === true)) out.bigTask = f.bigTask;
  if (Object.keys(out).length === 0) return null;
  const r = UpdateTemplateBodySchema.safeParse(out);
  return r.success ? r.data : null;
}

/** Shablon xatolari (HTTP) -> o'zbekcha matn. */
export function templateHttpErrorText(status: number, body: unknown): string {
  const code = typeof body === "object" && body !== null && "error" in body ? String((body as { error: unknown }).error) : "";
  const missing = typeof body === "object" && body !== null && Array.isArray((body as { missing?: unknown }).missing) ? ((body as { missing: unknown[] }).missing as unknown[]).map(String) : [];
  if (code === "missing_variables") return `Qiymati topilmagan o'zgaruvchilar: ${missing.map((m) => `{{${m}}}`).join(", ") || "?"}`;
  if (code === "prompt_too_long") return "Shablondan tuzilgan matn juda uzun (16 000 belgidan oshdi)";
  if (code === "secret_detected") return "Shablon matnida sir (token/kalit) bor ko'rinadi: olib tashlang";
  if (code === "template_exists") return "Bu ko'lamda shu nomli shablon allaqachon bor";
  if (code === "too_many_templates") return "Shablonlar soni chegarasiga yetildi";
  if (code === "lockdown" || (status === 403 && code === "")) return status === 403 && code === "lockdown" ? "Lockdown yoqiq: o'zgartirib bo'lmaydi" : "Boshqaruv uchun token ruxsati yetarli emas";
  if (status === 404) return "Shablon, loyiha yoki sessiya topilmadi";
  if (status === 400) return "So'rov ma'lumoti noto'g'ri";
  if (status === 503) return "COMMANDER_CONTROL_TOKEN sozlanmagan: boshqaruv o'chiq";
  if (status === 429) return "Juda ko'p so'rov: birozdan keyin urinib ko'ring";
  return `Xatolik (${status || "tarmoq"})`;
}

export interface PreviewSegment {
  text: string;
  missing: boolean;
}

/** Render natijasini bo'laklaydi: yetishmayotgan `{{nom}}`lar alohida belgilanadi (ajratib ko'rsatish uchun). */
export function previewSegments(text: string, missing: string[]): PreviewSegment[] {
  if (missing.length === 0) return [{ text, missing: false }];
  const re = new RegExp(`(\\{\\{\\s*(?:${missing.map((m) => m.replace(/[^A-Za-z0-9_]/g, "")).filter(Boolean).join("|")})\\s*\\}\\})`, "g");
  // split + capture guruhi: toq indekslar = mos kelgan (yetishmayotgan) `{{nom}}`
  return text
    .split(re)
    .map((t, i) => ({ text: t, missing: i % 2 === 1 }))
    .filter((seg) => seg.text !== "");
}

/** Preview holati: yuborishga yaroqlimi va sabab. */
export function previewStatus(r: RenderTemplateResponse): { ok: boolean; note: string | null } {
  if (r.missing.length > 0) return { ok: false, note: `Qiymat topilmadi: ${r.missing.map((m) => `{{${m}}}`).join(", ")}` };
  if (r.tooLong) return { ok: false, note: "Matn juda uzun (16 000 belgidan oshdi)" };
  return { ok: true, note: null };
}

/** Papka bo'yicha loyiha id'si (modal/navbat formasi shablonlarni loyiha bo'yicha filtrlaydi). */
export function projectIdForCwd(projects: ListProjectsResponse | null | undefined, machineId: string | null, cwd: string): string | null {
  if (!projects || !machineId) return null;
  const c = cwd.trim().replace(/\/+$/, "");
  return projects.items.find((p) => p.machineId === machineId && p.path.replace(/\/+$/, "") === c)?.id ?? null;
}

/** Shablonning default model/rejimi (mashina ruxsat bergan bo'lsa) forma qiymatlariga. */
export function applyTemplateDefaults(r: Pick<RenderTemplateResponse, "model" | "permissionMode">, allowedModes: RemotePermissionMode[], models: string[]): { model?: string; mode?: RemotePermissionMode } {
  return {
    ...(r.model && models.includes(r.model) ? { model: r.model } : {}),
    ...(r.permissionMode && allowedModes.includes(r.permissionMode) ? { mode: r.permissionMode } : {}),
  };
}

/** Shablon "katta vazifa"mi (yangi sessiya buyrug'iga `checkpoint: true` qo'shiladi). */
export const isBigTaskTemplate = (t: Pick<TemplateDto, "bigTask"> | null | undefined): boolean => t?.bigTask === true;
