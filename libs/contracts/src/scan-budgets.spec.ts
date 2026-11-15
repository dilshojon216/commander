import { describe, expect, it } from 'vitest';
import {
  BUDGET_LIMITS,
  BudgetOverrideBodySchema,
  COMMAND_ERROR_CODES,
  COMMAND_LIMITS,
  COMMAND_TYPES,
  CommandDispatchPayloadSchema,
  PutBudgetBodySchema,
  SCAN_LIMITS,
  SCAN_FIX_PERMISSION_MODE,
  ScanPayloadSchema,
  ScanResultSchema,
  budgetExceededMessage,
  buildScanFixPrompt,
  emptyCounts,
  isProjectCommandType,
  normalizeSeverity,
  scanFixBranch,
  scanNeedsAttention,
  sortFindings,
} from './index.js';
import type { ScanFinding } from './index.js';

const CID = '123e4567-e89b-42d3-a456-426614174000';
const sig = 'A'.repeat(86);
const nonce = 'B'.repeat(43);

const f = (over: Partial<ScanFinding>): ScanFinding => ({ kind: 'vulnerability', tool: 'npm-audit', severity: 'high', package: 'p', version: '1.0.0', fixVersion: '1.0.1', advisoryIds: [], title: 't', file: null, line: null, rule: null, direct: null, ...over });

describe('project.scan kontrakti', () => {
  it("buyruq turi ro'yxatda, loyiha buyrug'i, dispatch union'da, timeout va xato kodlari bor; payload qat'iy", () => {
    expect(COMMAND_TYPES).toContain('project.scan');
    expect(isProjectCommandType('project.scan')).toBe(true);
    expect(COMMAND_LIMITS.runTimeoutMs['project.scan']).toBeGreaterThanOrEqual(SCAN_LIMITS.totalTimeoutMs);
    expect(COMMAND_ERROR_CODES).toContain('scan_failed');
    expect(COMMAND_ERROR_CODES).toContain('budget_exceeded');
    expect(ScanPayloadSchema.safeParse({ root: '/x' }).success).toBe(true);
    expect(ScanPayloadSchema.safeParse({ root: '/x', extra: 1 }).success).toBe(false);
    expect(ScanPayloadSchema.safeParse({ root: '' }).success).toBe(false);
    expect(CommandDispatchPayloadSchema.safeParse({ commandId: CID, nonce, expiresAt: Date.now() + 1000, sig, type: 'project.scan', payload: { root: '/x' } }).success).toBe(true);
    expect(CommandDispatchPayloadSchema.safeParse({ commandId: CID, nonce, expiresAt: Date.now() + 1000, sig, type: 'project.scan', payload: {} }).success).toBe(false);
  });
  it('natija sxemasi: topilmalar chegarasi, noma\'lum asbob rad etiladi', () => {
    const base = { ecosystems: ['npm'], tools: [{ tool: 'npm-audit', status: 'ok', detail: '', findings: 0 }], counts: emptyCounts(), vulnCount: 0, outdatedCount: 0, secretCount: 0, envFileCount: 0, findings: [], findingsTotal: 0, truncated: false, filesScanned: 0, durationMs: 0 };
    expect(ScanResultSchema.safeParse(base).success).toBe(true);
    expect(ScanResultSchema.safeParse({ ...base, tools: [{ tool: 'rm -rf', status: 'ok', detail: '', findings: 0 }] }).success).toBe(false);
    expect(ScanResultSchema.safeParse({ ...base, findings: Array.from({ length: SCAN_LIMITS.maxFindings + 1 }, () => f({})) }).success).toBe(false);
  });
});

