import { describe, expect, it } from 'vitest';
import { parseDockerInspect, parseDockerPs, mergeContainers, sanitizeImage } from './parse-docker.js';
import { baseProcName, isPseudoMount, parseDf, parseMeminfo, parsePsProcesses, parseSwapUsageMac, parseSystemctlFailed, parseVmStat, topProcesses } from './parse-posix.js';
import { parseWinDisksJson, parseWinDisksWmic, parseWinMemoryJson, parseWinMemoryWmic, parseWinProcessesJson, parseWinProcessesWmic, parseWmicCsv } from './parse-windows.js';

const DF_LINUX = `Filesystem     Type     1024-blocks      Used Available Capacity Mounted on
tmpfs          tmpfs         1626372      1912   1624460       1% /run
/dev/sda2      ext4        102626232  93500000   4000000      96% /
tmpfs          tmpfs         8131840         0   8131840       0% /dev/shm
/dev/sda1      vfat           523248      6220    517028       2% /boot/efi
/dev/sdb1      ext4        515928320 103185664 386512000      22% /data
/dev/sdb1      ext4        515928320 103185664 386512000      22% /srv/bind
/dev/loop3     squashfs        65536     65536         0     100% /snap/core20/1974
overlay        overlay     102626232  93500000   4000000      96% /var/lib/docker/overlay2/abc/merged
/dev/sdc1      ext4        100000000  50000000  50000000      50% /mnt/my disk
`;

const DF_MAC = `Filesystem      1024-blocks      Used Available Capacity  Mounted on
/dev/disk3s1s1    971350180  15000000 400000000     4%    /
devfs                   215       215         0   100%    /dev
/dev/disk3s6      971350180   2000000 400000000     1%    /System/Volumes/VM
/dev/disk3s5      971350180 540000000 400000000    58%    /System/Volumes/Data
map auto_home             0         0         0   100%    /System/Volumes/Data/home
/dev/disk5s1      488050000 400000000  80000000    83%    /Volumes/Backup Drive
`;

describe('parseDf', () => {
  it('Linux: pseudo fs, takror (bind) va snap tashlanadi; bo\'shliqli mount; kamayish tartibida', () => {
    const d = parseDf(DF_LINUX, { withType: true });
    expect(d.map((x) => x.mount)).toEqual(['/', '/mnt/my disk', '/data']);
    expect(d[0]).toMatchObject({ fs: 'ext4', pct: 95.9 });
    expect(d[0]?.totalBytes).toBe(102626232 * 1024);
  });
  it('macOS: devfs, map, VM tomi tashlanadi', () => {
    const d = parseDf(DF_MAC, { withType: false });
    expect(d.map((x) => x.mount)).toEqual(['/Volumes/Backup Drive', '/System/Volumes/Data', '/']);
  });
  it('limit 10 bilan cheklanadi', () => {
    const rows = Array.from({ length: 15 }, (_, i) => `/dev/d${i} ext4 1000 ${100 + i} 800 12% /m${i}`).join('\n');
    expect(parseDf(rows, { withType: true })).toHaveLength(10);
  });
  it('buzuq qatorlar jim o\'tkaziladi', () => {
    expect(parseDf('garbage\n\n', { withType: true })).toEqual([]);
  });
});

describe('xotira parserlari', () => {
  it('meminfo: used = total - available, swap', () => {
    const m = parseMeminfo('MemTotal:       16384000 kB\nMemFree:          500000 kB\nMemAvailable:    8192000 kB\nSwapTotal:       2048000 kB\nSwapFree:        1024000 kB\n');
    expect(m).toEqual({ totalBytes: 16384000 * 1024, usedBytes: 8192000 * 1024, swapTotalBytes: 2048000 * 1024, swapUsedBytes: 1024000 * 1024 });
    expect(parseMeminfo('nothing')).toBeNull();
  });
  it('meminfo: MemAvailable yo\'q eski yadro', () => {
    const m = parseMeminfo('MemTotal: 1000 kB\nMemFree: 100 kB\nBuffers: 100 kB\nCached: 300 kB\n');
    expect(m?.usedBytes).toBe(500 * 1024);
  });
  it('vm_stat', () => {
    const t = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:                               3000.\nPages active:                           100000.\nPages wired down:                        50000.\nPages occupied by compressor:            10000.\n';
    expect(parseVmStat(t, 32 * 1024 ** 3)).toEqual({ totalBytes: 32 * 1024 ** 3, usedBytes: 160000 * 16384 });
    expect(parseVmStat('x', 1)).toBeNull();
  });
  it('sysctl vm.swapusage', () => {
    expect(parseSwapUsageMac('total = 2048.00M  used = 1024.50M  free = 1023.50M  (encrypted)')).toEqual({ swapTotalBytes: 2048 * 1024 ** 2, swapUsedBytes: Math.round(1024.5 * 1024 ** 2) });
    expect(parseSwapUsageMac('')).toBeNull();
  });
});

