import { describe, expect, it } from 'vitest';
import { AgentHealthPayloadSchema, HealthSnapshotSchema } from '@commander/contracts';
import { HealthCollector } from './collector.js';
import type { OsLike } from './collector.js';
import { ExecError } from './exec.js';
import type { HealthExec } from './exec.js';
import { HealthDeltaTracker } from './delta.js';
import { HealthReporter } from './reporter.js';
import { silentLogger } from '../logger.js';

const times = (idle: number, busy: number) => ({ user: busy, nice: 0, sys: 0, idle, irq: 0 });
function fakeOs(seq: Array<Array<ReturnType<typeof times>>>): OsLike {
  let i = 0;
  return {
    cpus: () => (seq[Math.min(i++, seq.length - 1)] as Array<ReturnType<typeof times>>).map((t) => ({ times: t })),
    totalmem: () => 16 * 1024 ** 3,
    freemem: () => 4 * 1024 ** 3,
    uptime: () => 12345.6,
    loadavg: () => [1.234, 0.5, 0.25],
  };
}
const router = (routes: Record<string, string | Error>): HealthExec => async (file, args) => {
  const key = [file, ...args].join(' ');
  for (const [k, v] of Object.entries(routes)) {
    if (key.startsWith(k)) {
      if (v instanceof Error) throw v;
      return v;
    }
  }
  throw new ExecError(`${file}: not found`, 'not_found');
};

const MEMINFO = 'MemTotal: 16384000 kB\nMemAvailable: 8192000 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n';
const DF = 'Filesystem Type 1024-blocks Used Available Capacity Mounted on\n/dev/sda2 ext4 1000 900 100 90% /\n';
const PS = '50.0 2.0 node --secret=abc\n1.0 1.0 sshd\n';

describe('HealthCollector', () => {
  it('Linux: hamma bo\'lim, sxemaga mos, argument sirlari yo\'q', async () => {
    const docker = JSON.stringify({ ID: 'aaaaaaaaaaaa', Names: 'web', Image: 'nginx', State: 'running', Status: 'Up 1 hour' });
    const c = new HealthCollector({
      platform: 'linux',
      os: fakeOs([[times(100, 0), times(100, 0)], [times(150, 50), times(100, 100)]]),
      readFile: async () => MEMINFO,
      exec: router({
        'df -kPT': DF,
        'ps -A -o pcpu=,pmem=,comm=': PS,
        'docker ps': docker,
        'docker inspect': `aaaaaaaaaaaa${'b'.repeat(52)}|2|none\n`,
        'systemctl --failed': 'nginx.service loaded failed failed x\n',
        'systemctl --user': '',
      }),
      now: () => 1000,
    });
    c.prime();
    const s = await c.collect();
    expect(HealthSnapshotSchema.safeParse(s).success).toBe(true);
    expect(s.cpu.pct).toBe(75);
    expect(s.cpu.perCore).toEqual([50, 100]);
    expect(s.cpu.load1).toBe(1.2);
    expect(s.memory.usedBytes).toBe(8192000 * 1024);
    expect(s.disks[0]).toMatchObject({ mount: '/', pct: 90 });
    expect(s.docker?.containers[0]).toMatchObject({ name: 'web', restartCount: 2 });
    expect(s.systemd?.failed).toEqual(['nginx.service']);
    expect(JSON.stringify(s)).not.toContain('secret');
    expect(s.topProcesses.byCpu[0]?.name).toBe('node');
  });
  it('birinchi o\'lchovda (prime yo\'q) cpu.pct = null', async () => {
    const c = new HealthCollector({ platform: 'linux', os: fakeOs([[times(1, 1)]]), readFile: async () => MEMINFO, exec: router({}) });
    const s = await c.collect();
    expect(s.cpu.pct).toBeNull();
    expect(s.disks).toEqual([]);
    expect(s.docker).toMatchObject({ available: false, reason: 'not_installed' });
    expect(s.systemd).toBeUndefined();
  });
  it('docker: ruxsat yo\'q va taymaut; not_installed eslab qolinadi', async () => {
    let calls = 0;
    const exec: HealthExec = async (file) => {
      if (file === 'docker') {
        calls += 1;
        throw new ExecError('x', 'not_found');
      }
      throw new ExecError('x', 'not_found');
    };
    let t = 0;
    const c = new HealthCollector({ platform: 'darwin', os: fakeOs([[times(1, 1)]]), exec, now: () => t });
    await c.collect();
    await c.collect();
    expect(calls).toBe(1);
    t = 11 * 60_000;
    await c.collect();
    expect(calls).toBe(2);
    const denied = new HealthCollector({ platform: 'linux', os: fakeOs([[times(1, 1)]]), readFile: async () => MEMINFO, exec: router({ 'docker ps': new ExecError('x', 'failed', 'permission denied') }) });
    expect((await denied.collect()).docker).toMatchObject({ available: false, reason: 'no_access' });
    const slow = new HealthCollector({ platform: 'linux', os: fakeOs([[times(1, 1)]]), readFile: async () => MEMINFO, exec: router({ 'docker ps': new ExecError('x', 'timeout') }) });
    expect((await slow.collect()).docker?.reason).toBe('timeout');
  });
  it('macOS: vm_stat + swap + df', async () => {
    const c = new HealthCollector({
      platform: 'darwin',
      os: fakeOs([[times(1, 1)]]),
      exec: router({
        vm_stat: 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages active: 100000.\nPages wired down: 50000.\nPages occupied by compressor: 10000.\n',
        'sysctl -n vm.swapusage': 'total = 1024.00M  used = 512.00M  free = 512.00M',
        'df -kP': 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk3s5 1000 600 400 60% /System/Volumes/Data\n',
        ps: '5.0 1.0 /usr/bin/foo\n',
      }),
    });
    const s = await c.collect();
    expect(s.memory).toMatchObject({ usedBytes: 160000 * 16384, swapTotalBytes: 1024 * 1024 ** 2, swapUsedBytes: 512 * 1024 ** 2 });
    expect(s.disks[0]?.mount).toBe('/System/Volumes/Data');
    expect(s.systemd).toBeUndefined();
    expect(s.cpu.load1).toBeDefined();
  });
  it('Windows: PowerShell, so\'ng wmic zaxirasi; loadavg yo\'q', async () => {
    const ps = router({
      'powershell.exe': new ExecError('x', 'failed'),
      'wmic logicaldisk': 'Node,DeviceID,FreeSpace,Size\r\nPC,C:,10,100\r\n',
      'wmic OS': 'Node,FreePhysicalMemory,TotalVisibleMemorySize\r\nPC,4000,16000\r\n',
      'wmic path': 'Node,Name,PercentProcessorTime,WorkingSet\r\nPC,sqlservr,40,1073741824\r\n',
    });
    const c = new HealthCollector({ platform: 'win32', os: fakeOs([[times(1, 1)]]), exec: ps });
    const s = await c.collect();
    expect(s.disks[0]).toMatchObject({ mount: 'C:', pct: 90 });
    expect(s.memory.usedBytes).toBe(12000 * 1024);
    expect(s.topProcesses.byCpu[0]?.name).toBe('sqlservr');
    expect(s.cpu.load1).toBeUndefined();
    expect(s.systemd).toBeUndefined();
  });
  it('Windows: PowerShell JSON yo\'li', async () => {
    const c = new HealthCollector({
      platform: 'win32',
      os: fakeOs([[times(1, 1)]]),
      exec: async (_f, args) => {
        const sc = args.at(-1) ?? '';
        if (sc.includes('Win32_LogicalDisk')) return '{"DeviceID":"C:","Size":100,"FreeSpace":5}';
        if (sc.includes('Win32_OperatingSystem')) return '{"TotalKB":1000,"FreeKB":250,"SwapTotalMB":1,"SwapUsedMB":0}';
        if (sc.includes('PerfProc')) return '[{"Name":"a","PercentProcessorTime":1,"WorkingSetPrivate":1048576}]';
        throw new ExecError('x', 'not_found');
      },
    });
    const s = await c.collect();
    expect(s.disks[0]?.pct).toBe(95);
    expect(s.memory.usedBytes).toBe(750 * 1024);
    expect(s.topProcesses.byCpu).toHaveLength(1);
  });
});

