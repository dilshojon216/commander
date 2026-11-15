import { z } from 'zod';
import { EpochMsSchema, envelopeMessage } from './envelope.js';

/**
 * Sozlamalarni markazdan tarqatish ("profillar", task 3.7). Ikki tomon:
 *  - klientlar <-> center (REST `/v1/config/...`);
 *  - center <-> agentd: imzolangan buyruqlar `config.capture|apply|rollback` (commands.ts), katta mazmun uchun `config.chunk`
 *    (ikki yo'nalishda) va heartbeat'dagi `config` hisoboti (drift).
 *
 * Boshqariladigan elementlar (QAT'IY ruxsat ro'yxati, `~/.claude` ichida): `CLAUDE.md`, `skills/<nom>/...`, `agents/<nom>.md`,
 * `commands/<nom>.md` va `settings.json` ning KICHIK bo'lagi (`permissions.allow|deny`, sirsiz `env`). Commander'ning o'z hook'lari,
 * tokenlari va `COMMANDER_*`/`OTEL_*` env'lari HECH QACHON profilga kirmaydi va tegilmaydi.
 */

export const CONFIG_LIMITS = {
  /** Bitta fayl (bayt): kattasi o'tkazib yuboriladi. */
  fileMaxBytes: 256 * 1024,
  /** Butun profil (bayt, xom matn). */
  profileMaxBytes: 5 * 1024 * 1024,
  maxFiles: 400,
  maxPathChars: 200,
  maxPathDepth: 8,
  maxSkipped: 100,
  /** `config.chunk`: gzip bayt bo'lagi (base64 dan oldin). WS xabari <= 256 KB (agent -> center). */
  chunkRawBytes: 96 * 1024,
  maxChunks: 80,
  /** Chunk'lar xotirada kutish muddati (ms). */
  chunkTtlMs: 2 * 60_000,
  /** Dry-run: har fayl diff'i va umumiy diff hajmi (bayt). Natija WS xabariga (<= 256 KB) sig'ishi uchun. */
  maxDiffBytesPerFile: 12 * 1024,
  maxDiffBytesTotal: 100 * 1024,
  maxSettingsEntries: 200,
  maxEnvEntries: 50,
  entryMaxChars: 300,
  envValueMaxChars: 512,
  /** REST sinxron kutish (ms). */
  captureWaitMs: 45_000,
  diffWaitMs: 45_000,
  maxBackupsReported: 10,
  /** Heartbeat'da drift hisoboti oralig'i (ms). */
  reportIntervalMs: 10 * 60_000,
} as const;

export const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

// --- yo'l ruxsat ro'yxati (sof; agentd va center bir xil tekshiradi) ------------------------------

export const CONFIG_ITEM_KINDS = ['claude_md', 'skill', 'agent', 'command'] as const;
export const ConfigItemKindSchema = z.enum(CONFIG_ITEM_KINDS);
export type ConfigItemKind = z.infer<typeof ConfigItemKindSchema>;

const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Windows zahira nomlari (kengaytma bilan ham: `nul.md`). */
const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
/** Skill ichidagi MATN fayllar (binar rasm/arxiv yo'q). */
export const SKILL_TEXT_EXTENSIONS: readonly string[] = ['md', 'txt', 'json', 'yaml', 'yml', 'toml', 'sh', 'bash', 'py', 'js', 'mjs', 'cjs', 'ts', 'css', 'html', 'csv'];
const SKILL_BARE_NAMES: readonly string[] = ['LICENSE', 'NOTICE'];

export type ConfigPathCheck = { ok: true; kind: ConfigItemKind } | { ok: false; reason: string };

function segmentProblem(seg: string): string | null {
  if (!SEGMENT_RE.test(seg)) return 'segment has unsafe characters';
  if (seg.endsWith('.')) return 'segment ends with a dot';
  if (seg === '.' || seg === '..' || seg.includes('..')) return 'path traversal';
  if (WINDOWS_RESERVED_RE.test(seg)) return 'reserved name';
  return null;
}

/**
 * Profil ichidagi NISBIY yo'l (POSIX `/`, `~/.claude` ga nisbatan) ruxsat ro'yxatidagimi? Backslash, mutlaq yo'l, `..`, yashirin
 * (nuqta bilan boshlanuvchi) fayllar, Windows zahira nomlari, `:` va boshqaruv belgilari rad etiladi.
 */
