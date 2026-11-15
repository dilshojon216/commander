import { HEALTH_LIMITS } from '@commander/contracts';
import type { AgentHealthPayload, HealthSnapshot } from '@commander/contracts';

type Section = 'disks' | 'topProcesses' | 'docker' | 'systemd';
const SECTIONS: Section[] = ['disks', 'topProcesses', 'docker', 'systemd'];

/**
 * Yuboriladigan yukni tanlaydi: har `fullEveryMs` da (va birinchisida, `reset()` dan keyin) to'liq snapshot; oraliqda
 * cpu/memory/uptime har doim, qolgan bo'limlar faqat avval yuborilganidan farq qilsa. Uzilgan ulanishdan keyin chaqiruvchi
 * `reset()` qiladi: keyingi yuk to'liq bo'ladi (center delta'ni bazasiz qabul qilmasin).
 */
export class HealthDeltaTracker {
  private lastFullAt = 0;
  private last = new Map<Section, string>();
  private hasFull = false;

  constructor(private readonly fullEveryMs: number = HEALTH_LIMITS.fullEveryMs) {}

  reset(): void {
    this.hasFull = false;
    this.last.clear();
  }

  next(s: HealthSnapshot, now: number): AgentHealthPayload {
    const common = { collectedAt: s.collectedAt, platform: s.platform, cpu: s.cpu, memory: s.memory, uptimeSec: s.uptimeSec };
    if (!this.hasFull || now - this.lastFullAt >= this.fullEveryMs) {
      this.hasFull = true;
      this.lastFullAt = now;
      for (const k of SECTIONS) this.last.set(k, JSON.stringify(s[k] ?? null));
      return {
        kind: 'full',
        ...common,
        disks: s.disks,
        topProcesses: s.topProcesses,
        ...(s.docker ? { docker: s.docker } : {}),
        ...(s.systemd ? { systemd: s.systemd } : {}),
      };
    }
    const changed: Partial<Pick<AgentHealthPayload, Section>> = {};
    for (const k of SECTIONS) {
      const json = JSON.stringify(s[k] ?? null);
      if (this.last.get(k) === json) continue;
      this.last.set(k, json);
      if (s[k] !== undefined) (changed as Record<string, unknown>)[k] = s[k];
    }
    return { kind: 'delta', ...common, ...changed };
  }
}
