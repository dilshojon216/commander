import { TEMPLATE_VARIABLES, extractTemplateVariables, renderTemplate } from '@commander/contracts';
import type { RenderTemplateResponse, TemplateDto, TemplateValues, TemplateVariable } from '@commander/contracts';
import { COMMAND_LIMITS } from '@commander/contracts';
import { redactText } from '../common/redact-text.js';

/**
 * Prompt shablonlari uchun sof mantiq (3.4): DTO xaritasi, sir tekshiruvi, render kontekstini yig'ish. IO yo'q: `TemplatesService`
 * qiymatlarni DB'dan oladi va shu yerga beradi (testlanadi).
 */

export interface TemplateRow {
  id: string;
  scope: 'global' | 'project' | 'repo';
  project_id: string | null;
  project_name: string | null;
  repo_key: string | null;
  name: string;
  description: string | null;
  body: string;
  model: string | null;
  permission_mode: string | null;
  builtin: boolean;
  big_task?: boolean;
  created_by_device_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export function toTemplateDto(r: TemplateRow): TemplateDto {
  return {
    id: r.id,
    scope: r.scope,
    projectId: r.project_id,
    projectName: r.project_name,
    repoKey: r.repo_key,
    name: r.name,
    description: r.description,
    body: r.body,
    variables: extractTemplateVariables(r.body).known,
    model: r.model,
    permissionMode: (r.permission_mode as TemplateDto['permissionMode']) ?? null,
    builtin: r.builtin,
    bigTask: r.big_task === true,
    createdByDeviceId: r.created_by_device_id,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

/** Shablon matnida aniq sir bor (redakt matnni o'zgartirdi). Jimgina maskalash o'rniga rad etiladi: shablon sirni saqlamasin. */
export function containsSecret(text: string): boolean {
  return redactText(text) !== text;
}

export interface RenderContext {
  project?: { name: string; branch: string | null } | null;
  taskKey?: string | null;
  taskTitle?: string | null;
  /** `YYYY-MM-DD` (Toshkent). */
  date: string;
}

export function valuesFromContext(c: RenderContext): TemplateValues {
  return {
    project: c.project?.name ?? null,
    branch: c.project?.branch ?? null,
    task_key: c.taskKey ?? null,
    task_title: c.taskTitle ?? null,
    date: c.date,
  };
}

/** Render + javob shakli. `variables` faqat matnda ishlatilgan o'zgaruvchilar (qiymat bilan yoki `null`). */
export function buildRenderResponse(
  t: Pick<TemplateDto, 'id' | 'body' | 'model' | 'permissionMode'>,
  ctx: RenderContext,
): RenderTemplateResponse {
  const values = valuesFromContext(ctx);
  const r = renderTemplate(t.body, values);
  const { known } = extractTemplateVariables(t.body);
  const variables = known.map((name: TemplateVariable) => ({ name, value: r.used.includes(name) ? sanitizedValue(values, name) : null }));
  const length = Array.from(r.text).length;
  return {
    templateId: t.id,
    text: r.text,
    length,
    variables,
    missing: r.missing,
    tooLong: length > COMMAND_LIMITS.promptMaxChars,
    model: t.model,
    permissionMode: t.permissionMode,
  };
}

function sanitizedValue(values: TemplateValues, name: TemplateVariable): string | null {
  const v = values[name];
  return typeof v === 'string' && v.trim() !== '' ? renderTemplate(`{{${name}}}`, { [name]: v }).text : null;
}

/** Ma'lum o'zgaruvchilar (yordam ro'yxati uchun). */
export const KNOWN_VARIABLES: readonly TemplateVariable[] = TEMPLATE_VARIABLES;
