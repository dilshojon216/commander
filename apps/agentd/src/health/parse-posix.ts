import type { HealthDisk, HealthProcess } from '@commander/contracts';

const round1 = (n: number): number => Math.round(n * 10) / 10;
const clampPct = (n: number): number => Math.min(100, Math.max(0, n));

/** Haqiqiy diskka tegishli bo'lmagan fayl tizimlari (Linux `df -T` turi). */
const PSEUDO_FS = new Set([
  'tmpfs', 'devtmpfs', 'devfs', 'squashfs', 'overlay', 'proc', 'sysfs', 'cgroup', 'cgroup2', 'devpts', 'efivarfs',
  'autofs', 'mqueue', 'debugfs', 'tracefs', 'securityfs', 'pstore', 'configfs', 'fusectl', 'binfmt_misc', 'ramfs',
  'hugetlbfs', 'bpf', 'nsfs', 'iso9660', 'map', 'fuse.lxcfs', 'fuse.snapfuse', 'fuse.gvfsd-fuse', 'fuse.portal',
]);
const PSEUDO_MOUNT_PREFIXES = ['/proc', '/sys', '/dev', '/run', '/snap', '/var/lib/docker/', '/var/lib/containerd/', '/boot/efi', '/System/Volumes/VM', '/System/Volumes/Preboot', '/System/Volumes/Update', '/System/Volumes/xarts', '/System/Volumes/iSCPreboot', '/System/Volumes/Hardware', '/private/var/vm',
  // macOS: faqat o'qiladigan tizim/simulyator obrazlari va ilova translocation'lari doim ~100% ko'rinadi (yolg'on ogohlantirish)
  '/private/var/run/com.apple.security.cryptexd', '/Library/Developer/CoreSimulator/Volumes', '/private/var/folders'];

export function isPseudoMount(mount: string, fs?: string): boolean {
  if (fs && PSEUDO_FS.has(fs)) return true;
  return PSEUDO_MOUNT_PREFIXES.some((p) => (p.endsWith('/') ? mount.startsWith(p) : mount === p || mount.startsWith(`${p}/`)));
}

/**
 * `df -kP` (macOS) yoki `df -kPT` (Linux) chiqishi. `withType` = `-T` ustuni bor. Pseudo fs o'tkazib yuboriladi,
 * bir xil (qurilma, hajm) takrorlanmaydi (bind-mount), `limit` ta eng to'lgani qaytadi (to'lganlik kamayish tartibida).
 * Foiz df bilan bir xil: used / (used + avail).
 */
