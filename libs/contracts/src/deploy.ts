import { z } from 'zod';
import { SHA_RE } from './git-ops.js';

/**
 * Bir bosishda deploy (task 6.5). Retsept REPO ICHIDA (`.commander/deploy.yml`, kod bilan versiyalanadi va kod kabi ko'rib chiqiladi).
 *
 * Xavfsizlik modeli (CLAUDE.md qoida 1-5):
 *  - markaz retsept matnini HECH QACHON mijozdan qabul qilmaydi: agentd retseptni repo'dan PIN QILINGAN commit'da
 *    (`git cat-file blob <sha>:.commander/deploy.yml`, ishchi daraxt emas) o'qiydi, normallashtiradi va sha256 xeshini qaytaradi;
 *  - egasi ANIQ (target, commit, recipeHash) uchlikni tasdiqlaydi; `deploy.run`/`deploy.rollback` imzolangan payload'da shu uchlik bor;
 *    agentd retseptni qayta o'qiydi va xesh/commit o'zgargan bo'lsa rad etadi (TOCTOU);
 *  - qadamlar argv MASSIVI (shell yo'q); `shell:` faqat retsept o'zi tanlasa VA lokal siyosat `allowDeployShell` bersa;
 *  - chiqish `logs.chunk` orqali jonli (redakt qilingan, DB'ga yozilmaydi); DB'da faqat qadam nomlari/holatlari/davomiyligi.
 */

export const DEPLOY_RECIPE_PATH = '.commander/deploy.yml';

export const DEPLOY_COMMAND_TYPES = ['deploy.inspect', 'deploy.run', 'deploy.rollback'] as const;
export type DeployCommandType = (typeof DEPLOY_COMMAND_TYPES)[number];
export const isDeployCommandType = (t: string): t is DeployCommandType => (DEPLOY_COMMAND_TYPES as readonly string[]).includes(t);
/** Faqat ijro qiluvchi (o'zgartiruvchi) turlar: step-up HAR DOIM, istisnosiz. */
export const isDeployExecType = (t: string): t is 'deploy.run' | 'deploy.rollback' => t === 'deploy.run' || t === 'deploy.rollback';

export const DEPLOY_LIMITS = {
  recipeMaxBytes: 64 * 1024,
  maxTargets: 12,
  maxStepsPerPhase: 40,
  argvMaxItems: 64,
  argvItemMaxChars: 1024,
  shellMaxChars: 4096,
  envMaxItems: 32,
  envValueMaxChars: 1024,
  stepNameMaxChars: 60,
  targetNameMaxChars: 40,
  machineNameMaxChars: 64,
  pathMaxChars: 1024,
  /** Bitta qadam muddati (s): default va chegara. */
  stepTimeoutDefaultSec: 300,
  stepTimeoutMaxSec: 3600,
  /** Butun deploy muddati (s). */
  targetTimeoutDefaultSec: 1800,
  targetTimeoutMaxSec: 7200,
  healthRetriesMax: 60,
  healthIntervalMaxSec: 60,
  healthAttemptTimeoutMaxSec: 60,
  healthUrlMaxChars: 512,
  /** Natija ro'yxati chegarasi. */
  summarySteps: 120,
  /** Jonli chiqish (agentd): jami bayt (undan keyin chiqish tashlanadi, deploy davom etadi). */
  outputMaxBytes: 8 * 1024 * 1024,
  /** `deploy.inspect` REST kutish muddati (ms). */
  inspectWaitMs: 45_000,
  /** Tarix ro'yxati. */
  historyMax: 50,
} as const;

export const TARGET_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/;
export const STEP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._:/()+-]{0,59}$/;
export const MACHINE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;
/** argv/env/health matnida ruxsat etilgan o'rinbosarlar (boshqa `{{...}}` retseptni yaroqsiz qiladi). */
export const DEPLOY_PLACEHOLDERS = ['commit', 'short_commit', 'target'] as const;
export const RECIPE_HASH_RE = /^[0-9a-f]{64}$/;

