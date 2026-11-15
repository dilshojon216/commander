import { z } from 'zod';

/**
 * Avto-ruxsat qoidalari (task 2.13, PLAN "Qarorlar (2.13/2.14)"). Markaz tomonidagi siyosat: `approval.request`
 * kelganda mos qoida bo'lsa center `allow` ni o'zi beradi (actor `system`, audit dispatchdan OLDIN).
 *
 * Xavfsizlik qoidalari (CLAUDE.md #1, #4, #5):
 *  - ruxsat ro'yxati (allow-list): FAQAT quyidagi vositalar; Bash, shell/exec ma'noli har qanday vosita, Task/Agent,
 *    ExitPlanMode va ro'yxatda yo'q hamma narsa HECH QACHON avto-ruxsat olmaydi (yaratishda 400, moslashtirishda ham rad);
 *  - muddat majburiy va <= 7 kun; bekor qilish (revoke) darhol kuchga kiradi;
 *  - fayl vositalari uchun yo'l agentd hisoblagan `target` dan olinadi (cwd ichida, nisbiy) va qoidaning glob'lari
 *    bilan solishtiriladi; himoyalangan yo'llar (.git, .claude, .ssh, .env ...) hech qachon avto-ruxsat olmaydi;
 *  - lockdown'da qoidalar ishlamaydi; har qoidaga soatiga cheklov (oshsa qo'lda tasdiqqa tushadi).
 */

export const RULE_SCOPES = ['session', 'project', 'repo'] as const;
export const RuleScopeSchema = z.enum(RULE_SCOPES);
export type RuleScope = z.infer<typeof RuleScopeSchema>;

/** Yo'l maslahati talab qiladigan (fayl) vositalar. */
export const RULE_FILE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Read', 'Glob', 'Grep'] as const;
export type RuleFileTool = (typeof RULE_FILE_TOOLS)[number];
/** Dashboard/Telegram taklif qiladigan yozuv vositalari (Telegram tugmasi shu to'plamni ishlatadi). */
export const RULE_EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit'] as const;

/** MCP vosita nomi aniq: `mcp__<server>__<tool>` (wildcard yo'q). */
export const MCP_TOOL_NAME_RE = /^mcp__[A-Za-z0-9_-]{1,64}__[A-Za-z0-9_-]{1,96}$/;
/** MCP nomi shell/exec ma'nosini bildirsa (eng yaxshi urinish) rad etiladi. */
const MCP_EXEC_WORDS_RE = /(exec|shell|bash|sh_|_sh\b|command|cmd|eval|spawn|terminal|process|script|run_|_run\b|powershell|sudo|ssh|kubectl|docker)/i;

/** Qat'iy istisnolar (kichik harf): hech qachon avto-ruxsat. Ro'yxat allow-list bilan ikki qatlam. */
export const HARD_EXCLUDED_TOOLS: ReadonlySet<string> = new Set([
  'bash',
  'bashoutput',
  'killshell',
  'killbash',
  'powershell',
  'task',
  'agent',
  'taskoutput',
  'taskstop',
  'taskcreate',
  'exitplanmode',
  'enterplanmode',
  'askuserquestion',
  'webfetch',
  'websearch',
  'skill',
  'slashcommand',
  'computer',
  'monitor',
  'workflow',
]);

export function isHardExcludedTool(name: string): boolean {
  return HARD_EXCLUDED_TOOLS.has(name.toLowerCase());
}

/** Qoidaga qo'yish MUMKIN bo'lgan vosita (allow-list; istisnolardan holi). */
export function isRuleToolAllowed(name: string): boolean {
  if (isHardExcludedTool(name)) return false;
  if ((RULE_FILE_TOOLS as readonly string[]).includes(name)) return true;
  return MCP_TOOL_NAME_RE.test(name) && !MCP_EXEC_WORDS_RE.test(name);
}

export const isRuleFileTool = (name: string): name is RuleFileTool => (RULE_FILE_TOOLS as readonly string[]).includes(name);

export const RULE_LIMITS = {
  minTtlSeconds: 60,
  maxTtlSeconds: 7 * 24 * 3600,
  maxTools: 12,
  maxGlobs: 10,
  globMaxChars: 200,
  scopeRefMaxChars: 256,
  /** Bitta qoida avto-ruxsat berishi mumkin bo'lgan soatiga son; oshsa qo'lda tasdiqqa tushadi. */
  maxAutoPerHour: 500,
} as const;

/** UI davomiyliklari (id -> soniya). */
export const RULE_DURATIONS = [
  { id: '15m', seconds: 15 * 60, label: '15 daqiqa' },
  { id: '1h', seconds: 3600, label: '1 soat' },
  { id: '8h', seconds: 8 * 3600, label: '8 soat' },
  { id: '1d', seconds: 24 * 3600, label: '1 kun' },
  { id: '7d', seconds: 7 * 24 * 3600, label: '7 kun' },
] as const;