describe('HealthDeltaTracker', () => {
  const base = async () => {
    const c = new HealthCollector({
      platform: 'linux',
      os: fakeOs([[times(1, 1)]]),
      readFile: async () => MEMINFO,
      exec: router({ 'df -kPT': DF, 'ps -A': PS }),
    });
    return c.collect();
  };
  it('birinchisi full; keyin faqat o\'zgargan bo\'limlar; 5 daqiqada yana full', async () => {
    const s = await base();
    const t = new HealthDeltaTracker(300_000);
    const first = t.next(s, 0);
    expect(first.kind).toBe('full');
    expect(AgentHealthPayloadSchema.safeParse(first).success).toBe(true);
    const same = t.next(s, 30_000);
    expect(same.kind).toBe('delta');
    expect(same.disks).toBeUndefined();
    expect(same.topProcesses).toBeUndefined();
    expect(AgentHealthPayloadSchema.safeParse(same).success).toBe(true);
    const changed = t.next({ ...s, disks: [{ mount: '/', totalBytes: 10, usedBytes: 9, pct: 90 }] }, 60_000);
    expect(changed.disks).toHaveLength(1);
    expect(changed.topProcesses).toBeUndefined();
    expect(t.next(s, 300_000).kind).toBe('full');
  });
  it('reset() keyingi yukni full qiladi', async () => {
    const s = await base();
    const t = new HealthDeltaTracker();
    t.next(s, 0);
    t.reset();
    expect(t.next(s, 1).kind).toBe('full');
  });
  it('delta hajmi full dan ancha kichik', async () => {
    const s = await base();
    const t = new HealthDeltaTracker();
    const full = JSON.stringify(t.next(s, 0)).length;
    const delta = JSON.stringify(t.next(s, 1)).length;
    expect(delta).toBeLessThan(full);
  });
});

describe('HealthReporter', () => {
  it('ulanish yo\'q bo\'lsa yig\'maydi; qayta ulangach full yuboradi', async () => {
    const sent: Array<{ kind: string }> = [];
    let ready = false;
    let collects = 0;
    const collector = new HealthCollector({ platform: 'linux', os: fakeOs([[times(1, 1)]]), readFile: async () => { collects += 1; return MEMINFO; }, exec: router({}) });
    const r = new HealthReporter({ collector, transport: { isReady: () => ready, send: (p) => (sent.push(p), true) }, log: silentLogger });
    expect(await r.tick()).toBe(false);
    expect(collects).toBe(0);
    ready = true;
    expect(await r.tick()).toBe(true);
    expect(await r.tick()).toBe(true);
    expect(sent.map((p) => p.kind)).toEqual(['full', 'delta']);
    ready = false;
    await r.tick();
    ready = true;
    await r.tick();
    expect(sent.map((p) => p.kind)).toEqual(['full', 'delta', 'full']);
  });
  it('yig\'ish xatosi tick\'ni yiqitmaydi', async () => {
    const collector = { collect: async () => { throw new Error('boom'); }, prime: () => undefined } as unknown as HealthCollector;
    const r = new HealthReporter({ collector, transport: { isReady: () => true, send: () => true }, log: silentLogger });
    expect(await r.tick()).toBe(false);
  });
});
