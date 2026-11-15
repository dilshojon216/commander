import type { AgentHealthPayload, HealthSnapshot, HealthStatus } from '@commander/contracts';

/** Delta'ni oxirgi snapshot bilan birlashtiradi. `full` avvalgisini to'liq almashtiradi; delta'da yo'q bo'lim = o'zgarmagan. */
export function mergeSnapshot(prev: HealthSnapshot | null, p: AgentHealthPayload): HealthSnapshot {
  const base: HealthSnapshot = {
    collectedAt: p.collectedAt,
    platform: p.platform,
    cpu: p.cpu,
    memory: p.memory,
    uptimeSec: p.uptimeSec,
    disks: [],
    topProcesses: { byCpu: [], byMem: [] },
  };
  if (p.kind === 'full') {
    return { ...base, disks: p.disks ?? [], topProcesses: p.topProcesses ?? base.topProcesses, ...(p.docker ? { docker: p.docker } : {}), ...(p.systemd ? { systemd: p.systemd } : {}) };
  }
  const docker = p.docker ?? prev?.docker;
  const systemd = p.systemd ?? prev?.systemd;
  return {
    ...base,
    disks: p.disks ?? prev?.disks ?? [],
    topProcesses: p.topProcesses ?? prev?.topProcesses ?? base.topProcesses,
    ...(docker ? { docker } : {}),
    ...(systemd ? { systemd } : {}),
  };
}

export interface KeyNumbers {
  cpu: number | null;
  memPct: number | null;
  diskMaxPct: number | null;
  diskMaxMount: string | null;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

export function keyNumbers(s: HealthSnapshot): KeyNumbers {
  const memPct = s.memory.totalBytes > 0 ? round1(Math.min(100, (s.memory.usedBytes / s.memory.totalBytes) * 100)) : null;
  let max: { pct: number; mount: string } | null = null;
  for (const d of s.disks) if (!max || d.pct > max.pct) max = { pct: d.pct, mount: d.mount };
  return { cpu: s.cpu.pct, memPct, diskMaxPct: max?.pct ?? null, diskMaxMount: max?.mount ?? null };
}

/** Konteyner "yomon" ro'yxatida: chiqib ketgan (kod != 0), dead, restarting yoki unhealthy. Exit 0 (bir martalik vazifa) yomon emas. */
export function exitCodeOf(status: string): number | null {
  const m = /^Exited \((-?\d+)\)/i.exec(status);
  return m ? Number(m[1]) : null;
}

/** `docker stop`/Ctrl-C natijasi (SIGINT/SIGKILL/SIGTERM): egasi o'zi to'xtatgan bo'lishi mumkin — ogohlantirilmaydi. */
const MANUAL_STOP_CODES = new Set([0, 130, 137, 143]);

/** `Exited (1) 5 minutes ago` → yaqinda (≤ 24 soat) to'xtaganmi. Vaqt topilmasa — yaqinda deb hisoblanadi. */
export function exitedRecently(status: string): boolean {
  const m = /\b(\d+|an?|About an?)\s+(second|minute|hour|day|week|month|year)s?\s+ago/i.exec(status);
  if (!m) return true;
  const unit = (m[2] ?? '').toLowerCase();
  return unit === 'second' || unit === 'minute' || unit === 'hour';
}

export function isBadContainer(c: { state: string; status: string; health: string }): boolean {
  if (c.health === 'unhealthy') return true;
  if (c.state === 'dead' || c.state === 'restarting') return true;
  if (c.state === 'exited') {
    const code = exitCodeOf(c.status) ?? 1;
    // Eski (bir kundan oldin) to'xtagan yoki qo'lda to'xtatilgan konteyner — hodisa emas
    return !MANUAL_STOP_CODES.has(code) && exitedRecently(c.status);
  }
  return false;
}

const RANK: Record<HealthStatus, number> = { unknown: 0, ok: 1, offline: 2, warn: 3, critical: 4 };

/** critical > warn > offline > ok > unknown. Bo'sh ro'yxat = unknown. */
export function worstStatus(list: HealthStatus[]): HealthStatus {
  let w: HealthStatus = 'unknown';
  for (const s of list) if (RANK[s] > RANK[w]) w = s;
  return w;
}

/** Snapshot shundan eski bo'lsa (agentd health yubormayapti) holat `unknown`. */
export const STALE_SNAPSHOT_MS = 3 * 60_000;

export function computeStatus(input: {
  online: boolean;
  snapshotAt: number | null;
  now: number;
  openSeverities: Array<'warn' | 'critical'>;
}): HealthStatus {
  if (input.openSeverities.includes('critical')) return 'critical';
  if (input.openSeverities.includes('warn')) return 'warn';
  if (!input.online) return 'offline';
  if (input.snapshotAt === null || input.now - input.snapshotAt > STALE_SNAPSHOT_MS) return 'unknown';
  return 'ok';
}