export function checkConfigPath(rel: string): ConfigPathCheck {
  if (rel.length === 0 || rel.length > CONFIG_LIMITS.maxPathChars) return { ok: false, reason: 'bad path length' };
  if (rel.includes('\\') || rel.includes('\0') || rel.includes(':') || rel.startsWith('/')) return { ok: false, reason: 'path must be relative with "/" separators' };
  const segs = rel.split('/');
  if (segs.length > CONFIG_LIMITS.maxPathDepth) return { ok: false, reason: 'path too deep' };
  for (const s of segs) {
    const p = segmentProblem(s);
    if (p) return { ok: false, reason: p };
  }
  const [top, name] = segs;
  if (segs.length === 1 && top === 'CLAUDE.md') return { ok: true, kind: 'claude_md' };
  if (top === 'agents' && segs.length === 2 && name!.endsWith('.md') && name!.length > 3) return { ok: true, kind: 'agent' };
  if (top === 'commands' && segs.length === 2 && name!.endsWith('.md') && name!.length > 3) return { ok: true, kind: 'command' };
  if (top === 'skills' && segs.length >= 3) {
    const file = segs[segs.length - 1]!;
    const dot = file.lastIndexOf('.');
    const ext = dot > 0 ? file.slice(dot + 1).toLowerCase() : '';
    if (SKILL_TEXT_EXTENSIONS.includes(ext) || SKILL_BARE_NAMES.includes(file)) return { ok: true, kind: 'skill' };
    return { ok: false, reason: 'skill file type is not an allowed text type' };
  }
  return { ok: false, reason: 'path is outside the managed set' };
}

/** Windows/macOS fayl tizimi registrga befarq: ikki yo'l faqat registrda farq qilsa to'qnashadi. */
export function configPathKey(rel: string): string {
  return rel.toLowerCase();
}

// --- settings.json bo'lagi -------------------------------------------------------------------------

const EntrySchema = z
  .string()
  .min(1)
  .max(CONFIG_LIMITS.entryMaxChars)
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\u0000-\u001f\u007f]+$/, 'control characters are not allowed');

export const EnvKeySchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);
const EnvValueSchema = z
  .string()
  .max(CONFIG_LIMITS.envValueMaxChars)
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\u0000-\u001f\u007f]*$/, 'control characters are not allowed');

/** Profilga kiradigan `settings.json` bo'lagi. `.strict()`: `hooks`, `statusLine`, `permissions.defaultMode` va h.k. kira olmaydi. */
export const SettingsFragmentSchema = z
  .object({
    permissions: z
      .object({
        allow: z.array(EntrySchema).max(CONFIG_LIMITS.maxSettingsEntries).default([]),
        deny: z.array(EntrySchema).max(CONFIG_LIMITS.maxSettingsEntries).default([]),
      })
      .strict()
      .default({ allow: [], deny: [] }),
    env: z.record(EnvKeySchema, EnvValueSchema).default({}),
  })
  .strict();
export type SettingsFragment = z.infer<typeof SettingsFragmentSchema>;

export const EMPTY_SETTINGS_FRAGMENT: SettingsFragment = { permissions: { allow: [], deny: [] }, env: {} };

/** Env kalitlari: Commander'niki, provayder/tarmoq/ishga tushirish xavfi bor va sirli nomlar HECH QACHON. */
const ENV_KEY_FORBIDDEN_PREFIXES = ['ANTHROPIC_', 'COMMANDER_', 'OTEL_', 'AWS_', 'AZURE_', 'GOOGLE_', 'GCP_', 'NODE_', 'LD_', 'DYLD_', 'NPM_', 'CLAUDE_CODE_USE_', 'CLAUDE_CODE_OAUTH', 'CLAUDE_CONFIG_DIR'];
const ENV_KEY_FORBIDDEN_EXACT = ['PATH', 'HOME', 'USER', 'SHELL', 'BASH_ENV', 'ENV', 'IFS', 'PYTHONPATH', 'PYTHONSTARTUP', 'CLAUDE_CODE_ENABLE_TELEMETRY', 'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB'];
const ENV_KEY_SECRET_RE = /(TOKEN|SECRET|PASSWORD|PASSWD|PWD|API_?KEY|APIKEY|PRIVATE|CREDENTIAL|AUTH|COOKIE|DSN)/;
const ENV_KEY_PROXY_RE = /(^|_)(HTTPS?|ALL|NO|FTP)_PROXY$/i;

