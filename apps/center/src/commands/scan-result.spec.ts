import { describe, expect, it } from 'vitest';
import type { ScanFinding, ScanResult } from '@commander/contracts';
import { countsOf, handleScanResult, sanitizeScan } from './scan-result.js';

const SECRET = `ghp_${'Z'.repeat(30)}`;
const finding = (over: Partial<ScanFinding>): ScanFinding => ({ kind: 'vulnerability', tool: 'npm-audit', severity: 'high', package: 'p', version: '1.0.0', fixVersion: '1.0.1', advisoryIds: ['GHSA-1'], title: 't', file: null, line: null, rule: null, direct: true, ...over });
const result = (findings: ScanFinding[]): ScanResult => ({
  ecosystems: ['npm'], tools: [{ tool: 'npm-audit', status: 'ok', detail: `token=${SECRET}`, findings: 1 }], counts: { critical: 0, high: 1, moderate: 0, low: 0, info: 0 },
  vulnCount: 1, outdatedCount: 0, secretCount: 0, envFileCount: 0, findings, findingsTotal: findings.length, truncated: false, filesScanned: 1, durationMs: 1,
});

describe('sanitizeScan (markaz xavfsizlik to\'ri)', () => {
  it('sir topilmalarida paket/versiya majburan bo\'sh; matnlar qayta redakt qilinadi; tartib jiddiylik bo\'yicha', () => {
    const out = sanitizeScan(
      result([
        finding({ severity: 'low', package: 'zz' }),
        finding({ kind: 'secret', tool: 'secret-scan', severity: 'high', package: SECRET, version: SECRET, fixVersion: SECRET, title: `leaked ${SECRET}`, file: 'a.ts', line: 3, rule: 'github-token' }),
        finding({ severity: 'critical', package: 'aa', title: `x ${SECRET}` }),
      ]),
    );
    const json = JSON.stringify(out);
    expect(json).not.toContain(SECRET);
    expect(json).not.toContain('ZZZZZZZZZZ');
    expect(out.findings.map((f) => f.severity)).toEqual(['critical', 'high', 'low']);
    const sec = out.findings.find((f) => f.kind === 'secret')!;
    expect(sec).toMatchObject({ package: null, version: null, fixVersion: null, file: 'a.ts', line: 3, rule: 'github-token' });
  });
  it('countsOf: outdated hisoblanmaydi', () => {
    const c = countsOf([finding({ severity: 'critical' }), finding({ severity: 'high' }), finding({ kind: 'outdated', severity: 'info' }), finding({ kind: 'secret', severity: 'high' })]);
    expect(c).toEqual({ critical: 1, high: 2, moderate: 0, low: 0, info: 0 });
  });
});

describe('handleScanResult', () => {
  const fakeManager = () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    return { calls, query: async (sql: string, params: unknown[]) => (calls.push({ sql, params }), []) } as unknown as { calls: typeof calls; query: never };
  };
  it('loyihasiz buyruq va yaroqsiz natija rad etiladi (yozuv yo\'q)', async () => {
    const m = fakeManager();
    expect((await handleScanResult(m as never, { commandId: 'c', projectId: null, machineId: 'm', result: undefined })).error?.code).toBe('invalid_result');
    expect((await handleScanResult(m as never, { commandId: 'c', projectId: 'p', machineId: 'm', result: { scan: { x: 1 } } })).error?.code).toBe('invalid_result');
    expect(m.calls).toHaveLength(0);
  });
  it('to\'g\'ri natija: INSERT + tozalash; commands.result faqat qisqa izoh; sir qiymati so\'rov parametrlarida yo\'q', async () => {
    const m = fakeManager();
    const out = await handleScanResult(m as never, { commandId: '123e4567-e89b-42d3-a456-426614174000', projectId: 'p', machineId: 'm', result: { scan: result([finding({ title: `t ${SECRET}` })]) } });
    expect(out.error).toBeUndefined();
    expect(out.result?.detail).toContain('1 vuln');
    expect(m.calls).toHaveLength(2);
    expect(m.calls[0]!.sql).toContain('INSERT INTO project_scans');
    expect(m.calls[1]!.sql).toContain('DELETE FROM project_scans');
    expect(JSON.stringify(m.calls)).not.toContain(SECRET);
  });
});