export function parseDf(stdout: string, opts: { withType: boolean; limit?: number }): HealthDisk[] {
  const re = opts.withType
    ? /^(\S.*?)\s+(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(?:\d+%|-)\s+(\/.*)$/
    : /^(\S.*?)\s+(\d+)\s+(\d+)\s+(\d+)\s+(?:\d+%|-)\s+(\/.*)$/;
  const seen = new Set<string>();
  const out: HealthDisk[] = [];
  for (const line of stdout.split('\n')) {
    const m = re.exec(line.trimEnd());
    if (!m) continue;
    const device = m[1] as string;
    const fs = opts.withType ? (m[2] as string) : undefined;
    const o = opts.withType ? 3 : 2;
    const total = Number(m[o]) * 1024;
    const used = Number(m[o + 1]) * 1024;
    const avail = Number(m[o + 2]) * 1024;
    const mount = m[o + 3] as string;
    if (total <= 0 || isPseudoMount(mount, fs)) continue;
    if (!opts.withType && (device === 'devfs' || device === 'map' || device.startsWith('map '))) continue;
    const key = `${device}:${total}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const denom = used + avail;
    out.push({ mount: mount.slice(0, 256), ...(fs ? { fs } : {}), totalBytes: total, usedBytes: used, pct: round1(clampPct(denom > 0 ? (used / denom) * 100 : 0)) });
  }
  out.sort((a, b) => b.pct - a.pct);
  return out.slice(0, opts.limit ?? 10);
}

/** `/proc/meminfo`: used = MemTotal - MemAvailable (kesh hisobga olinmaydi). */
export function parseMeminfo(text: string): { totalBytes: number; usedBytes: number; swapTotalBytes: number; swapUsedBytes: number } | null {
  const kb = new Map<string, number>();
  for (const line of text.split('\n')) {
    const m = /^(\w+):\s+(\d+)\s*kB/.exec(line);
    if (m) kb.set(m[1] as string, Number(m[2]));
  }
  const total = kb.get('MemTotal');
  if (!total) return null;
  const avail = kb.get('MemAvailable') ?? (kb.get('MemFree') ?? 0) + (kb.get('Buffers') ?? 0) + (kb.get('Cached') ?? 0);
  const swapTotal = kb.get('SwapTotal') ?? 0;
  const swapFree = kb.get('SwapFree') ?? 0;
  return {
    totalBytes: total * 1024,
    usedBytes: Math.max(0, total - avail) * 1024,
    swapTotalBytes: swapTotal * 1024,
    swapUsedBytes: Math.max(0, swapTotal - swapFree) * 1024,
  };
}

/** macOS `vm_stat`: ishlatilgan = active + wired + compressor (Activity Monitor "Memory Used"ga yaqin). */
export function parseVmStat(text: string, totalBytes: number): { totalBytes: number; usedBytes: number } | null {
  const size = /page size of (\d+) bytes/.exec(text)?.[1];
  if (!size) return null;
  const pages = (label: string): number => {
    const m = new RegExp(`^${label}:\\s+(\\d+)\\.?`, 'm').exec(text);
    return m ? Number(m[1]) : 0;
  };
  const used = (pages('Pages active') + pages('Pages wired down') + pages('Pages occupied by compressor')) * Number(size);
  return { totalBytes, usedBytes: Math.min(totalBytes, used) };
}

/** macOS `sysctl -n vm.swapusage`: `total = 2048.00M  used = 1024.50M  free = ...`. */
export function parseSwapUsageMac(text: string): { swapTotalBytes: number; swapUsedBytes: number } | null {
  const unit: Record<string, number> = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };
  const get = (k: string): number | null => {
    const m = new RegExp(`${k} = ([\\d.]+)([KMGT])`).exec(text);
    return m ? Math.round(Number(m[1]) * (unit[m[2] as string] as number)) : null;
  };
  const total = get('total');
  const used = get('used');
  return total === null || used === null ? null : { swapTotalBytes: total, swapUsedBytes: used };
}

/** Yo'l/argumentsiz nom: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` -> `Google Chrome`. */
export function baseProcName(raw: string): string {
  let n = raw.trim();
  // Himoya chuqurligi: `comm` argument bermaydi, lekin kutilmagan chiqishda ham `-flag`/`k=v` qismlari kesiladi.
  n = n.replace(/\s+(?:-{1,2}\S|\S*=).*$/, '');
  n = n.replace(/\\/g, '/');
  const slash = n.lastIndexOf('/');
  if (slash >= 0) n = n.slice(slash + 1);
  n = n.replace(/\.exe$/i, '').replace(/#\d+$/, '').replace(/[\u0000-\u001f]/g, '').trim();
  return n.slice(0, 128);
}

/**
 * `ps -A -o pcpu=,pmem=,comm=`: faqat `comm` (bajariladigan fayl nomi): `args`/`command` HECH QACHON so'ralmaydi.
 * Bir xil nomli jarayonlar yig'iladi (masalan 12 ta `node`). Qaytadi: nom bo'yicha jamlangan ro'yxat.
 */
export function parsePsProcesses(stdout: string): HealthProcess[] {
  const byName = new Map<string, { cpu: number; mem: number }>();
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+(?:[.,]\d+)?)\s+(\d+(?:[.,]\d+)?)\s+(\S.*)$/.exec(line);
    if (!m) continue;
    const name = baseProcName(m[3] as string);
    if (!name) continue;
    const cur = byName.get(name) ?? { cpu: 0, mem: 0 };
    cur.cpu += Number((m[1] as string).replace(',', '.'));
    cur.mem += Number((m[2] as string).replace(',', '.'));
    byName.set(name, cur);
  }
  return [...byName].map(([name, v]) => ({ name, cpuPct: round1(v.cpu), memPct: round1(clampPct(v.mem)) }));
}

/** Eng band 5 tadan CPU va RAM bo'yicha (nol bo'lganlar tushmaydi). */
export function topProcesses(all: HealthProcess[], n = 5): { byCpu: HealthProcess[]; byMem: HealthProcess[] } {
  const byCpu = [...all].filter((p) => p.cpuPct > 0).sort((a, b) => b.cpuPct - a.cpuPct || a.name.localeCompare(b.name)).slice(0, n);
  const byMem = [...all].filter((p) => p.memPct > 0).sort((a, b) => b.memPct - a.memPct || a.name.localeCompare(b.name)).slice(0, n);
  return { byCpu, byMem };
}

/**
 * `systemctl --failed --no-legend --plain`: har qator `UNIT LOAD ACTIVE SUB DESCRIPTION`; faqat unit nomi.
 * Boshidagi belgi (`●`, `*`) tashlanadi.
 */
export function parseSystemctlFailed(stdout: string): string[] {
  const out: string[] = [];
  for (const line of stdout.split('\n')) {
    const t = line.replace(/^[\s●*×]+/u, '');
    const m = /^([A-Za-z0-9:_.@\\-]+\.(?:service|socket|mount|timer|target|path|slice|scope|swap|automount|device))\b/.exec(t);
    if (m) out.push((m[1] as string).slice(0, 128));
  }
  return out;
}