describe('jarayonlar: faqat nom, argumentsiz', () => {
  const PS = `  12.5  3.1 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
   1.0  0.5 node
   2.0  1.5 node
  99.0  0.1 /usr/sbin/mysqld
   0.0  0.0 kworker/0:1
`;
  it('basename, bir xil nom yig\'iladi, yo\'l qoladi emas', () => {
    const p = parsePsProcesses(PS);
    expect(p.find((x) => x.name === 'node')).toEqual({ name: 'node', cpuPct: 3, memPct: 2 });
    expect(p.find((x) => x.name === 'Google Chrome')?.cpuPct).toBe(12.5);
    expect(p.some((x) => x.name.includes('/'))).toBe(false);
  });
  it('ps ustunlari faqat pcpu/pmem/comm: argument matni chiqishda bo\'lsa ham nomga kirmaydi', () => {
    // comm ustuni argumentlarni bermaydi; himoya chuqurligi: "--password=x" kabi satr nom sifatida bo'sh joydan keyin qolsa ham basename kesadi
    expect(baseProcName('/usr/bin/python3')).toBe('python3');
    expect(baseProcName('C:\\Windows\\System32\\svchost.exe')).toBe('svchost');
    expect(baseProcName('chrome#3')).toBe('chrome');
  });
  it('top 5, nol bo\'lganlar tushmaydi', () => {
    const t = topProcesses(parsePsProcesses(PS), 2);
    expect(t.byCpu.map((p) => p.name)).toEqual(['mysqld', 'Google Chrome']);
    expect(t.byMem.map((p) => p.name)).toEqual(['Google Chrome', 'node']);
    expect(topProcesses(parsePsProcesses('0.0 0.0 idle\n')).byCpu).toEqual([]);
  });
});

describe('systemctl --failed', () => {
  it('faqat unit nomlari', () => {
    const t = `● nginx.service       loaded failed failed A high performance web server and a reverse proxy server
  backup.timer        loaded failed failed Nightly backup
  ● foo@bar.service  loaded failed failed Template
0 loaded units listed.
`;
    expect(parseSystemctlFailed(t)).toEqual(['nginx.service', 'backup.timer', 'foo@bar.service']);
    expect(parseSystemctlFailed('')).toEqual([]);
  });
});

const DOCKER_PS = [
  JSON.stringify({ ID: 'abc123def456', Names: 'api', Image: 'ghcr.io/acme/api:1.2', State: 'running', Status: 'Up 3 hours (healthy)', Labels: 'secret=hunter2', Command: '"node --token=abc"', Ports: '0.0.0.0:80->80/tcp' }),
  JSON.stringify({ ID: '111111111111', Names: 'db,other', Image: 'postgres:16', State: 'exited', Status: 'Exited (1) 2 minutes ago' }),
  JSON.stringify({ ID: '222222222222', Names: 'worker', Image: 'user:pw@registry.local/w:1', State: 'restarting', Status: 'Restarting (1) 5 seconds ago' }),
  'not json',
].join('\n');

describe('docker', () => {
  it('ps: faqat kerakli maydonlar, label/command/port YO\'Q', () => {
    const ps = parseDockerPs(DOCKER_PS);
    expect(ps).toHaveLength(3);
    expect(JSON.stringify(ps)).not.toMatch(/hunter2|token|0\.0\.0\.0/);
    expect(ps[1]).toMatchObject({ name: 'db', state: 'exited' });
    expect(ps[2]?.image).toBe('registry.local/w:1');
  });
  it('inspect va birlashtirish; inspect yo\'q bo\'lsa Status\'dan health', () => {
    const insp = parseDockerInspect(`abc123def456${'0'.repeat(52)}|0|healthy\n111111111111${'0'.repeat(52)}|7|none\nbad line\n`);
    const c = mergeContainers(parseDockerPs(DOCKER_PS), insp);
    expect(c[0]).toMatchObject({ name: 'api', restartCount: 0, health: 'healthy' });
    expect(c[1]).toMatchObject({ name: 'db', restartCount: 7, health: 'none' });
    expect(c[2]).toMatchObject({ name: 'worker', restartCount: 0, health: 'none' });
    const noInspect = mergeContainers(parseDockerPs(DOCKER_PS), []);
    expect(noInspect[0]?.health).toBe('healthy');
  });
  it('sanitizeImage', () => {
    expect(sanitizeImage('https://u:p@reg/x:1')).toBe('reg/x:1');
    expect(sanitizeImage('nginx:latest')).toBe('nginx:latest');
  });
});

