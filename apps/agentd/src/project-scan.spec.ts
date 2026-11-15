import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ScanResultSchema } from '@commander/contracts';
import { createLogger } from './logger.js';
import { ProjectScan } from './project-scan.js';
import type { ExecResult, ScanExec } from './project-scan.js';

const log = createLogger({ write: () => undefined });
const fx = (n: string): string => readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'scan', n), 'utf8');
const FAKE_GH = 'ghp_' + 'Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0Pp9Oo8';
const res = (p: Partial<ExecResult> = {}): ExecResult => ({ code: 0, stdout: '', stderr: '', missing: false, timedOut: false, ...p });

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'cmdr-scan-')));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function project(files: Record<string, string>): void {
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), c);
  }
}

describe('ProjectScan', () => {
  it('npm + sirlar + env fayl: normallashtirilgan natija, qiymat HECH QAYERDA yo\'q', async () => {
    project({
      'package.json': '{}',
      'package-lock.json': '{}',
      'src/a.ts': `export const t = "${FAKE_GH}";\n`,
      '.env': `TOKEN=${FAKE_GH}\n`,
      '.env.example': 'TOKEN=\n',
    });
    const calls: string[][] = [];
    const exec: ScanExec = async (bin, args) => {
      calls.push([path.basename(bin), ...args]);
      if (bin.endsWith('npm')) return res({ code: 1, stdout: fx('npm-audit-v7.json') });
      return res({ missing: true });
    };
    const s = new ProjectScan({ log, exec, resolveBin: (n) => (n === 'npm' ? '/x/npm' : undefined) });
    const out = await s.scan(dir);
    expect(out.ok).toBe(true);
    const scan = ScanResultSchema.parse(out.result!.scan);
    expect(scan.ecosystems).toEqual(['npm']);
    expect(scan.vulnCount).toBe(3);
    expect(scan.secretCount).toBe(1);
    expect(scan.envFileCount).toBe(1);
    expect(scan.counts.critical).toBe(1);
    expect(scan.counts.high).toBe(1); // github-token
    expect(scan.findings[0]!.severity).toBe('critical');
    const sec = scan.findings.find((f) => f.kind === 'secret')!;
    expect(sec).toMatchObject({ file: 'src/a.ts', line: 1, rule: 'github-token' });
    expect(scan.findings.find((f) => f.kind === 'env_file')).toMatchObject({ file: '.env' });
    expect(JSON.stringify(out)).not.toContain(FAKE_GH);
    expect(scan.tools.find((t) => t.tool === 'npm-audit')).toMatchObject({ status: 'ok' });
    expect(out.result!.detail).toBe('3 vuln, 1 secrets, 1 env files, 0 outdated');
    // faqat o'qiydigan chaqiruv: lockfile yozmaydi, install/fix yo'q
    expect(calls[0]).toEqual(['npm', 'audit', '--json', '--package-lock-only']);
    expect(calls.flat().some((a) => ['install', 'fix', 'ci', 'update'].includes(a))).toBe(false);
  });

  it('asbob yo\'q = skipped; timeout = timeout; xato = failed; lock yo\'q = skipped', async () => {
    project({ 'package.json': '{}', 'go.mod': 'module x\n', 'pubspec.yaml': 'name: a\n', 'requirements.txt': 'django\n' });
    const exec: ScanExec = async (bin) => {
      if (bin.endsWith('go')) return res({ timedOut: true, code: null });
      if (bin.endsWith('dart')) return res({ code: 2, stderr: 'boom' });
      return res({ missing: true });
    };
    const s = new ProjectScan({ log, exec, resolveBin: (n) => (['go', 'dart'].includes(n) ? `/x/${n}` : undefined) });
    const r = ScanResultSchema.parse((await s.scan(dir)).result!.scan);
    const st = (t: string): string | undefined => r.tools.find((x) => x.tool === t)?.status;
    expect(st('npm-audit')).toBe('skipped'); // package-lock.json yo'q
    expect(st('go-list-u')).toBe('timeout');
    expect(st('govulncheck')).toBe('skipped');
    expect(st('dart-outdated')).toBe('failed');
    expect(st('pip-audit')).toBe('skipped');
    expect(r.ecosystems).toEqual(['npm', 'python', 'dart', 'go']);
  });

  it('dart outdated va flutter aniqlash; outdated jiddiylik hisobiga kirmaydi', async () => {
    project({ 'pubspec.yaml': 'name: a\ndependencies:\n  flutter:\n    sdk: flutter\n' });
    const s = new ProjectScan({ log, exec: async () => res({ stdout: fx('pub-outdated.json') }), resolveBin: (n) => `/x/${n}` });
    const r = ScanResultSchema.parse((await s.scan(dir)).result!.scan);
    expect(r.ecosystems).toEqual(['flutter']);
    expect(r.outdatedCount).toBe(2);
    expect(r.counts).toEqual({ critical: 0, high: 0, moderate: 0, low: 0, info: 0 });
  });

  it('topilmalar maxFindings ga kesiladi, findingsTotal saqlanadi', async () => {
    project({ 'package.json': '{}', 'package-lock.json': '{}' });
    const vulns: Record<string, unknown> = {};
    for (let i = 0; i < 260; i++) vulns[`p${i}`] = { name: `p${i}`, severity: 'low', via: [{ title: 't' }], fixAvailable: false };
    const s = new ProjectScan({ log, exec: async () => res({ code: 1, stdout: JSON.stringify({ vulnerabilities: vulns }) }), resolveBin: () => '/x/npm' });
    const r = ScanResultSchema.parse((await s.scan(dir)).result!.scan);
    expect(r.findings).toHaveLength(200);
    expect(r.findingsTotal).toBe(260);
    expect(r.truncated).toBe(true);
  });
  it('ildiz $HOME bo\'lganda maxfiy papkalar (.ssh, .claude, .aws, .commander) yurilmaydi va skanerlanmaydi', async () => {
    project({
      'package.json': '{}',
      'src/a.ts': 'export const x = 1;\n',
      '.ssh/leak.txt': `t = "${FAKE_GH}"\n`,
      '.claude/leak.txt': `t = "${FAKE_GH}"\n`,
      '.aws/leak.txt': `t = "${FAKE_GH}"\n`,
      '.commander/leak.txt': `t = "${FAKE_GH}"\n`,
      '.config/commander/leak.txt': `t = "${FAKE_GH}"\n`,
      '.config/other/ok.txt': `t = "${FAKE_GH}"\n`,
    });
    const sensitive = ['.ssh', '.claude', '.aws', '.commander', '.config/commander'].map((d) => path.join(dir, d));
    const exec: ScanExec = async () => res({ missing: true });
    const s = new ProjectScan({ log, exec, resolveBin: () => undefined, sensitive });
    const out = await s.scan(dir);
    const scan = ScanResultSchema.parse(out.result!.scan);
    const files = scan.findings.filter((f) => f.kind === 'secret').map((f) => f.file);
    expect(files).toEqual(['.config/other/ok.txt']);
  });
});
