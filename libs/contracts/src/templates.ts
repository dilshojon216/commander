import { z } from 'zod';
import { COMMAND_LIMITS, MODEL_RE, RemotePermissionModeSchema } from './commands.js';
import { TEMPLATE_VARIABLES, extractTemplateVariables } from './template-render.js';

/**
 * Tayyor buyruqlar / prompt shablonlari (3.4, PLAN ADR "3.4").
 *  - ko'lam: `global` (hamma), `project` (bitta loyiha), `repo` (bir repo_key: mashinalar bo'ylab);
 *  - matn `{{task_key}}`, `{{task_title}}`, `{{branch}}`, `{{project}}`, `{{date}}` o'zgaruvchilarini qo'llaydi;
 *  - render FAQAT markazda (haqiqiy qiymatlar bilan); render qilingan matn hech qayerda saqlanmaydi: u mavjud yo'llarga
 *    (`session.start`, `session.prompt`, navbat) beriladi va ular o'z qoidalari bo'yicha redakt/shifrlaydi;
 *  - yozish `control` scope + audit; shablon matnida sir bo'lmasligi shart (aniq sir topilsa 422 `secret_detected`).
 */

export const TEMPLATE_SCOPES = ['global', 'project', 'repo'] as const;
export const TemplateScopeSchema = z.enum(TEMPLATE_SCOPES);
export type TemplateScope = z.infer<typeof TemplateScopeSchema>;

export const TEMPLATE_LIMITS = {
  nameMaxChars: 80,
  descriptionMaxChars: 300,
  bodyMaxChars: COMMAND_LIMITS.promptMaxChars,
  repoKeyMaxChars: 300,
  /** Jami shablonlar soni (suiste'molga qarshi). */
  maxTemplates: 300,
} as const;

const NameSchema = z.string().trim().min(1).max(TEMPLATE_LIMITS.nameMaxChars);
const DescriptionSchema = z.string().trim().max(TEMPLATE_LIMITS.descriptionMaxChars);
const RepoKeySchema = z.string().trim().min(1).max(TEMPLATE_LIMITS.repoKeyMaxChars);
const ModelSchema = z.string().regex(MODEL_RE);

/** Shablon matni: faqat ma'lum o'zgaruvchilar (`unknown_variable`). */
const BodySchema = z
  .string()
  .min(1)
  .max(TEMPLATE_LIMITS.bodyMaxChars)
  .refine((b) => b.trim().length > 0, { message: 'body is empty' })
  .refine((b) => extractTemplateVariables(b).unknown.length === 0, {
    message: `unknown variable (allowed: ${TEMPLATE_VARIABLES.join(', ')})`,
  });

export const CreateTemplateBodySchema = z
  .object({
    scope: TemplateScopeSchema,
    projectId: z.uuid().optional(),
    repoKey: RepoKeySchema.optional(),
    name: NameSchema,
    description: DescriptionSchema.optional(),
    body: BodySchema,
    model: ModelSchema.optional(),
    permissionMode: RemotePermissionModeSchema.optional(),
    /** 6.9: "katta vazifa" (sessiya ochishdan oldin avto-checkpoint, sozlama yoqilgan bo'lsa). */
    bigTask: z.boolean().optional(),
  })
  .strict()
  .superRefine((b, ctx) => {
    if (b.scope === 'project' && !b.projectId) ctx.addIssue({ code: 'custom', path: ['projectId'], message: 'projectId is required for scope=project' });
    if (b.scope !== 'project' && b.projectId) ctx.addIssue({ code: 'custom', path: ['projectId'], message: 'projectId is only allowed for scope=project' });
    if (b.scope === 'repo' && !b.repoKey) ctx.addIssue({ code: 'custom', path: ['repoKey'], message: 'repoKey is required for scope=repo' });
    if (b.scope !== 'repo' && b.repoKey) ctx.addIssue({ code: 'custom', path: ['repoKey'], message: 'repoKey is only allowed for scope=repo' });
  });
export type CreateTemplateBody = z.infer<typeof CreateTemplateBodySchema>;

