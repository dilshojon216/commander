import { z } from 'zod';

/**
 * Haftalik xavfsizlik va dependency tekshiruvi (task 6.10). Imzolangan, FAQAT o'qiydigan buyruq `project.scan`
 * (loyiha buyruqlaridan biri: `root` markaz DB'sidan boradi).
 *
 * agentd faqat MAHALLIY mavjud, o'qiydigan asboblarni ishga tushiradi (npm/pnpm/yarn audit, pip-audit, dart/flutter pub outdated,
 * go list -m -u, govulncheck) va o'rnatilgan sir-skaner (kuzatiladigan fayllar). Natija normallashtiriladi (jiddiylik hisoblari,
 * eng muhim topilmalar). MAXFIYLIK (CLAUDE.md qoida 5): sir-skaner topilmada FAQAT fayl + qator + qoida nomini qaytaradi,
 * qiymatni HECH QACHON; asbob chiqishidagi matnlar `redact()` dan o'tadi va cheklanadi; markaz yana redakt qiladi.
 */

export const SCAN_LIMITS = {
  rootMaxChars: 4096,
  /** Natijada qaytadigan topilmalar soni (eng jiddiylari; qolgani `findingsTotal`da sanaladi). */
  maxFindings: 200,
  maxAdvisoryIds: 8,
  titleMaxChars: 200,
  packageMaxChars: 214,
  versionMaxChars: 64,
  pathMaxChars: 512,
  ruleMaxChars: 64,
  detailMaxChars: 300,
  /** agentd: bitta asbob muddati (ms) va butun skan muddati. */
  toolTimeoutMs: 120_000,
  totalTimeoutMs: 270_000,
  /** Sir-skaner: ko'riladigan fayllar soni, bitta fayl hajmi (bayt). */
  maxScanFiles: 4000,
  maxScanFileBytes: 512 * 1024,
  /** Asbob chiqishi (bayt) chegarasi. */
  maxToolOutputBytes: 16 * 1024 * 1024,
  /** Markaz: loyiha bo'yicha saqlanadigan skanlar (eskilari o'chadi). */
  keepPerProject: 60,
  /** Trend nuqtalari. */
  trendPoints: 12,
  /** "Claude tuzatsin" promptining eng katta uzunligi (belgi). */
  fixPromptMaxChars: 4000,
} as const;

export const SCAN_SEVERITIES = ['critical', 'high', 'moderate', 'low', 'info'] as const;
export const ScanSeveritySchema = z.enum(SCAN_SEVERITIES);
export type ScanSeverity = z.infer<typeof ScanSeveritySchema>;

export const SCAN_ECOSYSTEMS = ['npm', 'pnpm', 'yarn', 'python', 'dart', 'flutter', 'go'] as const;
export const ScanEcosystemSchema = z.enum(SCAN_ECOSYSTEMS);
export type ScanEcosystem = z.infer<typeof ScanEcosystemSchema>;

export const SCAN_TOOLS = ['npm-audit', 'pnpm-audit', 'yarn-audit', 'pip-audit', 'dart-outdated', 'flutter-outdated', 'go-list-u', 'govulncheck', 'secret-scan', 'env-files'] as const;
export const ScanToolSchema = z.enum(SCAN_TOOLS);
export type ScanTool = z.infer<typeof ScanToolSchema>;

export const SCAN_FINDING_KINDS = ['vulnerability', 'outdated', 'secret', 'env_file'] as const;
export const ScanFindingKindSchema = z.enum(SCAN_FINDING_KINDS);
export type ScanFindingKind = z.infer<typeof ScanFindingKindSchema>;

export const SCAN_TOOL_STATUSES = ['ok', 'skipped', 'failed', 'timeout'] as const;
export const ScanToolStatusSchema = z.enum(SCAN_TOOL_STATUSES);
export type ScanToolStatus = z.infer<typeof ScanToolStatusSchema>;

// --- buyruq payload'i ---------------------------------------------------------------------------

export const ScanPayloadSchema = z.object({ root: z.string().min(1).max(SCAN_LIMITS.rootMaxChars) }).strict();
export type ScanPayload = z.infer<typeof ScanPayloadSchema>;