// --- normallashtirilgan retsept (agentd hosil qiladi; xesh shu ustida) -------------------------------

export const DeployStepSchema = z.object({
  name: z.string().regex(STEP_NAME_RE),
  /** `argv`: `run:` massivi (shell yo'q); `shell`: `shell:` qatori (faqat siyosat `allowDeployShell` bilan). */
  kind: z.enum(['argv', 'shell']),
  argv: z.array(z.string().min(1).max(DEPLOY_LIMITS.argvItemMaxChars)).max(DEPLOY_LIMITS.argvMaxItems),
  shell: z.string().max(DEPLOY_LIMITS.shellMaxChars).nullable(),
  /** Target cwd'ga nisbatan ichki papka (yo'q = target cwd). */
  cwd: z.string().max(DEPLOY_LIMITS.pathMaxChars).nullable(),
  env: z.record(z.string(), z.string().max(DEPLOY_LIMITS.envValueMaxChars)),
  timeoutSec: z.number().int().min(1).max(DEPLOY_LIMITS.stepTimeoutMaxSec),
});
export type DeployStep = z.infer<typeof DeployStepSchema>;

export const DeployHealthSchema = z.object({
  /** `url` (HTTP GET) yoki `run` (argv; chiqish kodi 0 = sog'lom). Aynan bittasi. */
  kind: z.enum(['http', 'command']),
  url: z.string().max(DEPLOY_LIMITS.healthUrlMaxChars).nullable(),
  argv: z.array(z.string().min(1).max(DEPLOY_LIMITS.argvItemMaxChars)).max(DEPLOY_LIMITS.argvMaxItems),
  expectStatus: z.array(z.number().int().min(100).max(599)).min(1).max(8),
  /** Bitta urinish muddati (s). */
  timeoutSec: z.number().int().min(1).max(DEPLOY_LIMITS.healthAttemptTimeoutMaxSec),
  /** Qo'shimcha urinishlar (jami = 1 + retries). */
  retries: z.number().int().min(0).max(DEPLOY_LIMITS.healthRetriesMax),
  intervalSec: z.number().int().min(1).max(DEPLOY_LIMITS.healthIntervalMaxSec),
});
export type DeployHealth = z.infer<typeof DeployHealthSchema>;

export const DeployTargetSchema = z.object({
  name: z.string().regex(TARGET_NAME_RE),
  /** Maqsad mashina nomi (markazdagi mashina slug'i); mos kelmasa deploy rad etiladi. */
  machine: z.string().regex(MACHINE_NAME_RE),
  /** Repo ildiziga nisbatan (`.` yoki ichki papka) yoki ruxsat etilgan ildiz ichidagi mutlaq yo'l. */
  cwd: z.string().min(1).max(DEPLOY_LIMITS.pathMaxChars),
  timeoutSec: z.number().int().min(1).max(DEPLOY_LIMITS.targetTimeoutMaxSec),
  preflight: z.array(DeployStepSchema).max(DEPLOY_LIMITS.maxStepsPerPhase),
  steps: z.array(DeployStepSchema).min(1).max(DEPLOY_LIMITS.maxStepsPerPhase),
  health: DeployHealthSchema.nullable(),
  rollback: z.array(DeployStepSchema).max(DEPLOY_LIMITS.maxStepsPerPhase),
  /** Retsept (preflight/steps/rollback) ichida `shell:` qadami bormi. */
  usesShell: z.boolean(),
});
export type DeployTarget = z.infer<typeof DeployTargetSchema>;

export const DeployRecipeSchema = z.object({
  version: z.literal(1),
  targets: z.array(DeployTargetSchema).min(1).max(DEPLOY_LIMITS.maxTargets),
});
export type DeployRecipe = z.infer<typeof DeployRecipeSchema>;

// --- deploy.inspect ---------------------------------------------------------------------------

const Root = z.string().min(1).max(4096);
const Machine = z.string().regex(MACHINE_NAME_RE);
const Commit = z.string().regex(SHA_RE);

