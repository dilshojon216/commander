import type { HealthSnapshot, HealthThresholds, IncidentKind, IncidentSeverity } from '@commander/contracts';
import { exitCodeOf, isBadContainer, keyNumbers } from './health-merge.js';

/** Bitta kutilgan holat (hodisa): kalit `kind|subject`. */
export interface Condition {
  kind: IncidentKind;
  subject: string;
  severity: IncidentSeverity;
  summary: string;
}

export const conditionKey = (kind: string, subject: string): string => `${kind}|${subject}`;

/** Disk uchun gisterezis: ochiq hodisa chegaradan shuncha punkt past tushgandagina yopiladi (miltillamasin). */
export const DISK_HYSTERESIS_PCT = 2;

/** Konteyner restart-loop'i uchun (konteyner nomi -> (vaqt, restartCount) namunalari). */
interface RestartSample {
  at: number;
  count: number;
}

/**
 * Mashina bo'yicha vaqtga bog'liq holat (xotirada): xotira/CPU "uzluksiz X daqiqa" va restart soni oynasi.
 * Center qayta ishga tushsa nol dan boshlanadi (kechikish bo'lishi mumkin, soxta ogohlantirish emas).
 */
export class MachineConditionTracker {
  private memSince: number | null = null;
  private cpuSince: number | null = null;
  private restarts = new Map<string, RestartSample[]>();

  /** Hodisalar hisobida bo'lmagan kalitlar (docker mavjud emas va h.k.) chaqiruvchi `evaluated` orqali boshqaradi. */
  evaluate(
    s: HealthSnapshot,
    t: HealthThresholds,
    now: number,
    openDisk: ReadonlyMap<string, IncidentSeverity>,
  ): { conditions: Condition[]; evaluated: Set<IncidentKind> } {
    const out: Condition[] = [];
    const evaluated = new Set<IncidentKind>(['memory', 'cpu']);
    const k = keyNumbers(s);

    // Disk (har mount alohida)
    evaluated.add('disk');
    for (const d of s.disks) {
      const was = openDisk.get(d.mount);
      const crit = d.pct >= t.diskCriticalPct || (was === 'critical' && d.pct >= t.diskCriticalPct - DISK_HYSTERESIS_PCT);
      const warn = d.pct >= t.diskWarnPct || (was !== undefined && d.pct >= t.diskWarnPct - DISK_HYSTERESIS_PCT);
      if (crit) out.push({ kind: 'disk', subject: d.mount, severity: 'critical', summary: `Disk ${d.mount}: ${d.pct}% to'lgan (kritik chegara ${t.diskCriticalPct}%)` });
      else if (warn) out.push({ kind: 'disk', subject: d.mount, severity: 'warn', summary: `Disk ${d.mount}: ${d.pct}% to'lgan (chegara ${t.diskWarnPct}%)` });
    }

    // Xotira: uzluksiz memForMin daqiqa
    if (k.memPct !== null && k.memPct >= t.memPct) {
      this.memSince ??= now;
      if (now - this.memSince >= t.memForMin * 60_000) out.push({ kind: 'memory', subject: '', severity: 'warn', summary: `Xotira ${k.memPct}% (>= ${t.memPct}%, ${t.memForMin} daqiqadan beri)` });
    } else this.memSince = null;

    // CPU: uzluksiz cpuForMin daqiqa (null = o'lchov yo'q: oynani buzmaydi ham, boshlamaydi ham)
    if (k.cpu !== null) {
      if (k.cpu >= t.cpuPct) {
        this.cpuSince ??= now;
        if (now - this.cpuSince >= t.cpuForMin * 60_000) out.push({ kind: 'cpu', subject: '', severity: 'warn', summary: `CPU ${k.cpu}% (>= ${t.cpuPct}%, ${t.cpuForMin} daqiqadan beri)` });
      } else this.cpuSince = null;
    }

    // Docker: faqat daemon'ga ulana olgan bo'lsak
    if (s.docker?.available) {
      evaluated.add('container');
      const names = new Set<string>();
      for (const c of s.docker.containers) {
        names.add(c.name);
        const loop = this.restartLoop(c.name, c.restartCount, now, t);
        if (loop) out.push({ kind: 'container', subject: c.name, severity: 'critical', summary: `Konteyner ${c.name}: ${loop.delta} marta qayta ishga tushdi (${t.restartLoopWindowMin} daqiqada)` });
        else if (isBadContainer(c)) {
          const why = c.health === 'unhealthy' ? 'unhealthy' : c.state === 'exited' ? `to'xtadi (kod ${exitCodeOf(c.status) ?? '?'})` : c.state;
          out.push({ kind: 'container', subject: c.name, severity: c.health === 'unhealthy' || c.state === 'restarting' ? 'warn' : 'critical', summary: `Konteyner ${c.name}: ${why}` });
        }
      }
      for (const n of [...this.restarts.keys()]) if (!names.has(n)) this.restarts.delete(n);
    }

    // systemd: faqat tekshirilgan bo'lsa
    if (s.systemd) {
      evaluated.add('systemd');
      for (const u of s.systemd.failed) out.push({ kind: 'systemd', subject: u, severity: 'warn', summary: `systemd unit muvaffaqiyatsiz: ${u}` });
    }
    return { conditions: out, evaluated };
  }

  /** Oynadagi eng kichik hisobdan joriy hisob farqi >= chegara (hisob kamaysa = konteyner qayta yaratilgan: oyna nolga). */
  private restartLoop(name: string, count: number, now: number, t: HealthThresholds): { delta: number } | null {
    const windowMs = t.restartLoopWindowMin * 60_000;
    let samples = this.restarts.get(name) ?? [];
    const last = samples[samples.length - 1];
    if (last && count < last.count) samples = [];
    samples.push({ at: now, count });
    samples = samples.filter((x) => now - x.at <= windowMs);
    this.restarts.set(name, samples);
    const min = Math.min(...samples.map((x) => x.count));
    const delta = count - min;
    return delta >= t.restartLoopCount ? { delta } : null;
  }
}