// --- natija -------------------------------------------------------------------------------------

export const ScanFindingSchema = z.object({
  kind: ScanFindingKindSchema,
  tool: ScanToolSchema,
  severity: ScanSeveritySchema,
  /** Paket nomi (`vulnerability`/`outdated`). */
  package: z.string().max(SCAN_LIMITS.packageMaxChars).nullable(),
  version: z.string().max(SCAN_LIMITS.versionMaxChars).nullable(),
  /** Tuzatilgan versiya (`vulnerability`) yoki eng so'nggi versiya (`outdated`). */
  fixVersion: z.string().max(SCAN_LIMITS.versionMaxChars).nullable(),
  /** GHSA/CVE/PYSEC/GO-... identifikatorlari. */
  advisoryIds: z.array(z.string().max(64)).max(SCAN_LIMITS.maxAdvisoryIds),
  title: z.string().max(SCAN_LIMITS.titleMaxChars),
  /** `secret`/`env_file`: loyiha ildizidan nisbiy fayl yo'li va qator. Qiymat HECH QACHON. */
  file: z.string().max(SCAN_LIMITS.pathMaxChars).nullable(),
  line: z.number().int().min(1).nullable(),
  rule: z.string().max(SCAN_LIMITS.ruleMaxChars).nullable(),
  /** Bevosita dependency'mi (npm: `isDirect`); noma'lum = null. */
  direct: z.boolean().nullable(),
});
export type ScanFinding = z.infer<typeof ScanFindingSchema>;

export const ScanToolRunSchema = z.object({
  tool: ScanToolSchema,
  status: ScanToolStatusSchema,
  /** Qisqa izoh: "asbob o'rnatilmagan", "tarmoq xatosi" ... (redakt qilingan). */
  detail: z.string().max(SCAN_LIMITS.detailMaxChars),
  /** Shu asbob topgan topilmalar soni (kesilishdan oldin). */
  findings: z.number().int().min(0),
});
export type ScanToolRun = z.infer<typeof ScanToolRunSchema>;

export const ScanCountsSchema = z.object({
  critical: z.number().int().min(0),
  high: z.number().int().min(0),
  moderate: z.number().int().min(0),
  low: z.number().int().min(0),
  info: z.number().int().min(0),
});
export type ScanCounts = z.infer<typeof ScanCountsSchema>;

export const ScanResultSchema = z.object({
  ecosystems: z.array(ScanEcosystemSchema).max(SCAN_ECOSYSTEMS.length),
  tools: z.array(ScanToolRunSchema).max(SCAN_TOOLS.length),
  /** Zaifliklar + sirlar bo'yicha jiddiylik hisoblari (eskirgan dependency'lar `outdatedCount`da alohida). */
  counts: ScanCountsSchema,
  vulnCount: z.number().int().min(0),
  outdatedCount: z.number().int().min(0),
  secretCount: z.number().int().min(0),
  envFileCount: z.number().int().min(0),
  findings: z.array(ScanFindingSchema).max(SCAN_LIMITS.maxFindings),
  findingsTotal: z.number().int().min(0),
  truncated: z.boolean(),
  filesScanned: z.number().int().min(0),
  durationMs: z.number().int().min(0),
});
export type ScanResult = z.infer<typeof ScanResultSchema>;

/** Jiddiylik tartibi (kichik = jiddiyroq). */
export const SEVERITY_RANK: Record<ScanSeverity, number> = { critical: 0, high: 1, moderate: 2, low: 3, info: 4 };

/** Normallashtirish: npm "medium" -> moderate, noma'lum -> info. */
export function normalizeSeverity(s: unknown): ScanSeverity {
  const v = typeof s === 'string' ? s.trim().toLowerCase() : '';
  if (v === 'critical') return 'critical';
  if (v === 'high') return 'high';
  if (v === 'moderate' || v === 'medium') return 'moderate';
  if (v === 'low') return 'low';
  return 'info';
}

export function emptyCounts(): ScanCounts {
  return { critical: 0, high: 0, moderate: 0, low: 0, info: 0 };
}