/** `null` = yaroqli; aks holda sabab (xabar sirni O'Z ICHIGA OLMAYDI). */
export function envKeyProblem(key: string): string | null {
  if (!EnvKeySchema.safeParse(key).success) return 'invalid env name';
  if (ENV_KEY_FORBIDDEN_EXACT.includes(key)) return 'env name is protected';
  if (ENV_KEY_FORBIDDEN_PREFIXES.some((p) => key.startsWith(p))) return 'env name is protected (provider/commander/runtime)';
  if (ENV_KEY_PROXY_RE.test(key)) return 'proxy env is protected';
  if (ENV_KEY_SECRET_RE.test(key)) return 'env name looks secret';
  return null;
}

/** Bo'sh/hamma narsani qamrovchi specifier'lar: `Bash(*)`, `Bash(:*)`, `Edit(**)`. */
const MATCH_ALL_SPEC_RE = /^[\s*:/.\\]*$/;
/** Specifier'siz (yalang'och) holda `allow` ga YOZILishi mumkin bo'lgan faqat o'qish asboblari. */
const SAFE_BARE_ALLOW_TOOLS = ['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'WebSearch', 'TodoWrite'];

/**
 * M-07: `Bash(<buyruq>:*)` bilan allow'ga yozib bo'lmaydigan interpretator/shell/tarmoq/privilegiya buyruqlari (ular orqali ixtiyoriy
 * kod bajariladi yoki ruxsat tizimi aylanib o'tiladi). Birinchi so'z (yo'lsiz, kichik harf) solishtiriladi.
 */
const DANGEROUS_BASH_HEADS: readonly string[] = [
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'csh', 'tcsh', 'fish', 'python', 'python2', 'python3', 'pypy', 'node', 'nodejs', 'deno', 'bun', 'perl', 'ruby', 'php', 'lua', 'osascript', 'powershell', 'pwsh', 'cmd',
  'curl', 'wget', 'ssh', 'scp', 'sftp', 'rsync', 'nc', 'ncat', 'netcat', 'socat', 'telnet', 'sudo', 'su', 'doas', 'env', 'xargs', 'eval', 'exec', 'nohup', 'timeout', 'time', 'command', 'builtin',
  'npx', 'bunx', 'pnpx', 'uvx', 'pipx', 'source', '.', 'find', 'awk', 'gawk', 'sed',
];
/** Himoyalangan katalog segmentlari: Claude/Commander konfiguratsiyasi, kalitlar va git hook'lari ruxsat bilan yozilmaydi/o'qilmaydi. */
const PROTECTED_PATH_RE = /(^|[\s/~\\])\.(claude|commander|ssh|gnupg|aws|kube|git\/hooks|config\/gcloud)(\/|\\|$|\*)/i;
const FILE_TOOLS = ['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'NotebookRead', 'Glob', 'Grep', 'LS'];

/** `allow` yozuvi: juda keng (hamma buyruq/fayl) bo'lsa sabab, aks holda `null`. `deny` ga cheklov yo'q (sintaksisdan boshqa). */
export function allowEntryProblem(entry: string): string | null {
  const e = entry.trim();
  if (e === '*' || e === '**') return 'wildcard allow-all is refused';
  const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:\(([\s\S]*)\))?$/.exec(e);
  if (!m) return 'unrecognised permission syntax';
  const tool = m[1]!;
  const spec = m[2];
  if (tool.startsWith('mcp__')) return tool.includes('*') || spec !== undefined ? 'mcp allow must name a server or tool without wildcards' : null;
  if (spec === undefined) return SAFE_BARE_ALLOW_TOOLS.includes(tool) ? null : `bare ${tool} allow is too broad (add a specifier)`;
  if (MATCH_ALL_SPEC_RE.test(spec)) return `${tool}(${spec.trim()}) matches everything`;
  if (tool === 'Bash') {
    const head = (spec.trim().split(/[\s:(*]/)[0] ?? '').split(/[\\/]/).pop()?.toLowerCase() ?? '';
    if (head === '' || DANGEROUS_BASH_HEADS.includes(head)) return `Bash(${head || '?'}...) allows arbitrary code execution and is refused`;
  }
  if (FILE_TOOLS.includes(tool) && PROTECTED_PATH_RE.test(spec)) return `${tool} allow on a protected path (.claude/.commander/.ssh/...) is refused`;
  return null;
}

export interface SettingsProblem {
  where: string;
  reason: string;
}

/**
 * Bo'lakni tekshiradi (sof). `looksSecret` chaqiruvchi tomonidan beriladi (agentd/center o'zining redact'ini ishlatadi; contracts
 * node'siz). Muammolar ro'yxati: bo'sh = yaroqli. Xabarlarda qiymat YO'Q.
 */
export function checkSettingsFragment(f: SettingsFragment, looksSecret: (text: string) => boolean): SettingsProblem[] {
  const out: SettingsProblem[] = [];
  for (const [i, e] of f.permissions.allow.entries()) {
    const p = allowEntryProblem(e);
    if (p) out.push({ where: `permissions.allow[${i}]`, reason: p });
    else if (looksSecret(e)) out.push({ where: `permissions.allow[${i}]`, reason: 'entry looks like it contains a secret' });
  }
  for (const [i, e] of f.permissions.deny.entries()) {
    if (looksSecret(e)) out.push({ where: `permissions.deny[${i}]`, reason: 'entry looks like it contains a secret' });
  }
  const envKeys = Object.keys(f.env);
  if (envKeys.length > CONFIG_LIMITS.maxEnvEntries) out.push({ where: 'env', reason: 'too many env entries' });
  for (const [k, v] of Object.entries(f.env)) {
    const kp = envKeyProblem(k);
    if (kp) out.push({ where: `env.${k}`, reason: kp });
    else if (looksSecret(v) || looksSecret(`${k}=${v}`)) out.push({ where: `env.${k}`, reason: 'value looks like a secret' });
  }
  return out;
}

// --- wire: element manifesti, chunk, buyruq payload'lari ----------------------------------------------

export const ConfigItemSchema = z.object({
  path: z.string().min(1).max(CONFIG_LIMITS.maxPathChars),
  kind: ConfigItemKindSchema,
  sha256: Sha256Schema,
  size: z.number().int().min(0).max(CONFIG_LIMITS.fileMaxBytes),
  /** POSIX: bajariladigan (0755). Windows'da e'tiborsiz. */
  exec: z.boolean(),
});
export type ConfigItem = z.infer<typeof ConfigItemSchema>;

export const ConfigModeSchema = z.enum(['merge', 'mirror']);
export type ConfigMode = z.infer<typeof ConfigModeSchema>;

/** gzip'langan JSON "bundle" (`{files:[{path,content}], settings}`) bo'laklari: xabarlar `config.chunk`. */
export const ConfigBundleRefSchema = z.object({
  chunks: z.number().int().min(1).max(CONFIG_LIMITS.maxChunks),
  /** gzip baytlarining sha256'i (yaxlitlik; imzolangan payload ichida). */
  sha256: Sha256Schema,
  /** gzip bayt soni. */
  bytes: z.number().int().min(1).max(CONFIG_LIMITS.maxChunks * CONFIG_LIMITS.chunkRawBytes),
});
export type ConfigBundleRef = z.infer<typeof ConfigBundleRefSchema>;

export const ConfigChunkPayloadSchema = z.object({
  /** = bundle'ning gzip baytlari sha256'i (kontent-adresli: chunk buyruqdan oldin yuborilishi mumkin, yaxlitlik ham shu bilan tekshiriladi). */
  transferId: Sha256Schema,
  seq: z.number().int().min(0).max(CONFIG_LIMITS.maxChunks - 1),
  total: z.number().int().min(1).max(CONFIG_LIMITS.maxChunks),
  /** base64 (<= chunkRawBytes baytning kodlangani). */
  data: z.string().min(1).max(Math.ceil((CONFIG_LIMITS.chunkRawBytes * 4) / 3) + 8),
});
export type ConfigChunkPayload = z.infer<typeof ConfigChunkPayloadSchema>;
export const ConfigChunkMessageSchema = envelopeMessage('config.chunk', ConfigChunkPayloadSchema);
export type ConfigChunkMessage = z.infer<typeof ConfigChunkMessageSchema>;

export const ConfigCapturePayloadSchema = z.object({ includeSettings: z.boolean() }).strict();
export type ConfigCapturePayload = z.infer<typeof ConfigCapturePayloadSchema>;

export const ConfigApplyPayloadSchema = z
  .object({
    profileName: z.string().min(1).max(64),
    profileVersion: z.number().int().min(1),
    mode: ConfigModeSchema,
    /** `true`: faqat reja (hech narsa yozilmaydi). */
    dryRun: z.boolean(),
    items: z.array(ConfigItemSchema).max(CONFIG_LIMITS.maxFiles),
    /** Bo'lak xeshi (kanonik JSON); `null` = profilda settings bo'lagi yo'q. */
    settingsSha256: Sha256Schema.nullable(),
    bundle: ConfigBundleRefSchema.nullable(),
    /** Haqiqiy qo'llash: foydalanuvchi ko'rgan dry-run rejasi xeshi; mos kelmasa `config_plan_changed`. */
    expectedPlanHash: Sha256Schema.optional(),
  })
  .strict();
export type ConfigApplyPayload = z.infer<typeof ConfigApplyPayloadSchema>;

export const BACKUP_ID_RE = /^config-\d{13}$/;
export const ConfigBackupIdSchema = z.string().regex(BACKUP_ID_RE);
export const ConfigRollbackPayloadSchema = z.object({ backupId: ConfigBackupIdSchema }).strict();
export type ConfigRollbackPayload = z.infer<typeof ConfigRollbackPayloadSchema>;

// --- agent natijalari (`command.result.result.config`) -------------------------------------------------

export const ConfigSkippedSchema = z.object({ path: z.string().max(CONFIG_LIMITS.maxPathChars), reason: z.string().max(200) });
export type ConfigSkipped = z.infer<typeof ConfigSkippedSchema>;

export const ConfigCaptureResultSchema = z.object({
  kind: z.literal('capture'),
  items: z.array(ConfigItemSchema).max(CONFIG_LIMITS.maxFiles),
  skipped: z.array(ConfigSkippedSchema).max(CONFIG_LIMITS.maxSkipped),
  settingsSha256: Sha256Schema.nullable(),
  bundle: ConfigBundleRefSchema.nullable(),
  totalBytes: z.number().int().min(0),
});
export type ConfigCaptureResult = z.infer<typeof ConfigCaptureResultSchema>;

export const PLAN_ACTIONS = ['add', 'update', 'delete', 'unchanged', 'skip'] as const;
export const ConfigPlanActionSchema = z.enum(PLAN_ACTIONS);
export type ConfigPlanAction = z.infer<typeof ConfigPlanActionSchema>;

export const ConfigPlanEntrySchema = z.object({
  path: z.string().max(CONFIG_LIMITS.maxPathChars),
  kind: ConfigItemKindSchema,
  action: ConfigPlanActionSchema,
  /** `skip` sababi yoki diff yo'qligi izohi. */
  reason: z.string().max(200).optional(),
  /** Unified diff (matn; redakt qilingan, kesilgan). */
  diff: z.string().max(CONFIG_LIMITS.maxDiffBytesPerFile + 2048).optional(),
  diffTruncated: z.boolean().optional(),
});
export type ConfigPlanEntry = z.infer<typeof ConfigPlanEntrySchema>;

export const ConfigSettingsPlanSchema = z.object({
  changed: z.boolean(),
  allowAdd: z.array(z.string().max(CONFIG_LIMITS.entryMaxChars)).max(CONFIG_LIMITS.maxSettingsEntries),
  allowRemove: z.array(z.string().max(CONFIG_LIMITS.entryMaxChars)).max(CONFIG_LIMITS.maxSettingsEntries),
  denyAdd: z.array(z.string().max(CONFIG_LIMITS.entryMaxChars)).max(CONFIG_LIMITS.maxSettingsEntries),
  denyRemove: z.array(z.string().max(CONFIG_LIMITS.entryMaxChars)).max(CONFIG_LIMITS.maxSettingsEntries),
  envSet: z.array(z.string().max(CONFIG_LIMITS.entryMaxChars)).max(CONFIG_LIMITS.maxEnvEntries),
  envRemove: z.array(z.string().max(80)).max(CONFIG_LIMITS.maxEnvEntries),
  /** Agent bo'lakni rad etgan bo'lsa sabablar (masalan sirli env). */
  refused: z.array(z.string().max(200)).max(50),
});
export type ConfigSettingsPlan = z.infer<typeof ConfigSettingsPlanSchema>;

export const ConfigPlanResultSchema = z.object({
  kind: z.literal('plan'),
  planHash: Sha256Schema,
  mode: ConfigModeSchema,
  entries: z.array(ConfigPlanEntrySchema).max(CONFIG_LIMITS.maxFiles * 2),
  settings: ConfigSettingsPlanSchema.nullable(),
  summary: z.object({ add: z.number().int(), update: z.number().int(), delete: z.number().int(), unchanged: z.number().int(), skip: z.number().int() }),
  /** Diff hajmi chegarasi sabab ba'zi diff'lar tushirilgan. */
  truncated: z.boolean(),
});
export type ConfigPlanResult = z.infer<typeof ConfigPlanResultSchema>;

export const ConfigApplyResultSchema = z.object({
  kind: z.literal('apply'),
  backupId: ConfigBackupIdSchema.nullable(),
  applied: z.object({ add: z.number().int(), update: z.number().int(), delete: z.number().int() }),
  settingsChanged: z.boolean(),
});
export type ConfigApplyResult = z.infer<typeof ConfigApplyResultSchema>;

export const ConfigRollbackResultSchema = z.object({
  kind: z.literal('rollback'),
  backupId: ConfigBackupIdSchema,
  restored: z.number().int(),
  skipped: z.array(ConfigSkippedSchema).max(CONFIG_LIMITS.maxFiles),
});
export type ConfigRollbackResult = z.infer<typeof ConfigRollbackResultSchema>;

export const ConfigResultSchema = z.discriminatedUnion('kind', [ConfigCaptureResultSchema, ConfigPlanResultSchema, ConfigApplyResultSchema, ConfigRollbackResultSchema]);
export type ConfigResult = z.infer<typeof ConfigResultSchema>;

// --- heartbeat hisoboti (drift) --------------------------------------------------------------------------

export const ConfigBackupInfoSchema = z.object({
  id: ConfigBackupIdSchema,
  createdAt: EpochMsSchema,
  profileName: z.string().max(64).optional(),
  profileVersion: z.number().int().min(1).optional(),
  /** Shu zaxiradan qaytarilgan. */
  rolledBack: z.boolean().optional(),
});
export type ConfigBackupInfo = z.infer<typeof ConfigBackupInfoSchema>;

export const ConfigStateReportSchema = z.object({
  /** Boshqariladigan (manifestdagi) fayllarning HOZIRGI xeshlari; `null` = fayl yo'q. */
  files: z.array(z.object({ path: z.string().max(CONFIG_LIMITS.maxPathChars), sha256: Sha256Schema.nullable() })).max(CONFIG_LIMITS.maxFiles),
  /** Oxirgi muvaffaqiyatli qo'llash; `null` = hech qachon (manifest yo'q). */
  applied: z
    .object({
      profileName: z.string().max(64),
      profileVersion: z.number().int().min(1),
      mode: ConfigModeSchema,
      appliedAt: EpochMsSchema,
    })
    .nullable(),
  /** Qo'llangan bo'lakning xeshi va u hali joyidami (`intact`). */
  settings: z.object({ sha256: Sha256Schema, intact: z.boolean() }).nullable(),
  backups: z.array(ConfigBackupInfoSchema).max(CONFIG_LIMITS.maxBackupsReported),
  /** Hisobot tuzilgan vaqt. */
  at: EpochMsSchema,
});
export type ConfigStateReport = z.infer<typeof ConfigStateReportSchema>;

// --- REST --------------------------------------------------------------------------------------------------

const IsoDate = z.string();
export const ConfigProfileNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/);

export const ConfigProfileSummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  version: z.number().int().min(1),
  sourceMachineId: z.uuid().nullable(),
  sourceMachineSlug: z.string().nullable(),
  createdByDeviceId: z.uuid().nullable(),
  createdAt: IsoDate,
  fileCount: z.number().int(),
  totalBytes: z.number().int(),
  hasSettings: z.boolean(),
  /** Shu nomning eng yangi versiyasimi. */
  latest: z.boolean(),
});
export type ConfigProfileSummary = z.infer<typeof ConfigProfileSummarySchema>;

