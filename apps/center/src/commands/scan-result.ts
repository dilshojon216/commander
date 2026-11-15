import type { EntityManager } from 'typeorm';
import { SCAN_LIMITS, ScanResultSchema, emptyCounts, sortFindings } from '@commander/contracts';
import type { CommandResultData, ScanFinding, ScanResult } from '@commander/contracts';
import { redactAndCap } from '../common/redact-text.js';

export interface ScanResultCtx {
  commandId: string;
  projectId: string | null;
  machineId: string;
  result: CommandResultData | undefined;
}

export interface ScanResultOutcome {
  result?: CommandResultData;
  error?: { code: string; message: string };
}

const cap = (s: string | null, n: number): string | null => (s === null ? null : redactAndCap(s, n));

/**
 * Markaz tomonidagi XAVFSIZLIK TO'RI (agentd redakt qilgan bo'lsa ham): matnlar qayta redakt qilinadi va cheklanadi; sir/env-fayl
 * topilmalarida paket/versiya maydonlari bo'sh majburlanadi va `title` ham redakt qilinadi (qiymat bo'lishi mumkin emas, lekin
 * eskirgan/xato agentd bo'lsa ham DB'ga tushmasin). Hisoblar (`counts`...) qayta hisoblanadi: agentd'ga ishonilmaydi.
 */
export function sanitizeScan(r: ScanResult): ScanResult {
  const findings: ScanFinding[] = sortFindings(
    r.findings.map((f): ScanFinding => {
      const secretLike = f.kind === 'secret' || f.kind === 'env_file';
      return {
        ...f,
        package: secretLike ? null : cap(f.package, SCAN_LIMITS.packageMaxChars),
        version: secretLike ? null : cap(f.version, SCAN_LIMITS.versionMaxChars),
        fixVersion: secretLike ? null : cap(f.fixVersion, SCAN_LIMITS.versionMaxChars),
        advisoryIds: f.advisoryIds.slice(0, SCAN_LIMITS.maxAdvisoryIds).map((a) => redactAndCap(a, 64)),
        title: redactAndCap(f.title, SCAN_LIMITS.titleMaxChars),
        file: cap(f.file, SCAN_LIMITS.pathMaxChars),
        rule: cap(f.rule, SCAN_LIMITS.ruleMaxChars),
      };
    }),
  ).slice(0, SCAN_LIMITS.maxFindings);
  return {
    ...r,
    tools: r.tools.map((t) => ({ ...t, detail: redactAndCap(t.detail, SCAN_LIMITS.detailMaxChars) })),
    findings,
  };
}

/** Zaiflik/sir topilmalari bo'yicha jiddiylik hisoblari (eskirgan dependency'lar hisobga olinmaydi: `outdatedCount`da). */
export function countsOf(findings: readonly ScanFinding[]): ScanResult['counts'] {
  const c = emptyCounts();
  for (const f of findings) if (f.kind !== 'outdated') c[f.severity]++;
  return c;
}

/**
 * `project.scan` natijasi (6.10), `handleResult` tranzaksiyasi ichida: sxema bo'yicha tekshiriladi, sanitizatsiya qilinadi,
 * `project_scans` ga yoziladi, loyiha bo'yicha eskilari tozalanadi. `commands.result`ga faqat qisqa izoh tushadi.
 */
export async function handleScanResult(m: EntityManager, ctx: ScanResultCtx): Promise<ScanResultOutcome> {
  if (!ctx.projectId) return { error: { code: 'invalid_result', message: 'The command has no project' } };
  const parsed = ScanResultSchema.safeParse(ctx.result?.scan);
  if (!parsed.success) return { error: { code: 'invalid_result', message: 'The agent returned an invalid scan result' } };
  const r = sanitizeScan(parsed.data);
  const partial = r.tools.some((t) => t.status === 'failed' || t.status === 'timeout');
  // Hisoblar kesilgan ro'yxatdan emas: agent bergan jami (`counts`) saqlanadi, lekin ro'yxatdan kam bo'lmasin
  const fromList = countsOf(r.findings);
  const counts = {
    critical: Math.max(r.counts.critical, fromList.critical),
    high: Math.max(r.counts.high, fromList.high),
    moderate: Math.max(r.counts.moderate, fromList.moderate),
    low: Math.max(r.counts.low, fromList.low),
    info: Math.max(r.counts.info, fromList.info),
  };
  await m.query(
    `INSERT INTO project_scans (project_id, machine_id, command_id, counts, vuln_count, outdated_count, secret_count, env_file_count, ecosystems, tools, findings,
                                findings_total, truncated, files_scanned, duration_ms, partial)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9::text[], $10::jsonb, $11::jsonb, $12, $13, $14, $15, $16)
     ON CONFLICT (command_id) WHERE command_id IS NOT NULL DO NOTHING`,
    [
      ctx.projectId,
      ctx.machineId,
      ctx.commandId,
      JSON.stringify(counts),
      r.vulnCount,
      r.outdatedCount,
      r.secretCount,
      r.envFileCount,
      r.ecosystems,
      JSON.stringify(r.tools),
      JSON.stringify(r.findings),
      r.findingsTotal,
      r.truncated,
      r.filesScanned,
      r.durationMs,
      partial,
    ],
  );
  await m.query(
    `DELETE FROM project_scans WHERE project_id = $1 AND id NOT IN (SELECT id FROM project_scans WHERE project_id = $1 ORDER BY scanned_at DESC LIMIT $2)`,
    [ctx.projectId, SCAN_LIMITS.keepPerProject],
  );
  const detail = `${r.vulnCount} vuln, ${r.secretCount} secret, ${r.outdatedCount} outdated${partial ? ', partial' : ''}`;
  return { result: { detail: detail.slice(0, 200) } };
}
