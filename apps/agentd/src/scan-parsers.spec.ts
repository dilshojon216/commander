import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ScanFindingSchema } from '@commander/contracts';
import { extractAdvisoryIds, parseConcatenatedJson, parseGoListUpdates, parseGovulncheck, parseNpmAudit, parsePipAudit, parsePubOutdated, parseAdvisoriesMap, parseYarnAudit } from './scan-parsers.js';

const fx = (n: string): string => readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'scan', n), 'utf8');
const valid = (list: unknown[]): void => {
  for (const f of list) expect(ScanFindingSchema.safeParse(f).success).toBe(true);
};

describe('scan parserlari (fixture)', () => {
  it('npm audit v7+: jiddiylik, tuzatish versiyasi, advisory id, medium -> moderate', () => {
    const f = parseNpmAudit(fx('npm-audit-v7.json'));
    valid(f);
    const lodash = f.find((x) => x.package === 'lodash')!;
    expect(lodash).toMatchObject({ severity: 'critical', fixVersion: '4.17.21', direct: true, version: '<4.17.12' });
    expect(lodash.advisoryIds).toEqual(['GHSA-jf85-cpcp-j695']);
    expect(f.find((x) => x.package === 'minimatch')).toMatchObject({ severity: 'moderate', fixVersion: null });
    const glob = f.find((x) => x.package === 'glob')!;
    expect(glob.severity).toBe('moderate');
    expect(glob.title).toContain('minimatch');
    expect(f).toHaveLength(3);
  });
  it('pnpm audit advisories: patched_versions "<0.0.0" = tuzatish yo\'q', () => {
    const f = parseAdvisoriesMap(fx('pnpm-audit.json'), 'pnpm-audit');
    valid(f);
    expect(f.find((x) => x.package === 'axios')).toMatchObject({ severity: 'high', version: '0.19.0', fixVersion: '0.21.1' });
    expect(f.find((x) => x.package === 'axios')!.advisoryIds).toEqual(expect.arrayContaining(['GHSA-4w2v-q235-vp99', 'CVE-2020-28168']));
    expect(f.find((x) => x.package === 'tar')!.fixVersion).toBeNull();
  });
  it('yarn klassik ndjson', () => {
    const f = parseYarnAudit(fx('yarn-classic.ndjson'));
    valid(f);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ package: 'ws', severity: 'high', version: '7.4.5', fixVersion: '7.4.6', tool: 'yarn-audit' });
  });
  it('yarn berry ndjson', () => {
    const line = JSON.stringify({ value: 'minimist', children: { ID: 'GHSA-xvch-5gv4-984h', Issue: 'Prototype Pollution', Severity: 'critical', 'Vulnerable Versions': '<1.2.6', 'Tree Versions': ['1.2.5'] } });
    const f = parseYarnAudit(line);
    expect(f[0]).toMatchObject({ package: 'minimist', severity: 'critical', version: '1.2.5', advisoryIds: ['GHSA-xvch-5gv4-984h'] });
  });
  it('pip-audit JSON', () => {
    const f = parsePipAudit(fx('pip-audit.json'));
    valid(f);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ package: 'django', version: '3.0.0', fixVersion: '3.0.14' });
    expect(f[0]!.advisoryIds).toEqual(expect.arrayContaining(['PYSEC-2021-9', 'CVE-2021-28658']));
  });
  it('dart pub outdated: faqat eskirgan va to\'xtatilgan', () => {
    const f = parsePubOutdated(fx('pub-outdated.json'), 'dart-outdated');
    valid(f);
    expect(f.map((x) => x.package).sort()).toEqual(['http', 'old_pkg']);
    expect(f.find((x) => x.package === 'http')).toMatchObject({ kind: 'outdated', severity: 'info', version: '0.13.0', fixVersion: '1.2.0', direct: true });
    expect(f.find((x) => x.package === 'old_pkg')!.severity).toBe('moderate');
  });
  it('go list -u -json oqimi: faqat Update bor, asosiy modul emas', () => {
    expect(parseConcatenatedJson(fx('go-list-u.json'))).toHaveLength(3);
    const f = parseGoListUpdates(fx('go-list-u.json'));
    valid(f);
    expect(f).toEqual([expect.objectContaining({ package: 'golang.org/x/text', version: 'v0.3.0', fixVersion: 'v0.14.0', direct: false })]);
  });
  it('govulncheck ndjson: chaqirilgan = high, chaqirilmagan = low; osv sarlavhasi', () => {
    const f = parseGovulncheck(fx('govulncheck.ndjson'));
    valid(f);
    const a = f.find((x) => x.advisoryIds.includes('GO-2021-0113'))!;
    expect(a).toMatchObject({ severity: 'high', fixVersion: 'v0.3.7', package: 'golang.org/x/text' });
    expect(a.advisoryIds).toEqual(expect.arrayContaining(['CVE-2021-38561', 'GHSA-ppp9-7jff-5vj2']));
    expect(f.find((x) => x.advisoryIds.includes('GO-2022-0001'))!.severity).toBe('low');
  });
  it('yaroqsiz/bo\'sh kirish exception bermaydi', () => {
    for (const bad of ['', 'not json', '{"vulnerabilities": 5}', '[]', 'null']) {
      expect(parseNpmAudit(bad)).toEqual([]);
      expect(parsePipAudit(bad)).toEqual([]);
      expect(parseYarnAudit(bad)).toEqual([]);
      expect(parseGovulncheck(bad)).toEqual([]);
    }
  });
  it('matnlar redakt qilinadi va cheklanadi', () => {
    const j = JSON.stringify({ vulnerabilities: { x: { name: 'x', severity: 'high', via: [{ title: `leak sk-ant-${'a'.repeat(30)} ${'z'.repeat(500)}`, url: '' }] } } });
    const f = parseNpmAudit(j);
    expect(f[0]!.title).not.toContain('sk-ant-aaaa');
    expect(f[0]!.title.length).toBeLessThanOrEqual(200);
  });
  it('advisory id ajratish', () => {
    expect(extractAdvisoryIds('https://github.com/advisories/GHSA-JF85-CPCP-J695 and cve-2020-1234')).toEqual(['GHSA-jf85-cpcp-j695', 'CVE-2020-1234']);
  });
});
