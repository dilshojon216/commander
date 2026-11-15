import os from 'node:os';
import { readFile } from 'node:fs/promises';
import { HEALTH_LIMITS } from '@commander/contracts';
import type { HealthCpu, HealthDisk, HealthDocker, HealthMemory, HealthSnapshot, HealthSystemd, HealthTopProcesses } from '@commander/contracts';
import { ExecError, nodeExec } from './exec.js';
import type { HealthExec } from './exec.js';
import { INSPECT_FORMAT, mergeContainers, parseDockerInspect, parseDockerPs } from './parse-docker.js';
import { parseDf, parseMeminfo, parsePsProcesses, parseSwapUsageMac, parseSystemctlFailed, parseVmStat, topProcesses } from './parse-posix.js';
import { parseWinDisksJson, parseWinDisksWmic, parseWinMemoryJson, parseWinMemoryWmic, parseWinProcessesJson, parseWinProcessesWmic } from './parse-windows.js';

/** `node:os` ning kerakli qismi (testlarda almashtiriladi). */
export interface OsLike {
  cpus(): Array<{ times: { user: number; nice: number; sys: number; idle: number; irq: number } }>;
  totalmem(): number;
  freemem(): number;
  uptime(): number;
  loadavg(): number[];
}

export interface CollectorDeps {
  platform?: NodeJS.Platform;
  exec?: HealthExec;
  os?: OsLike;
  readFile?: (path: string) => Promise<string>;
  now?: () => number;
  /** `docker` yo'qligi shu muddatga eslab qolinadi (har 30 s'da qayta urinmaslik uchun). */
  dockerMissingRecheckMs?: number;
}

const PS_COMMAND = { file: 'ps', args: ['-A', '-o', 'pcpu=,pmem=,comm='] } as const;

const PS_WIN = {
  disks: "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object DeviceID,Size,FreeSpace | ConvertTo-Json -Compress",
  memory:
    '$o=Get-CimInstance Win32_OperatingSystem;$p=@(Get-CimInstance Win32_PageFileUsage);' +
    '[pscustomobject]@{TotalKB=$o.TotalVisibleMemorySize;FreeKB=$o.FreePhysicalMemory;' +
    'SwapTotalMB=($p|Measure-Object AllocatedBaseSize -Sum).Sum;SwapUsedMB=($p|Measure-Object CurrentUsage -Sum).Sum}|ConvertTo-Json -Compress',
  procs:
    "Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object {$_.Name -ne '_Total' -and $_.Name -ne 'Idle'} | Select-Object Name,PercentProcessorTime,WorkingSetPrivate | ConvertTo-Json -Compress",
} as const;

const powershell = (script: string): [string, string[]] => ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]];

type CpuTimes = { idle: number; total: number };
const sumTimes = (t: { user: number; nice: number; sys: number; idle: number; irq: number }): CpuTimes => ({ idle: t.idle, total: t.user + t.nice + t.sys + t.idle + t.irq });
const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * Mashina salomatligi yig'uvchisi (macOS, Linux, Windows). Har bo'lim alohida try: bittasi yiqilsa qolganlari ishlaydi.
 * Faqat o'qiydi; tashqi buyruqlar `execFile` (shell yo'q) va qisqa taymaut bilan. Jarayonlar nomi bilan (argumentsiz).
 */
export class HealthCollector {
  private readonly platform: NodeJS.Platform;
  private readonly exec: HealthExec;
  private readonly os: OsLike;
  private readonly read: (path: string) => Promise<string>;
  private readonly now: () => number;
  private prevCpu: CpuTimes[] | null = null;
  private dockerMissingUntil = 0;
  private systemdMissing = false;
  private readonly dockerRecheckMs: number;

  constructor(deps: CollectorDeps = {}) {
    this.platform = deps.platform ?? process.platform;
    this.exec = deps.exec ?? nodeExec;
    this.os = deps.os ?? os;
    this.read = deps.readFile ?? ((p) => readFile(p, 'utf8'));
    this.now = deps.now ?? Date.now;
    this.dockerRecheckMs = deps.dockerMissingRecheckMs ?? 10 * 60_000;
  }