/** Topilmalarni jiddiylik bo'yicha tartiblaydi (kichik rank birinchi; keyin fayl/paket nomi: barqaror). */
export function sortFindings(list: readonly ScanFinding[]): ScanFinding[] {
  return [...list].sort((a, b) => {
    const k = (f: ScanFinding): number => (f.kind === 'outdated' ? 1 : 0);
    return k(a) - k(b) || SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || (a.package ?? a.file ?? '').localeCompare(b.package ?? b.file ?? '') || (a.line ?? 0) - (b.line ?? 0);
  });
}

// --- REST (markaz) --------------------------------------------------------------------------------

const IsoDate = z.string();

export const ScanSettingsSchema = z.object({
  /** Haftalik avtomatik tekshiruv (yakshanba 06:00 Toshkent). */
  enabled: z.boolean(),
  /** Telegram haftalik dayjest (faqat critical/high + sonlar). */
  digest: z.boolean(),
});
export type ScanSettings = z.infer<typeof ScanSettingsSchema>;
export const DEFAULT_SCAN_SETTINGS: ScanSettings = { enabled: true, digest: true };

export const ScanTrendPointSchema = z.object({ at: IsoDate, critical: z.number().int(), high: z.number().int(), moderate: z.number().int(), low: z.number().int(), secrets: z.number().int(), outdated: z.number().int() });
export type ScanTrendPoint = z.infer<typeof ScanTrendPointSchema>;

export const ProjectScanSummarySchema = z.object({
  scanId: z.uuid(),
  projectId: z.uuid(),
  /** Mashinalar bo'ylab guruh kaliti: `COALESCE(repo_key, project_id)`. */
  projectKey: z.string(),
  projectName: z.string(),
  machineId: z.uuid(),
  machineName: z.string(),
  scannedAt: IsoDate,
  counts: ScanCountsSchema,
  vulnCount: z.number().int(),
  outdatedCount: z.number().int(),
  secretCount: z.number().int(),
  envFileCount: z.number().int(),
  ecosystems: z.array(z.string()),
  /** Hech bo'lmaganda bitta asbob xato/timeout bergan. */
  partial: z.boolean(),
  trend: z.array(ScanTrendPointSchema),
});
export type ProjectScanSummary = z.infer<typeof ProjectScanSummarySchema>;

export const ScanListResponseSchema = z.object({
  projects: z.array(ProjectScanSummarySchema),
  settings: ScanSettingsSchema,
  /** Keyingi rejalashtirilgan yakshanba 06:00 (Toshkent) yoki `null` (o'chirilgan). */
  nextRunAt: IsoDate.nullable(),
  lastRunAt: IsoDate.nullable(),
});
export type ScanListResponse = z.infer<typeof ScanListResponseSchema>;

export const ScanDetailSchema = ProjectScanSummarySchema.extend({
  tools: z.array(ScanToolRunSchema),
  findings: z.array(ScanFindingSchema),
  findingsTotal: z.number().int(),
  truncated: z.boolean(),
  filesScanned: z.number().int(),
  durationMs: z.number().int(),
  commandId: z.uuid().nullable(),
});
export type ScanDetail = z.infer<typeof ScanDetailSchema>;

export const ScanHistoryResponseSchema = z.object({
  scans: z.array(
    z.object({
      scanId: z.uuid(),
      scannedAt: IsoDate,
      counts: ScanCountsSchema,
      vulnCount: z.number().int(),
      outdatedCount: z.number().int(),
      secretCount: z.number().int(),
      envFileCount: z.number().int(),
      partial: z.boolean(),
    }),
  ),
});
export type ScanHistoryResponse = z.infer<typeof ScanHistoryResponseSchema>;

export const PutScanSettingsBodySchema = ScanSettingsSchema.strict();
export type PutScanSettingsBody = z.infer<typeof PutScanSettingsBodySchema>;

/** `errorCode`/`errorMessage`: buyruq darhol rad etilgan bo'lsa (`machine_offline`, `agent_outdated`, `action_not_allowed`, `budget_exceeded` ...). */
export const RunScanResponseSchema = z.object({ commandId: z.uuid(), status: z.string(), errorCode: z.string().nullable().optional(), errorMessage: z.string().nullable().optional() });
export type RunScanResponse = z.infer<typeof RunScanResponseSchema>;