const GLOB_CHARS_RE = /^[\p{L}\p{N}._\-@+ /*?]+$/u;

/** Glob'ni tekshiradi: nisbiy, `..`/absolyut/teskari slesh/diskd yo'q. `null` = yaroqli, aks holda sabab. */
export function validatePathGlob(glob: string): string | null {
  if (glob.length === 0 || glob.length > RULE_LIMITS.globMaxChars) return 'length';
  if (glob.startsWith('/') || glob.includes('\\') || glob.includes(':') || glob.includes('\0')) return 'absolute_or_invalid_char';
  if (!GLOB_CHARS_RE.test(glob)) return 'invalid_char';
  const segments = glob.split('/');
  for (const seg of segments) {
    if (seg === '' || /^\.+$/.test(seg)) return 'bad_segment';
  }
  return null;
}

const ToolNameSchema = z
  .string()
  .min(1)
  .max(160)
  .refine(isRuleToolAllowed, { message: 'tool is not eligible for auto-approval (Bash, shell/exec, Task/Agent and unlisted tools are never allowed)' });

const PathGlobSchema = z.string().refine((g) => validatePathGlob(g) === null, { message: 'invalid path glob (must be relative, inside the session cwd, no ..)' });

/** `POST /v1/approval-rules` tanasi (`control` scope). */
export const CreateApprovalRuleBodySchema = z
  .object({
    scope: RuleScopeSchema,
    /** session: center sessiya uuid'si; project: loyiha uuid'si; repo: normallashtirilgan repo kaliti (github.com/org/repo). */
    scopeRef: z.string().min(1).max(RULE_LIMITS.scopeRefMaxChars),
    tools: z.array(ToolNameSchema).min(1).max(RULE_LIMITS.maxTools),
    pathGlobs: z.array(PathGlobSchema).max(RULE_LIMITS.maxGlobs).default([]),
    /** Muddat (soniya): majburiy, 60 s..7 kun. */
    ttlSeconds: z.number().int().min(RULE_LIMITS.minTtlSeconds).max(RULE_LIMITS.maxTtlSeconds),
  })
  .strict()
  .superRefine((b, ctx) => {
    const tools = new Set(b.tools);
    if (tools.size !== b.tools.length) ctx.addIssue({ code: 'custom', path: ['tools'], message: 'duplicate tools' });
    const hasFile = b.tools.some(isRuleFileTool);
    const hasMcp = b.tools.some((t) => !isRuleFileTool(t));
    // Yo'l glob'lari faqat fayl vositalari uchun; MCP vositalari yo'l maslahatiga ega emas.
    if (b.pathGlobs.length > 0 && (!hasFile || hasMcp)) {
      ctx.addIssue({ code: 'custom', path: ['pathGlobs'], message: 'pathGlobs are only valid when every tool is a file tool' });
    }
    if (b.scope === 'session' || b.scope === 'project') {
      if (!z.uuid().safeParse(b.scopeRef).success) ctx.addIssue({ code: 'custom', path: ['scopeRef'], message: `${b.scope} scopeRef must be a uuid` });
    }
  });
export type CreateApprovalRuleBody = z.infer<typeof CreateApprovalRuleBodySchema>;

export const APPROVAL_RULE_STATUSES = ['active', 'expired', 'revoked'] as const;

export const ApprovalRuleDtoSchema = z.object({
  id: z.number().int(),
  scope: RuleScopeSchema,
  scopeRef: z.string(),
  /** Ko'rsatish uchun nom (sessiya/loyiha nomi; topilmasa null). */
  scopeLabel: z.string().nullable(),
  tools: z.array(z.string()),
  pathGlobs: z.array(z.string()),
  expiresAt: z.string(),
  createdByDeviceId: z.uuid(),
  createdAt: z.string(),
  revokedAt: z.string().nullable(),
  status: z.enum(APPROVAL_RULE_STATUSES),
  /** Shu qoida avto-ruxsat bergan jami so'rovlar soni. */
  autoCount: z.number().int(),
});
export type ApprovalRuleDto = z.infer<typeof ApprovalRuleDtoSchema>;

export const ListApprovalRulesQuerySchema = z
  .object({
    scope: RuleScopeSchema.optional(),
    scopeRef: z.string().min(1).max(RULE_LIMITS.scopeRefMaxChars).optional(),
    /** `true`: bekor qilingan/muddati o'tgan oxirgi 50 ta qoida ham. */
    includeInactive: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
  })
  .strict();
export type ListApprovalRulesQuery = z.infer<typeof ListApprovalRulesQuerySchema>;

export const ListApprovalRulesResponseSchema = z.object({ rules: z.array(ApprovalRuleDtoSchema) });
export type ListApprovalRulesResponse = z.infer<typeof ListApprovalRulesResponseSchema>;

export const CreateApprovalRuleResponseSchema = z.object({ rule: ApprovalRuleDtoSchema });
export type CreateApprovalRuleResponse = z.infer<typeof CreateApprovalRuleResponseSchema>;

export const RevokeApprovalRuleResponseSchema = z.object({ rule: ApprovalRuleDtoSchema, revoked: z.boolean() });
export type RevokeApprovalRuleResponse = z.infer<typeof RevokeApprovalRuleResponseSchema>;