  /** CPU namunasini oldindan oladi (birinchi `collect()` da foiz `null` bo'lmasligi uchun). */
  prime(): void {
    this.prevCpu = this.os.cpus().map((c) => sumTimes(c.times));
  }

  async collect(): Promise<HealthSnapshot> {
    const cpu = this.collectCpu();
    const [memory, disks, procs, docker, systemd] = await Promise.all([
      this.collectMemory(),
      this.collectDisks(),
      this.collectProcesses(),
      this.collectDocker(),
      this.collectSystemd(),
    ]);
    const top: HealthTopProcesses = topProcesses(procs, HEALTH_LIMITS.maxTopProcesses);
    return {
      collectedAt: this.now(),
      platform: this.platform,
      cpu,
      memory,
      uptimeSec: Math.floor(this.os.uptime()),
      disks: disks.slice(0, HEALTH_LIMITS.maxDisks),
      topProcesses: top,
      ...(docker ? { docker } : {}),
      ...(systemd ? { systemd } : {}),
    };
  }

  // --- CPU -------------------------------------------------------------------------------------

  private collectCpu(): HealthCpu {
    const cpus = this.os.cpus();
    const cur = cpus.map((c) => sumTimes(c.times));
    const prev = this.prevCpu;
    this.prevCpu = cur;
    const cores = Math.max(1, cur.length);
    const load = this.platform === 'win32' ? [] : this.os.loadavg();
    const base = {
      cores,
      ...(load.length >= 3 ? { load1: round1(load[0] ?? 0), load5: round1(load[1] ?? 0), load15: round1(load[2] ?? 0) } : {}),
    };
    if (!prev || prev.length !== cur.length) return { pct: null, ...base };
    const perCore = cur.map((c, i) => {
      const p = prev[i] as CpuTimes;
      const dt = c.total - p.total;
      const di = c.idle - p.idle;
      return dt > 0 ? round1(Math.min(100, Math.max(0, (1 - di / dt) * 100))) : 0;
    });
    const pct = perCore.length > 0 ? round1(perCore.reduce((a, b) => a + b, 0) / perCore.length) : null;
    return { pct, ...base, perCore: perCore.slice(0, HEALTH_LIMITS.maxPerCore) };
  }

  // --- xotira ----------------------------------------------------------------------------------

  private async collectMemory(): Promise<HealthMemory> {
    const fallback: HealthMemory = {
      totalBytes: this.os.totalmem(),
      usedBytes: Math.max(0, this.os.totalmem() - this.os.freemem()),
      swapTotalBytes: 0,
      swapUsedBytes: 0,
    };
    try {
      if (this.platform === 'linux') return parseMeminfo(await this.read('/proc/meminfo')) ?? fallback;
      if (this.platform === 'darwin') {
        const vm = parseVmStat(await this.exec('vm_stat', []), this.os.totalmem());
        let swap = { swapTotalBytes: 0, swapUsedBytes: 0 };
        try {
          swap = parseSwapUsageMac(await this.exec('sysctl', ['-n', 'vm.swapusage'])) ?? swap;
        } catch {
          /* swap ma'lum emas */
        }
        return vm ? { ...vm, ...swap } : { ...fallback, ...swap };
      }
      if (this.platform === 'win32') {
        try {
          const [f, a] = powershell(PS_WIN.memory);
          const m = parseWinMemoryJson(await this.exec(f, a));
          if (m) return m;
        } catch {
          /* wmic'ga o'tamiz */
        }
        const m = parseWinMemoryWmic(await this.exec('wmic', ['OS', 'get', 'FreePhysicalMemory,TotalVisibleMemorySize', '/format:csv']));
        return m ?? fallback;
      }
    } catch {
      /* fallback */
    }
    return fallback;
  }

  // --- disk ------------------------------------------------------------------------------------