// --- "Claude tuzatsin" prompti (sof; dashboard va Telegram umumiy) ------------------------------------

/** "Claude tuzatsin": yangi sessiya modali shu rejim bilan ochiladi (har qanday o'zgartirish alohida ruxsat bilan). */
export const SCAN_FIX_PERMISSION_MODE = 'plan' as const;

const safeText = (s: string, max: number): string => s.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim().slice(0, max);

/** Tuzatish branch nomi: `fix/security-YYYYMMDD` (kun Toshkent bo'yicha chaqiruvchida beriladi). */
export const scanFixBranch = (day: string): string => `fix/security-${day.replace(/[^0-9]/g, '').slice(0, 8) || 'scan'}`;

/**
 * Tuzatish prompti: faqat paket/versiya/advisory/fayl+qator+qoida (qiymat YO'Q: sirlarning o'zi hech qachon markazda emas).
 * Rejim `plan`: Claude avval reja beradi, o'zgartirishlar ruxsat bilan.
 */
export function buildScanFixPrompt(input: { projectName: string; day: string; findings: readonly ScanFinding[] }): string {
  const branch = scanFixBranch(input.day);
  const vulns = input.findings.filter((f) => f.kind === 'vulnerability');
  const secrets = input.findings.filter((f) => f.kind === 'secret' || f.kind === 'env_file');
  const outdated = input.findings.filter((f) => f.kind === 'outdated');
  const lines: string[] = [
    `"${safeText(input.projectName, 80)}" loyihasida xavfsizlik tekshiruvi (${input.day}) quyidagilarni topdi. Avval tahlil qilib REJA bering, keyin tuzating.`,
    '',
    `Qoidalar: yangi branch oching (\`${branch}\`), main/master'ga to'g'ridan-to'g'ri yozmang; har bir o'zgarishdan keyin testlarni ishga tushiring; sir qiymatlarini hech qayerga (chat, commit, log) yozmang.`,
  ];
  if (vulns.length > 0) {
    lines.push('', 'Zaif dependency\'lar:');
    for (const f of vulns.slice(0, 25)) {
      const ids = f.advisoryIds.length > 0 ? ` [${f.advisoryIds.slice(0, 3).join(', ')}]` : '';
      const fix = f.fixVersion ? ` -> ${safeText(f.fixVersion, 40)}` : ' (tuzatish versiyasi noma\'lum)';
      lines.push(`- ${f.severity.toUpperCase()} ${safeText(f.package ?? '?', 80)}@${safeText(f.version ?? '?', 40)}${fix}${ids}: ${safeText(f.title, 100)}`);
    }
  }
  if (secrets.length > 0) {
    lines.push('', 'Commit qilingan sirlar (qiymat ko\'rsatilmaydi, faqat joyi):');
    for (const f of secrets.slice(0, 25)) lines.push(`- ${safeText(f.file ?? '?', 120)}${f.line ? `:${f.line}` : ''} (${safeText(f.rule ?? f.kind, 40)})`);
    lines.push('Har biri uchun: kodni muhit o\'zgaruvchisiga o\'tkazing, kalit AYLANTIRILISHI kerakligini (rotate) alohida belgilang, `.gitignore`ni tuzating.');
  }
  if (outdated.length > 0) {
    lines.push('', `Eskirgan dependency'lar (${outdated.length} ta; faqat xavfsiz minor/patch yangilashlar, major'ni alohida taklif qiling):`);
    for (const f of outdated.slice(0, 10)) lines.push(`- ${safeText(f.package ?? '?', 80)} ${safeText(f.version ?? '?', 30)} -> ${safeText(f.fixVersion ?? '?', 30)}`);
  }
  return lines.join('\n').slice(0, SCAN_LIMITS.fixPromptMaxChars);
}

/** Telegram dayjest uchun: kritik/yuqori sonlari bo'yicha "e'tibor kerakmi". */
export const scanNeedsAttention = (c: ScanCounts, secretCount: number): boolean => c.critical > 0 || c.high > 0 || secretCount > 0;