/** Markaz `root` va `machine` (slug)ni DB'dan qo'yadi; mijoz bermaydi. `commit` yo'q = HEAD. */
export const DeployInspectPayloadSchema = z.object({ root: Root, machine: Machine, commit: Commit.optional() }).strict();
export type DeployInspectPayload = z.infer<typeof DeployInspectPayloadSchema>;

export const DeployInspectResultSchema = z.object({
  /** Retsept o'qilgan commit (to'liq sha). */
  commit: z.string().regex(SHA_RE),
  branch: z.string().max(200).nullable(),
  /** Kuzatilayotgan fayllarda commit qilinmagan o'zgarish bor (deploy bunda rad etiladi). */
  dirty: z.boolean(),
  /** `.commander/deploy.yml` shu commit'da bor. */
  recipePresent: z.boolean(),
  /** Faylning ishchi daraxtdagi nusxasi commit'dagidan farq qiladi (yoki commit qilinmagan). */
  workingTreeDiffers: z.boolean(),
  valid: z.boolean(),
  /** Tekshiruv xatolari/ogohlantirishlari (oddiy matn, <= 300 belgi). */
  issues: z.array(z.string().max(300)).max(40),
  recipe: DeployRecipeSchema.nullable(),
  /** `sha256(canonicalJson(recipe))`: egasi shuni tasdiqlaydi. */
  recipeHash: z.string().regex(RECIPE_HASH_RE).nullable(),
  usesShell: z.boolean(),
  /** Har maqsad uchun: `machine` shu mashina nomiga mosmi. */
  machineMatches: z.record(z.string(), z.boolean()),
  /** Siyosat: shu mashinada deploy yoqilganmi (agentd o'zi biladi; UI uchun). */
  allowDeploy: z.boolean(),
  allowDeployShell: z.boolean(),
});
export type DeployInspectResult = z.infer<typeof DeployInspectResultSchema>;

// --- deploy.run / deploy.rollback --------------------------------------------------------------

/** Imzolangan payload: (target, commit, recipeHash) uchlik + markaz bergan `root`/`machine`. */
export const DeployExecPayloadSchema = z
  .object({ root: Root, machine: Machine, target: z.string().regex(TARGET_NAME_RE), recipeHash: z.string().regex(RECIPE_HASH_RE), commit: Commit })
  .strict();
export type DeployExecPayload = z.infer<typeof DeployExecPayloadSchema>;

export const DEPLOY_PHASES = ['preflight', 'steps', 'health', 'rollback', 'rollback_health'] as const;
export const DeployPhaseSchema = z.enum(DEPLOY_PHASES);
export type DeployPhase = z.infer<typeof DeployPhaseSchema>;

export const DEPLOY_OUTCOMES = ['success', 'failed', 'rolled_back', 'rollback_failed'] as const;
export const DeployOutcomeSchema = z.enum(DEPLOY_OUTCOMES);
export type DeployOutcome = z.infer<typeof DeployOutcomeSchema>;

export const DeployStepResultSchema = z.object({
  phase: DeployPhaseSchema,
  name: z.string().max(DEPLOY_LIMITS.stepNameMaxChars + 20),
  status: z.enum(['ok', 'failed', 'timeout', 'skipped']),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().int().min(0),
});
export type DeployStepResult = z.infer<typeof DeployStepResultSchema>;

/** Natija xulosasi: faqat nomlar/holatlar/vaqtlar (chiqish matni YO'Q). `commands.result.deploy` da saqlanadi. */
export const DeploySummarySchema = z.object({
  kind: z.enum(['run', 'rollback']),
  target: z.string().regex(TARGET_NAME_RE),
  commit: z.string().regex(SHA_RE),
  recipeHash: z.string().regex(RECIPE_HASH_RE),
  outcome: DeployOutcomeSchema,
  failedPhase: DeployPhaseSchema.nullable(),
  failedStep: z.string().max(DEPLOY_LIMITS.stepNameMaxChars + 20).nullable(),
  steps: z.array(DeployStepResultSchema).max(DEPLOY_LIMITS.summarySteps),
  health: z.object({ ok: z.boolean(), attempts: z.number().int().min(0), lastStatus: z.number().int().nullable() }).nullable(),
  /** Retseptda rollback qadamlari bor (UI "Rollback" tugmasi uchun). */
  rollbackDefined: z.boolean(),
  durationMs: z.number().int().min(0),
  outputTruncated: z.boolean(),
});
export type DeploySummary = z.infer<typeof DeploySummarySchema>;

