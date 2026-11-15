import { describe, expect, it } from 'vitest';
import { THRESHOLDS, Streak, checkBackup, checkDbDisk, checkProbe, checkRuntime, checkTelegram, levelWithHysteresis, planCenterIncidents, worstStatus } from './center-checks.js';
import type { CheckResult } from './center-checks.js';

const H = 3_600_000;
const GB = 1024 ** 3;

describe('levelWithHysteresis', () => {
  it('opens above warn, escalates at critical, closes only 2 points below', () => {
    expect(levelWithHysteresis(80, 80, 90, 2, 'ok')).toBe('ok'); // "> 80"
    expect(levelWithHysteresis(80.5, 80, 90, 2, 'ok')).toBe('warn');
    expect(levelWithHysteresis(90, 80, 90, 2, 'warn')).toBe('critical');
    expect(levelWithHysteresis(79, 80, 90, 2, 'warn')).toBe('warn'); // miltillamasin
    expect(levelWithHysteresis(77.9, 80, 90, 2, 'warn')).toBe('ok');
    expect(levelWithHysteresis(89, 80, 90, 2, 'critical')).toBe('critical');
    expect(levelWithHysteresis(87.9, 80, 90, 2, 'critical')).toBe('warn');
  });
});

describe('checkDbDisk', () => {
  const base = { freeBytes: 20 * GB, totalBytes: 100 * GB, dbBytes: 3 * GB };
  it('80% is fine, 85% warns, 95% is critical, unmeasurable is unknown (never opens/closes incidents)', () => {
    expect(checkDbDisk({ ...base, usedPct: 80, prev: 'ok' }).status).toBe('ok');
    const warn = checkDbDisk({ ...base, usedPct: 85, prev: 'ok' });
    expect(warn.status).toBe('warn');
    expect(warn.summary).toContain('85%');
    expect(warn.metrics['usedPct']).toBe(85);
    expect(checkDbDisk({ ...base, usedPct: 95, prev: 'warn' }).status).toBe('critical');
    expect(checkDbDisk({ ...base, usedPct: null, prev: 'ok' }).status).toBe('unknown');
  });
});

describe('checkBackup', () => {
  const now = 10 * 24 * H;
  it('ok within 26h, warn after 26h, critical after 50h', () => {
    expect(checkBackup({ lastSuccessMs: now - 25 * H, nowMs: now, uptimeMs: 100 * H }).status).toBe('ok');
    expect(checkBackup({ lastSuccessMs: now - 27 * H, nowMs: now, uptimeMs: 100 * H }).status).toBe('warn');
    expect(checkBackup({ lastSuccessMs: now - 51 * H, nowMs: now, uptimeMs: 100 * H }).status).toBe('critical');
  });
  it('no heartbeat ever: unknown right after start, warn once uptime exceeds the window', () => {
    expect(checkBackup({ lastSuccessMs: null, nowMs: now, uptimeMs: 2 * H }).status).toBe('unknown');
    expect(checkBackup({ lastSuccessMs: null, nowMs: now, uptimeMs: 27 * H }).status).toBe('warn');
  });
  it('a future timestamp (clock skew) does not produce a negative age', () => {
    expect(checkBackup({ lastSuccessMs: now + H, nowMs: now, uptimeMs: 100 * H }).metrics['ageHours']).toBe(0);
  });
});

describe('checkProbe (dashboard / tailscale)', () => {
  it('needs consecutive failures; disabled and unknown are neutral', () => {
    expect(checkProbe('dashboard', { configured: false, reachable: null, failStreak: 0 }, 'Dashboard').status).toBe('disabled');
    expect(checkProbe('dashboard', { configured: true, reachable: null, failStreak: 0 }, 'Dashboard').status).toBe('unknown');
    expect(checkProbe('dashboard', { configured: true, reachable: true, failStreak: 0 }, 'Dashboard').status).toBe('ok');
    expect(checkProbe('dashboard', { configured: true, reachable: false, failStreak: 1 }, 'Dashboard').status).toBe('ok'); // bitta xato: kutiladi
    const down = checkProbe('tailscale', { configured: true, reachable: false, failStreak: THRESHOLDS.probeFailTicks }, 'Tailscale serve');
    expect(down.status).toBe('critical');
    expect(down.summary).toContain('Tailscale serve');
  });
});

describe('checkRuntime', () => {
  const calm = { lagP99Ms: 20, rssBytes: 200 * 1024 ** 2, heapUsedPct: 30, lagStreak: 0 };
  it('is ok when calm', () => expect(checkRuntime(calm).status).toBe('ok'));
  it('event-loop lag counts only when sustained', () => {
    expect(checkRuntime({ ...calm, lagP99Ms: 900, lagStreak: 1 }).status).toBe('ok');
    expect(checkRuntime({ ...calm, lagP99Ms: 900, lagStreak: 2 }).status).toBe('warn');
    expect(checkRuntime({ ...calm, lagP99Ms: 3000, lagStreak: 3 }).status).toBe('critical');
  });
  it('memory thresholds apply immediately', () => {
    expect(checkRuntime({ ...calm, rssBytes: 2 * GB }).status).toBe('warn');
    expect(checkRuntime({ ...calm, rssBytes: 4 * GB }).status).toBe('critical');
    expect(checkRuntime({ ...calm, heapUsedPct: 90 }).status).toBe('warn');
    expect(checkRuntime({ ...calm, heapUsedPct: 97 }).status).toBe('critical');
  });
});