  private async collectDisks(): Promise<HealthDisk[]> {
    try {
      if (this.platform === 'linux') return parseDf(await this.exec('df', ['-kPT']), { withType: true, limit: HEALTH_LIMITS.maxDisks });
      if (this.platform === 'darwin') return parseDf(await this.exec('df', ['-kP']), { withType: false, limit: HEALTH_LIMITS.maxDisks });
      if (this.platform === 'win32') {
        try {
          const [f, a] = powershell(PS_WIN.disks);
          const d = parseWinDisksJson(await this.exec(f, a), HEALTH_LIMITS.maxDisks);
          if (d.length > 0) return d;
        } catch {
          /* wmic */
        }
        return parseWinDisksWmic(await this.exec('wmic', ['logicaldisk', 'where', 'DriveType=3', 'get', 'DeviceID,FreeSpace,Size', '/format:csv']), HEALTH_LIMITS.maxDisks);
      }
    } catch {
      /* bo'sh */
    }
    return [];
  }

  // --- jarayonlar (faqat nom) --------------------------------------------------------------------

  private async collectProcesses(): Promise<Array<{ name: string; cpuPct: number; memPct: number }>> {
    try {
      if (this.platform === 'win32') {
        const total = this.os.totalmem();
        try {
          const [f, a] = powershell(PS_WIN.procs);
          const p = parseWinProcessesJson(await this.exec(f, a, { timeoutMs: 15_000 }), total);
          if (p.length > 0) return p;
        } catch {
          /* wmic */
        }
        return parseWinProcessesWmic(
          await this.exec('wmic', ['path', 'Win32_PerfFormattedData_PerfProc_Process', 'get', 'Name,PercentProcessorTime,WorkingSet', '/format:csv'], { timeoutMs: 15_000 }),
          total,
        );
      }
      return parsePsProcesses(await this.exec(PS_COMMAND.file, [...PS_COMMAND.args]));
    } catch {
      return [];
    }
  }

  // --- Docker ----------------------------------------------------------------------------------

  private async collectDocker(): Promise<HealthDocker | undefined> {
    if (this.now() < this.dockerMissingUntil) return { available: false, containers: [], reason: 'not_installed' };
    try {
      const ps = parseDockerPs(await this.exec('docker', ['ps', '-a', '--format', '{{json .}}'], { timeoutMs: 10_000 }));
      let inspect: ReturnType<typeof parseDockerInspect> = [];
      if (ps.length > 0) {
        try {
          inspect = parseDockerInspect(await this.exec('docker', ['inspect', '--format', INSPECT_FORMAT, ...ps.slice(0, HEALTH_LIMITS.maxContainers).map((p) => p.id)], { timeoutMs: 10_000 }));
        } catch {
          /* restart soni/health Status'dan taxmin qilinadi */
        }
      }
      return { available: true, containers: mergeContainers(ps, inspect).slice(0, HEALTH_LIMITS.maxContainers) };
    } catch (err) {
      if (err instanceof ExecError && err.code === 'not_found') {
        this.dockerMissingUntil = this.now() + this.dockerRecheckMs;
        return { available: false, containers: [], reason: 'not_installed' };
      }
      if (err instanceof ExecError && err.code === 'timeout') return { available: false, containers: [], reason: 'timeout' };
      return { available: false, containers: [], reason: 'no_access' };
    }
  }

  // --- systemd (Linux) -------------------------------------------------------------------------

  private async collectSystemd(): Promise<HealthSystemd | undefined> {
    if (this.platform !== 'linux' || this.systemdMissing) return undefined;
    const failed: string[] = [];
    let any = false;
    for (const [args, suffix] of [
      [['--failed', '--no-legend', '--plain', '--no-pager'], ''],
      [['--user', '--failed', '--no-legend', '--plain', '--no-pager'], ' [user]'],
    ] as const) {
      try {
        for (const unit of parseSystemctlFailed(await this.exec('systemctl', [...args]))) failed.push(`${unit}${suffix}`.slice(0, 128));
        any = true;
      } catch (err) {
        if (err instanceof ExecError && err.code === 'not_found') {
          this.systemdMissing = true;
          return undefined;
        }
        /* user bus yo'q va h.k.: shu qism o'tkazib yuboriladi */
      }
    }
    if (!any) return undefined;
    return { failed: [...new Set(failed)].slice(0, HEALTH_LIMITS.maxFailedUnits) };
  }
}