// --- REST --------------------------------------------------------------------------------------

export const DeployInspectBodySchema = z.object({ commit: Commit.optional() }).strict();
export type DeployInspectBody = z.infer<typeof DeployInspectBodySchema>;

export const DeployRunBodySchema = z
  .object({ target: z.string().regex(TARGET_NAME_RE), recipeHash: z.string().regex(RECIPE_HASH_RE), commit: Commit })
  .strict();
export type DeployRunBody = z.infer<typeof DeployRunBodySchema>;

export const DeployOutputQuerySchema = z.object({ after: z.coerce.number().int().min(0).max(1_000_000_000).default(0) }).strict();
export type DeployOutputQuery = z.infer<typeof DeployOutputQuerySchema>;

/** Tarix qatori (`commands` dan; chiqish saqlanmaydi). */
export const DeployRunDtoSchema = z.object({
  commandId: z.uuid(),
  kind: z.enum(['run', 'rollback']),
  target: z.string(),
  commit: z.string(),
  recipeHash: z.string(),
  status: z.string(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  summary: DeploySummarySchema.nullable(),
  requestedByDeviceId: z.uuid(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type DeployRunDto = z.infer<typeof DeployRunDtoSchema>;
export const DeployRunsResponseSchema = z.object({ items: z.array(DeployRunDtoSchema) });
export type DeployRunsResponse = z.infer<typeof DeployRunsResponseSchema>;

export const DeployInspectResponseSchema = z.object({
  commandId: z.uuid(),
  status: z.string(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  /** Muvaffaqiyatli bo'lsa agentd xulosasi (markazda faqat xotirada, 2 daqiqa). */
  inspect: DeployInspectResultSchema.nullable(),
});
export type DeployInspectResponse = z.infer<typeof DeployInspectResponseSchema>;

/** Bitta qadam buyrug'i matni (sof; center ham dashboard ham ishlatadi). Redakt qilinmagan: chaqiruvchi redakt qiladi. */
export function describeStep(s: Pick<DeployStep, 'kind' | 'argv' | 'shell'>): string {
  return s.kind === 'shell' ? `sh -c ${JSON.stringify(s.shell ?? '')}` : s.argv.map((a) => (/^[A-Za-z0-9_./:=@%+,{}-]+$/.test(a) ? a : JSON.stringify(a))).join(' ');
}

/** Maqsad bo'yicha egasi ko'radigan xulosa: har qadam buyrug'i (preflight/steps/health/rollback). */
export function describeTargetPlan(t: DeployTarget, phases: 'run' | 'rollback' = 'run'): string {
  const out: string[] = [];
  const phase = (title: string, steps: readonly DeployStep[]): void => {
    if (steps.length === 0) return;
    out.push(`${title}:`);
    steps.forEach((s, i) => out.push(`  ${i + 1}. ${s.name}: ${describeStep(s)}`));
  };
  const health = (): void => {
    if (t.health) out.push(`health: ${t.health.kind === 'http' ? `GET ${t.health.url ?? ''}` : describeStep({ kind: 'argv', argv: t.health.argv, shell: null })} (x${1 + t.health.retries}, ${t.health.intervalSec}s)`);
  };
  if (phases === 'run') {
    phase('preflight', t.preflight);
    phase('steps', t.steps);
    health();
  }
  phase('rollback', t.rollback);
  if (phases === 'rollback') health();
  return out.join('\n');
}