describe('checkTelegram', () => {
  const now = 1_000_000_000;
  it('disabled when polling is off; ok while polls succeed; critical when stuck', () => {
    expect(checkTelegram({ enabled: false, startedAt: null, lastOkAt: null, nowMs: now }).status).toBe('disabled');
    expect(checkTelegram({ enabled: true, startedAt: now - 500_000, lastOkAt: now - 20_000, nowMs: now }).status).toBe('ok');
    expect(checkTelegram({ enabled: true, startedAt: now - 500_000, lastOkAt: now - 300_000, nowMs: now }).status).toBe('critical');
    // Hech qachon muvaffaqiyatli poll bo'lmagan: boshlanishidan hisoblanadi
    expect(checkTelegram({ enabled: true, startedAt: now - 60_000, lastOkAt: null, nowMs: now }).status).toBe('ok');
    expect(checkTelegram({ enabled: true, startedAt: now - 200_000, lastOkAt: null, nowMs: now }).status).toBe('critical');
  });
});

describe('Streak', () => {
  it('counts consecutive bad ticks and resets on a good one', () => {
    const s = new Streak();
    expect([s.push(true), s.push(true), s.push(false), s.push(true)]).toEqual([1, 2, 0, 1]);
  });
});

const r = (kind: CheckResult['kind'], status: CheckResult['status'], summary = kind): CheckResult => ({ kind, status, summary, metrics: {} });

describe('planCenterIncidents', () => {
  it('opens once, escalates, downgrades silently and resolves only on a real ok', () => {
    let p = planCenterIncidents([], [r('db_disk', 'warn'), r('backup', 'ok')]);
    expect(p.open.map((d) => d.kind)).toEqual(['db_disk']);
    expect(p.resolve).toEqual([]);

    p = planCenterIncidents([{ id: '1', kind: 'db_disk', severity: 'warn' }], [r('db_disk', 'warn')]);
    expect(p.open).toEqual([]);
    expect(p.refresh).toHaveLength(1); // matn yangilanadi, xabar yo'q

    p = planCenterIncidents([{ id: '1', kind: 'db_disk', severity: 'warn' }], [r('db_disk', 'critical')]);
    expect(p.escalate).toHaveLength(1);
    p = planCenterIncidents([{ id: '1', kind: 'db_disk', severity: 'critical' }], [r('db_disk', 'warn')]);
    expect(p.downgrade).toHaveLength(1);

    p = planCenterIncidents([{ id: '1', kind: 'db_disk', severity: 'warn' }], [r('db_disk', 'ok')]);
    expect(p.resolve.map((o) => o.id)).toEqual(['1']);
  });

  it('unknown / disabled / unmeasured kinds never resolve an open incident', () => {
    const open = [
      { id: 'a', kind: 'db_disk' as const, severity: 'warn' as const },
      { id: 'b', kind: 'dashboard' as const, severity: 'critical' as const },
      { id: 'c', kind: 'telegram' as const, severity: 'critical' as const },
    ];
    const p = planCenterIncidents(open, [r('db_disk', 'unknown'), r('dashboard', 'disabled')]);
    expect(p.resolve).toEqual([]);
    expect(p.open).toEqual([]);
  });
});

describe('worstStatus', () => {
  it('ignores unknown/disabled', () => {
    expect(worstStatus([r('db_disk', 'unknown'), r('backup', 'disabled')])).toBe('ok');
    expect(worstStatus([r('db_disk', 'warn'), r('backup', 'ok')])).toBe('warn');
    expect(worstStatus([r('db_disk', 'warn'), r('backup', 'critical')])).toBe('critical');
  });
});

describe('checkRuntime: host signer (5.7, H-02)', () => {
  const calm = { lagP99Ms: 5, rssBytes: 200 * 1024 ** 2, heapUsedPct: 30, lagStreak: 0 };
  const up = { mode: 'signer' as const, reachable: true, locked: false, keyPresent: true, failStreak: 0 };
  it('file mode (no signer configured) never affects the check', () => {
    expect(checkRuntime({ ...calm, signer: { ...up, mode: 'file', reachable: false, failStreak: 9 } }).status).toBe('ok');
  });
  it('reachable and unlocked is ok', () => expect(checkRuntime({ ...calm, signer: up }).status).toBe('ok'));
  it('one failed probe is tolerated, THRESHOLDS.probeFailTicks consecutive failures are critical (commands fail closed)', () => {
    expect(checkRuntime({ ...calm, signer: { ...up, reachable: false, failStreak: 1 } }).status).toBe('ok');
    const r = checkRuntime({ ...calm, signer: { ...up, reachable: false, failStreak: THRESHOLDS.probeFailTicks } });
    expect(r.status).toBe('critical');
    expect(r.summary).toContain('imzolovchiga yetib bo');
    expect(r.metrics['signerFailStreak']).toBe(THRESHOLDS.probeFailTicks);
  });
  it('missing key is critical, LOCK is warn', () => {
    expect(checkRuntime({ ...calm, signer: { ...up, keyPresent: false } }).status).toBe('critical');
    expect(checkRuntime({ ...calm, signer: { ...up, locked: true } }).status).toBe('warn');
  });
  it('combines with the other runtime signals (worst wins)', () => {
    expect(checkRuntime({ ...calm, lagP99Ms: 900, lagStreak: 2, signer: { ...up, locked: true } }).status).toBe('warn');
    expect(checkRuntime({ ...calm, lagP99Ms: 3000, lagStreak: 2, signer: { ...up, locked: true } }).status).toBe('critical');
  });
});
