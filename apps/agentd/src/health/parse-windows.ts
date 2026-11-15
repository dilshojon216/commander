import type { HealthDisk, HealthProcess } from '@commander/contracts';
import { baseProcName } from './parse-posix.js';

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** `wmic ... /format:csv`: birinchi qator sarlavha (`Node,A,B`), keyingilari qiymatlar. UTF-16/CRLF qoldiqlariga chidamli. */
export function parseWmicCsv(text: string): Array<Record<string, string>> {
  const lines = text.replace(/\0/g, '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const head = lines[0]?.split(',');
  if (!head || head.length < 2) return [];
  return lines.slice(1).map((l) => {
    const cells = l.split(',');
    const rec: Record<string, string> = {};
    head.forEach((h, i) => (rec[h] = cells[i] ?? ''));
    return rec;
  });
}

/** `ConvertTo-Json` bitta obyektni massivsiz, ko'plikni massiv qilib beradi. */
export function asArray(json: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(json)) return json.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null);
  return typeof json === 'object' && json !== null ? [json as Record<string, unknown>] : [];
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

function toDisks(rows: Array<Record<string, unknown>>, limit: number): HealthDisk[] {
  const out: HealthDisk[] = [];
  for (const r of rows) {
    const id = typeof r['DeviceID'] === 'string' ? r['DeviceID'] : null;
    const size = num(r['Size']);
    const free = num(r['FreeSpace']);
    if (!id || size === null || free === null || size <= 0) continue;
    const used = Math.max(0, size - free);
    out.push({ mount: id.slice(0, 256), totalBytes: Math.round(size), usedBytes: Math.round(used), pct: round1(Math.min(100, (used / size) * 100)) });
  }
  out.sort((a, b) => b.pct - a.pct);
  return out.slice(0, limit);
}

/** PowerShell `Get-CimInstance Win32_LogicalDisk ... | ConvertTo-Json`. */
export function parseWinDisksJson(stdout: string, limit = 10): HealthDisk[] {
  try {
    return toDisks(asArray(JSON.parse(stdout) as unknown), limit);
  } catch {
    return [];
  }
}

/** `wmic logicaldisk where DriveType=3 get DeviceID,FreeSpace,Size /format:csv`. */
export function parseWinDisksWmic(stdout: string, limit = 10): HealthDisk[] {
  return toDisks(parseWmicCsv(stdout), limit);
}

export interface WinMemory {
  totalBytes: number;
  usedBytes: number;
  swapTotalBytes: number;
  swapUsedBytes: number;
}

/** PowerShell: `{TotalKB, FreeKB, SwapTotalMB, SwapUsedMB}` (bitta obyekt). */
export function parseWinMemoryJson(stdout: string): WinMemory | null {
  try {
    const o = asArray(JSON.parse(stdout) as unknown)[0];
    if (!o) return null;
    const total = num(o['TotalKB']);
    const free = num(o['FreeKB']);
    if (total === null || free === null || total <= 0) return null;
    return {
      totalBytes: Math.round(total * 1024),
      usedBytes: Math.round(Math.max(0, total - free) * 1024),
      swapTotalBytes: Math.round((num(o['SwapTotalMB']) ?? 0) * 1024 ** 2),
      swapUsedBytes: Math.round((num(o['SwapUsedMB']) ?? 0) * 1024 ** 2),
    };
  } catch {
    return null;
  }
}

/** `wmic OS get FreePhysicalMemory,TotalVisibleMemorySize /format:csv` (KB). Swap alohida: wmic'da yo'q (0). */
export function parseWinMemoryWmic(stdout: string): WinMemory | null {
  const r = parseWmicCsv(stdout)[0];
  if (!r) return null;
  const total = num(r['TotalVisibleMemorySize']);
  const free = num(r['FreePhysicalMemory']);
  if (total === null || free === null || total <= 0) return null;
  return { totalBytes: Math.round(total * 1024), usedBytes: Math.round(Math.max(0, total - free) * 1024), swapTotalBytes: 0, swapUsedBytes: 0 };
}

function toProcs(rows: Array<{ name: unknown; cpu: unknown; mem: unknown }>, totalBytes: number): HealthProcess[] {
  const byName = new Map<string, { cpu: number; mem: number }>();
  for (const r of rows) {
    if (typeof r.name !== 'string') continue;
    const name = baseProcName(r.name);
    if (!name || /^(_total|idle|system idle process)$/i.test(name)) continue;
    const cur = byName.get(name) ?? { cpu: 0, mem: 0 };
    cur.cpu += num(r.cpu) ?? 0;
    cur.mem += num(r.mem) ?? 0;
    byName.set(name, cur);
  }
  return [...byName].map(([name, v]) => ({
    name,
    cpuPct: round1(v.cpu),
    memPct: totalBytes > 0 ? round1(Math.min(100, (v.mem / totalBytes) * 100)) : 0,
  }));
}

/** PowerShell `Win32_PerfFormattedData_PerfProc_Process | Select Name,PercentProcessorTime,WorkingSetPrivate | ConvertTo-Json`. */
export function parseWinProcessesJson(stdout: string, totalBytes: number): HealthProcess[] {
  try {
    return toProcs(asArray(JSON.parse(stdout) as unknown).map((o) => ({ name: o['Name'], cpu: o['PercentProcessorTime'], mem: o['WorkingSetPrivate'] })), totalBytes);
  } catch {
    return [];
  }
}

/** `wmic path Win32_PerfFormattedData_PerfProc_Process get Name,PercentProcessorTime,WorkingSet /format:csv`. */
export function parseWinProcessesWmic(stdout: string, totalBytes: number): HealthProcess[] {
  return toProcs(parseWmicCsv(stdout).map((r) => ({ name: r['Name'], cpu: r['PercentProcessorTime'], mem: r['WorkingSet'] })), totalBytes);
}