export const ConfigProfileFileSchema = z.object({ path: z.string(), kind: ConfigItemKindSchema, sha256: Sha256Schema, size: z.number().int(), exec: z.boolean() });
export type ConfigProfileFile = z.infer<typeof ConfigProfileFileSchema>;

export const ConfigProfileDetailSchema = ConfigProfileSummarySchema.extend({
  files: z.array(ConfigProfileFileSchema),
  settings: SettingsFragmentSchema.nullable(),
  skipped: z.array(ConfigSkippedSchema),
});
export type ConfigProfileDetail = z.infer<typeof ConfigProfileDetailSchema>;

export const ListConfigProfilesResponseSchema = z.object({ items: z.array(ConfigProfileSummarySchema) });
export type ListConfigProfilesResponse = z.infer<typeof ListConfigProfilesResponseSchema>;

export const ConfigFileContentQuerySchema = z.object({ path: z.string().min(1).max(CONFIG_LIMITS.maxPathChars) }).strict();
export type ConfigFileContentQuery = z.infer<typeof ConfigFileContentQuerySchema>;
export const ConfigFileContentResponseSchema = z.object({ path: z.string(), sha256: Sha256Schema, size: z.number().int(), content: z.string() });
export type ConfigFileContentResponse = z.infer<typeof ConfigFileContentResponseSchema>;