describe('Windows', () => {
  it('PowerShell disk JSON (massiv va bitta obyekt)', () => {
    const many = '[{"DeviceID":"C:","Size":500000000000,"FreeSpace":50000000000},{"DeviceID":"D:","Size":1000,"FreeSpace":900}]';
    const d = parseWinDisksJson(many);
    expect(d.map((x) => x.mount)).toEqual(['C:', 'D:']);
    expect(d[0]?.pct).toBe(90);
    expect(parseWinDisksJson('{"DeviceID":"C:","Size":100,"FreeSpace":25}')[0]?.pct).toBe(75);
    expect(parseWinDisksJson('not json')).toEqual([]);
  });
  it('wmic disk CSV (CRLF, ustun tartibi alifbo)', () => {
    const t = '\r\nNode,DeviceID,FreeSpace,Size\r\nWIN-1,C:,25,100\r\nWIN-1,E:,,\r\n';
    expect(parseWinDisksWmic(t)).toEqual([{ mount: 'C:', totalBytes: 100, usedBytes: 75, pct: 75 }]);
    expect(parseWmicCsv('')).toEqual([]);
  });
  it('xotira: PowerShell va wmic', () => {
    expect(parseWinMemoryJson('{"TotalKB":16000000,"FreeKB":4000000,"SwapTotalMB":2048,"SwapUsedMB":100}')).toEqual({
      totalBytes: 16000000 * 1024, usedBytes: 12000000 * 1024, swapTotalBytes: 2048 * 1024 ** 2, swapUsedBytes: 100 * 1024 ** 2,
    });
    expect(parseWinMemoryJson('{"TotalKB":16000000,"FreeKB":4000000,"SwapTotalMB":null,"SwapUsedMB":null}')?.swapTotalBytes).toBe(0);
    expect(parseWinMemoryWmic('Node,FreePhysicalMemory,TotalVisibleMemorySize\r\nPC,4000,16000\r\n')?.usedBytes).toBe(12000 * 1024);
    expect(parseWinMemoryWmic('')).toBeNull();
  });
  it('jarayonlar: Idle/_Total tashlanadi, #N olinadi, nomlar yig\'iladi', () => {
    const total = 16 * 1024 ** 3;
    const j = JSON.stringify([
      { Name: '_Total', PercentProcessorTime: 100, WorkingSetPrivate: 1 },
      { Name: 'Idle', PercentProcessorTime: 90, WorkingSetPrivate: 0 },
      { Name: 'chrome', PercentProcessorTime: 10, WorkingSetPrivate: 1024 ** 3 },
      { Name: 'chrome#1', PercentProcessorTime: 5, WorkingSetPrivate: 1024 ** 3 },
      { Name: 'sqlservr', PercentProcessorTime: 30, WorkingSetPrivate: 4 * 1024 ** 3 },
    ]);
    const p = parseWinProcessesJson(j, total);
    expect(p).toHaveLength(2);
    expect(p.find((x) => x.name === 'chrome')).toEqual({ name: 'chrome', cpuPct: 15, memPct: 12.5 });
    const w = parseWinProcessesWmic('Node,Name,PercentProcessorTime,WorkingSet\r\nPC,svchost#2,3,1073741824\r\nPC,_Total,100,5\r\n', total);
    expect(w).toEqual([{ name: 'svchost', cpuPct: 3, memPct: 6.3 }]);
  });
});

describe('isPseudoMount: macOS obrazlari', () => {
  it('cryptex, simulyator va translocation yo\'llari o\'tkazib yuboriladi; asosiy disklar qoladi', () => {
    expect(isPseudoMount('/private/var/run/com.apple.security.cryptexd/mnt/iOS_24A434')).toBe(true);
    expect(isPseudoMount('/Library/Developer/CoreSimulator/Volumes/iOS_23F77')).toBe(true);
    expect(isPseudoMount('/private/var/folders/k0/x/T/AppTranslocation/ABC')).toBe(true);
    expect(isPseudoMount('/')).toBe(false);
    expect(isPseudoMount('/System/Volumes/Data')).toBe(false);
    expect(isPseudoMount('/Volumes/External')).toBe(false);
  });
});
