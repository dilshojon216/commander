import { describe, expect, it } from 'vitest';
import type { ConfigStateReport } from '@commander/contracts';
import { computeConfigStatus } from './config-status.js';

const h = (c: string): string => c.repeat(64);
const latest = { version: 2, files: [{ path: 'CLAUDE.md', sha256: h('a') }, { path: 'agents/x.md', sha256: h('b') }], settingsSha256: h('c') };
const rep = (o: Partial<ConfigStateReport> = {}): ConfigStateReport => ({
  files: [{ path: 'CLAUDE.md', sha256: h('a') }, { path: 'agents/x.md', sha256: h('b') }],
  applied: { profileName: 'default', profileVersion: 2, mode: 'merge', appliedAt: 1_700_000_000_000 },
  settings: { sha256: h('c'), intact: true },
  backups: [],
  at: 1,
  ...o,
});

describe('computeConfigStatus', () => {
  it('unsupported / unknown / not_applied', () => {
    expect(computeConfigStatus({ supported: false, report: rep() }, latest).status).toBe('unsupported');
    expect(computeConfigStatus({ supported: true, report: null }, latest).status).toBe('unknown');
    expect(computeConfigStatus({ supported: true, report: rep({ applied: null, files: [], settings: null }) }, latest).status).toBe('not_applied');
  });
  it('in_sync', () => expect(computeConfigStatus({ supported: true, report: rep() }, latest).status).toBe('in_sync'));
  it('drift: eskirgan versiya, o\'zgargan, yo\'q fayl, bo\'lak', () => {
    const o = computeConfigStatus({ supported: true, report: rep({ applied: { profileName: 'default', profileVersion: 1, mode: 'merge', appliedAt: 1 } }) }, latest);
    expect(o).toMatchObject({ status: 'drift', drift: { outdated: true } });
    const m = computeConfigStatus({ supported: true, report: rep({ files: [{ path: 'CLAUDE.md', sha256: h('z') }, { path: 'agents/x.md', sha256: null }] }) }, latest);
    expect(m.drift).toMatchObject({ modified: ['CLAUDE.md'], missing: ['agents/x.md'], outdated: false });
    const s = computeConfigStatus({ supported: true, report: rep({ settings: { sha256: h('c'), intact: false } }) }, latest);
    expect(s.drift.settings).toBe(true);
    expect(computeConfigStatus({ supported: true, report: rep({ settings: null }) }, latest).drift.settings).toBe(true);
  });
  it('profilda bo\'lak yo\'q bo\'lsa bo\'lak drift bermaydi', () => {
    expect(computeConfigStatus({ supported: true, report: rep({ settings: null }) }, { ...latest, settingsSha256: null }).status).toBe('in_sync');
  });
});