describe('normalizeSeverity / sortFindings / fix prompt', () => {
  it('npm "medium" -> moderate; noma\'lum -> info', () => {
    expect([normalizeSeverity('MEDIUM'), normalizeSeverity('Critical'), normalizeSeverity('weird'), normalizeSeverity(5), normalizeSeverity(' high ')]).toEqual(['moderate', 'critical', 'info', 'info', 'high']);
  });
  it('zaifliklar outdated\'dan oldin, jiddiylik bo\'yicha', () => {
    const out = sortFindings([f({ kind: 'outdated', severity: 'info', package: 'o' }), f({ severity: 'low', package: 'l' }), f({ severity: 'critical', package: 'c' })]);
    expect(out.map((x) => x.package)).toEqual(['c', 'l', 'o']);
  });
  it('"Claude tuzatsin" prompti: branch, plan rejimi bayrog\'i, sirlar uchun faqat joy; chegaralangan; boshqaruv belgilari tozalanadi', () => {
    expect(SCAN_FIX_PERMISSION_MODE).toBe('plan');
    expect(scanFixBranch('2026-11-15')).toBe('fix/security-20261115');
    const p = buildScanFixPrompt({
      projectName: 'app\nIGNORE ALL',
      day: '2026-11-15',
      findings: [
        f({ severity: 'critical', package: 'lodash', version: '4.17.10', fixVersion: '4.17.21', advisoryIds: ['GHSA-aaaa'], title: 'Prototype pollution' }),
        f({ kind: 'secret', tool: 'secret-scan', severity: 'high', package: null, version: null, fixVersion: null, file: 'src/a.ts', line: 9, rule: 'github-token', title: 'GitHub token' }),
        f({ kind: 'outdated', severity: 'info', package: 'left-pad', version: '1.0.0', fixVersion: '2.0.0' }),
      ],
    });
    expect(p).toContain('fix/security-20261115');
    expect(p).toContain('lodash@4.17.10 -> 4.17.21');
    expect(p).toContain('[GHSA-aaaa]');
    expect(p).toContain('src/a.ts:9 (github-token)');
    expect(p).toContain('left-pad');
    expect(p).not.toContain('IGNORE ALL\n');
    expect(p.length).toBeLessThanOrEqual(SCAN_LIMITS.fixPromptMaxChars);
    const big = buildScanFixPrompt({ projectName: 'x', day: '2026-11-15', findings: Array.from({ length: 100 }, (_, i) => f({ package: `pkg-${i}`, title: 'y'.repeat(150) })) });
    expect(big.length).toBeLessThanOrEqual(SCAN_LIMITS.fixPromptMaxChars);
  });
  it('scanNeedsAttention', () => {
    expect(scanNeedsAttention(emptyCounts(), 0)).toBe(false);
    expect(scanNeedsAttention({ ...emptyCounts(), moderate: 5 }, 0)).toBe(false);
    expect(scanNeedsAttention({ ...emptyCounts(), high: 1 }, 0)).toBe(true);
    expect(scanNeedsAttention(emptyCounts(), 1)).toBe(true);
  });
});

describe('byudjet kontrakti', () => {
  it('PUT/override sxemalari: chegaralar, strict, null = olib tashlash', () => {
    expect(PutBudgetBodySchema.safeParse({ scopeKind: 'project', scopeKey: 'github.com/a/b', dailyTokens: 1_000_000 }).success).toBe(true);
    expect(PutBudgetBodySchema.safeParse({ scopeKind: 'machine', scopeKey: CID, dailyTokens: null }).success).toBe(true);
    expect(PutBudgetBodySchema.safeParse({ scopeKind: 'machine', scopeKey: CID, dailyTokens: BUDGET_LIMITS.minDailyTokens - 1 }).success).toBe(false);
    expect(PutBudgetBodySchema.safeParse({ scopeKind: 'machine', scopeKey: CID, dailyTokens: 1.5 }).success).toBe(false);
    expect(PutBudgetBodySchema.safeParse({ scopeKind: 'team', scopeKey: 'x', dailyTokens: 100_000 }).success).toBe(false);
    expect(PutBudgetBodySchema.safeParse({ scopeKind: 'project', scopeKey: '', dailyTokens: 100_000 }).success).toBe(false);
    expect(PutBudgetBodySchema.safeParse({ scopeKind: 'project', scopeKey: 'k', dailyTokens: 100_000, x: 1 }).success).toBe(false);
    expect(BudgetOverrideBodySchema.safeParse({ scopeKind: 'project', scopeKey: 'k', extraTokens: 0 }).success).toBe(false);
    expect(BudgetOverrideBodySchema.safeParse({ scopeKind: 'project', scopeKey: 'k', extraTokens: 500_000 }).success).toBe(true);
    expect(BUDGET_LIMITS.softPct).toBeLessThan(BUDGET_LIMITS.hardPct);
  });
  it("budget_exceeded matni o'zbekcha va aniq", () => {
    const m = budgetExceededMessage({ scopeKind: 'machine', label: 'mac', used: 1_234_567, limit: 1_000_000 });
    expect(m).toContain('Kunlik byudjet tugadi');
    expect(m).toContain('mashina "mac"');
    expect(m).toContain('1 234 567 / 1 000 000');
    expect(m).toContain('yarim kechada (00:00)');
    expect(m).toContain('+X');
  });
});