export const CaptureConfigBodySchema = z.object({ machineId: z.uuid(), name: ConfigProfileNameSchema.default('default') }).strict();
export type CaptureConfigBody = z.infer<typeof CaptureConfigBodySchema>;
export const CaptureConfigResponseSchema = z.object({ profile: ConfigProfileSummarySchema, skipped: z.array(ConfigSkippedSchema), commandId: z.uuid() });
export type CaptureConfigResponse = z.infer<typeof CaptureConfigResponseSchema>;

export const ConfigDiffBodySchema = z.object({ profileId: z.uuid(), mode: ConfigModeSchema.default('merge') }).strict();
export type ConfigDiffBody = z.infer<typeof ConfigDiffBodySchema>;
export const ConfigDiffResponseSchema = z.object({ commandId: z.uuid(), profile: ConfigProfileSummarySchema, plan: ConfigPlanResultSchema });
export type ConfigDiffResponse = z.infer<typeof ConfigDiffResponseSchema>;

export const ConfigApplyBodySchema = z.object({ profileId: z.uuid(), mode: ConfigModeSchema.default('merge'), expectedPlanHash: Sha256Schema }).strict();
export type ConfigApplyBody = z.infer<typeof ConfigApplyBodySchema>;

export const ConfigRollbackBodySchema = z.object({ backupId: ConfigBackupIdSchema }).strict();
export type ConfigRollbackBody = z.infer<typeof ConfigRollbackBodySchema>;