/** Ko'lam va ega loyiha/repo o'zgarmaydi (o'chirib qayta yarating). */
export const UpdateTemplateBodySchema = z
  .object({
    name: NameSchema.optional(),
    description: DescriptionSchema.nullable().optional(),
    body: BodySchema.optional(),
    model: ModelSchema.nullable().optional(),
    permissionMode: RemotePermissionModeSchema.nullable().optional(),
    bigTask: z.boolean().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'empty update' });
export type UpdateTemplateBody = z.infer<typeof UpdateTemplateBodySchema>;

export const ListTemplatesQuerySchema = z
  .object({
    /** Loyiha berilsa: global + shu loyiha + shu loyihaning repo'si shablonlari. Berilmasa: hammasi. */
    projectId: z.uuid().optional(),
    scope: TemplateScopeSchema.optional(),
  })
  .strict();
export type ListTemplatesQuery = z.infer<typeof ListTemplatesQuerySchema>;

export const TemplateDtoSchema = z.object({
  id: z.uuid(),
  scope: TemplateScopeSchema,
  projectId: z.uuid().nullable(),
  /** `scope=project` bo'lsa loyiha nomi (UI uchun). */
  projectName: z.string().nullable(),
  repoKey: z.string().nullable(),
  name: z.string(),
  description: z.string().nullable(),
  body: z.string(),
  /** Matnda ishlatilgan ma'lum o'zgaruvchilar. */
  variables: z.array(z.string()),
  model: z.string().nullable(),
  permissionMode: RemotePermissionModeSchema.nullable(),
  /** Tizim bilan kelgan (seed) shablon: tahrirlash mumkin, lekin migratsiya qayta yaratmaydi. */
  builtin: z.boolean(),
  /** 6.9: "katta vazifa" shabloni (avto-checkpoint). */
  bigTask: z.boolean().optional(),
  createdByDeviceId: z.uuid().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TemplateDto = z.infer<typeof TemplateDtoSchema>;

export const ListTemplatesResponseSchema = z.object({ items: z.array(TemplateDtoSchema) });
export type ListTemplatesResponse = z.infer<typeof ListTemplatesResponseSchema>;

/**
 * Render kontekstlari: `projectId` (loyiha nomi, branch), `taskKey` (vazifa sarlavhasi `project_tasks`dan),
 * `sessionId` (sessiyaning loyihasi/branchi/vazifasi). Hammasi ixtiyoriy; topilmaganlar `missing`da.
 */
export const RenderTemplateBodySchema = z
  .object({
    projectId: z.uuid().optional(),
    sessionId: z.uuid().optional(),
    taskKey: z.string().trim().min(1).max(64).optional(),
  })
  .strict();
export type RenderTemplateBody = z.infer<typeof RenderTemplateBodySchema>;

export const TemplateRenderVariableSchema = z.object({ name: z.string(), value: z.string().nullable() });

export const RenderTemplateResponseSchema = z.object({
  templateId: z.uuid(),
  /** Render qilingan matn (saqlanmaydi). Yetishmayotgan o'zgaruvchilar `{{nom}}` bo'lib qoladi. */
  text: z.string(),
  length: z.number().int(),
  variables: z.array(TemplateRenderVariableSchema),
  missing: z.array(z.string()),
  /** `text.length > promptMaxChars`: yuborib bo'lmaydi. */
  tooLong: z.boolean(),
  model: z.string().nullable(),
  permissionMode: RemotePermissionModeSchema.nullable(),
});
export type RenderTemplateResponse = z.infer<typeof RenderTemplateResponseSchema>;

/** Shablonni mavjud sessiyaga prompt qilib yuborish (`session.prompt` buyrug'i yaratiladi: audit + policy + lockdown o'sha yo'lda). */
export const SendTemplatePromptBodySchema = z
  .object({
    sessionId: z.uuid(),
    taskKey: z.string().trim().min(1).max(64).optional(),
  })
  .strict();
export type SendTemplatePromptBody = z.infer<typeof SendTemplatePromptBodySchema>;