export const CONFIG_MACHINE_STATUSES = ['in_sync', 'drift', 'not_applied', 'unsupported', 'unknown'] as const;
export const ConfigMachineStatusSchema = z.enum(CONFIG_MACHINE_STATUSES);
export type ConfigMachineStatus = z.infer<typeof ConfigMachineStatusSchema>;

export const ConfigMachineStateSchema = z.object({
  machineId: z.uuid(),
  slug: z.string(),
  name: z.string(),
  online: z.boolean(),
  /** agentd 3.7 ni biladi (heartbeat `control.configSync`). */
  supported: z.boolean(),
  allowRead: z.boolean(),
  allowWrite: z.boolean(),
  status: ConfigMachineStatusSchema,
  applied: z.object({ profileName: z.string(), profileVersion: z.number().int(), mode: ConfigModeSchema, appliedAt: IsoDate }).nullable(),
  /** Qo'llangan profil nomining eng yangi versiyasi (taqqoslash maqsadi). */
  latestVersion: z.number().int().nullable(),
  drift: z.object({
    outdated: z.boolean(),
    modified: z.array(z.string()),
    missing: z.array(z.string()),
    settings: z.boolean(),
  }),
  reportedAt: IsoDate.nullable(),
  backups: z.array(ConfigBackupInfoSchema),
});
export type ConfigMachineState = z.infer<typeof ConfigMachineStateSchema>;

export const ConfigStatusQuerySchema = z.object({ profile: ConfigProfileNameSchema.optional() }).strict();
export type ConfigStatusQuery = z.infer<typeof ConfigStatusQuerySchema>;
export const ConfigStatusResponseSchema = z.object({ profile: ConfigProfileSummarySchema.nullable(), machines: z.array(ConfigMachineStateSchema) });
export type ConfigStatusResponse = z.infer<typeof ConfigStatusResponseSchema>;

export const ConfigSettingsBodySchema = z.object({ driftNotify: z.boolean() }).strict();
export type ConfigSettingsBody = z.infer<typeof ConfigSettingsBodySchema>;
export const ConfigSettingsResponseSchema = ConfigSettingsBodySchema;
export type ConfigSettingsResponse = z.infer<typeof ConfigSettingsResponseSchema>;

/** Telegram/log uchun qisqa: `fayl yo'qolgan` kabi. */
export const CONFIG_DRIFT_REASONS = ['outdated', 'modified', 'missing', 'settings'] as const;

// --- yordamchilar (sof) -----------------------------------------------------------------------------------

/** Bo'lakni kanonik ko'rinishga keltiradi (allow/deny: takrorsiz va saralangan): xesh barqaror bo'lsin. */
export function normalizeSettingsFragment(f: SettingsFragment): SettingsFragment {
  const uniqSorted = (a: string[]): string[] => [...new Set(a)].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  return { permissions: { allow: uniqSorted(f.permissions.allow), deny: uniqSorted(f.permissions.deny) }, env: { ...f.env } };
}

/**
 * `config.chunk` bo'laklarini yig'uvchi (sof; vaqt tashqaridan). Agentd (center -> agent) va center (agent -> center) bir xil
 * ishlatadi. Chegaralar: umumiy xotira, bir vaqtdagi uzatishlar soni va muddat; to'lmagan uzatish eskirgach tashlanadi.
 * Qaytarilgan bo'laklar base64 matn (tartib bilan); gzip ochish va xesh tekshiruvi chaqiruvchida.
 */
export class ConfigChunkBuffer {
  private readonly transfers = new Map<string, { total: number; parts: Array<string | undefined>; got: number; bytes: number; at: number }>();
  private bytes = 0;

  constructor(
    private readonly maxBytes: number = 16 * 1024 * 1024,
    private readonly ttlMs: number = CONFIG_LIMITS.chunkTtlMs,
    private readonly maxTransfers: number = 8,
  ) {}

  /** `false` = rad etildi (total nomuvofiq yoki hajm chegarasi). Takroriy `seq` jim e'tiborsiz. */
  add(c: ConfigChunkPayload, now: number): boolean {
    this.prune(now);
    let t = this.transfers.get(c.transferId);
    if (!t) {
      while (this.transfers.size >= this.maxTransfers) this.dropOldest();
      t = { total: c.total, parts: new Array<string | undefined>(c.total).fill(undefined), got: 0, bytes: 0, at: now };
      this.transfers.set(c.transferId, t);
    }
    if (t.total !== c.total || c.seq >= t.total) return false;
    if (t.parts[c.seq] !== undefined) return true;
    while (this.bytes + c.data.length > this.maxBytes && this.transfers.size > 1) this.dropOldest(c.transferId);
    if (this.bytes + c.data.length > this.maxBytes) return false;
    t.parts[c.seq] = c.data;
    t.got += 1;
    t.bytes += c.data.length;
    this.bytes += c.data.length;
    return true;
  }

  /** To'liq bo'lsa tartiblangan bo'laklar (o'chirmaydi), aks holda `undefined`. */
  get(transferId: string, total: number): string[] | undefined {
    const t = this.transfers.get(transferId);
    if (!t || t.total !== total || t.got !== total) return undefined;
    return t.parts as string[];
  }

  delete(transferId: string): void {
    const t = this.transfers.get(transferId);
    if (!t) return;
    this.bytes -= t.bytes;
    this.transfers.delete(transferId);
  }

  prune(now: number): void {
    for (const [id, t] of this.transfers) if (now - t.at > this.ttlMs) this.delete(id);
  }

  size(): number {
    return this.transfers.size;
  }

  private dropOldest(except?: string): void {
    let oldest: string | undefined;
    let at = Infinity;
    for (const [id, t] of this.transfers) {
      if (id !== except && t.at < at) {
        at = t.at;
        oldest = id;
      }
    }
    if (oldest) this.delete(oldest);
  }
}
