import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { silentLogger } from './logger.js';
import { SessionIdentity, ancestorChain, createPeerAttestor, parseLsofUnix, parsePsParents, parseSoPeercred, peerPidsFromLsof, peerPidsFromSs } from './peer-identity.js';

describe('peer-identity: tahlil funksiyalari', () => {
  it('lsof: qabul qilingan fd ga ulangan peer egasini topadi', () => {
    const out = ['p100', 'f14', 'd0xAAA', 'n/tmp/s.sock', 'p200', 'f3', 'd0xBBB', 'n->0xAAA', 'f4', 'd0xCCC', 'n->0xDDD', 'p300', 'f5', 'd0xEEE', 'n->0xZZZ', ''].join('\n');
    const recs = parseLsofUnix(out);
    expect(peerPidsFromLsof(recs, 100, 14)).toEqual([200]);
    expect(peerPidsFromLsof(recs, 100, 99)).toEqual([]);
  });

  it('ss: peer inode orqali peer pid(lar)ni topadi', () => {
    const out = [
      'u_str ESTAB 0 0 /run/agentd.sock 5001 * 5002',
      'u_str ESTAB 0 0 * 5002 * 5001 users:(("node",pid=4242,fd=19),("sh",pid=4243,fd=19))',
      'u_str ESTAB 0 0 * 7000 * 7001 users:(("x",pid=1,fd=3))',
    ].join('\n');
    expect(peerPidsFromSs(out, '5001')).toEqual([4242, 4243]);
    expect(peerPidsFromSs(out, '9999')).toEqual([]);
  });

  it('SO_PEERCRED chiqishi (pid uid gid) tahlili', () => {
    expect(parseSoPeercred('4242 1000 1000\n')).toBe(4242);
    expect(parseSoPeercred('0 0 0\n')).toBeUndefined();
    expect(parseSoPeercred('garbage')).toBeUndefined();
    expect(parseSoPeercred('')).toBeUndefined();
  });

  it("Linux attestori: perl SO_PEERCRED birinchi; perl ishlamasa ss zaxirasi; ikkalasi ham yo'q = available:false", async () => {
    const fakeSock = { _handle: { fd: 7 } } as never;
    const ssOut = ['u_str ESTAB 0 0 /run/a.sock 11 * 12', 'u_str ESTAB 0 0 * 12 * 11 users:(("node",pid=77,fd=3))'].join('\n');
    const common = { platform: 'linux', readlink: () => 'socket:[11]', exec: async () => ssOut };
    const viaPerl = createPeerAttestor({ ...common, exists: () => true, execWithSocket: async () => '555 1000 1000\n' });
    expect(await viaPerl.peerPids(fakeSock)).toEqual([555]);
    const perlBroken = createPeerAttestor({ ...common, exists: () => true, execWithSocket: async () => Promise.reject(new Error('exit 2')) });
    expect(await perlBroken.peerPids(fakeSock)).toEqual([77]);
    const none = createPeerAttestor({ platform: 'linux', exists: () => false });
    expect(none.available).toBe(false);
    expect(createPeerAttestor({ platform: 'win32' }).available).toBe(false);
  });

  it('ps jadvali va ota-ona zanjiri (sikl/chegara xavfsiz)', () => {
    const parents = parsePsParents('  10   1\n  20  10\n  30  20\n  40  30\n  50  50\n');
    expect(ancestorChain(40, parents)).toEqual([40, 30, 20, 10]);
    expect(ancestorChain(50, parents)).toEqual([50]);
    expect(ancestorChain(999, parents)).toEqual([999]);
  });
});

describe('SessionIdentity', () => {
  const parents = new Map<number, number>([
    [11, 10],
    [10, 5],
    [21, 20],
    [20, 5],
    [31, 30],
  ]);
  const live = [
    { sessionId: 'A', pid: 10 },
    { sessionId: 'B', pid: 20 },
  ];
  const mk = (pids: number[], sessions = live, available = true) => new SessionIdentity({ attestor: { available, peerPids: async () => pids }, sessions: async () => sessions, parents: async () => parents, log: silentLogger });

  it("enforce: eng yaqin sessiya ajdodi aniqlanadi; e'lon qilingani mos bo'lishi shart", async () => {
    const id = mk([11]);
    expect(await id.verify(async () => [11], 'A')).toEqual({ ok: true, sessionId: 'A', attested: true });
    expect(await id.verify(async () => [11], undefined)).toEqual({ ok: true, sessionId: 'A', attested: true });
    expect(await id.verify(async () => [11], 'B')).toMatchObject({ ok: false });
    expect(await id.verify(async () => [31], 'A')).toMatchObject({ ok: false });
    expect(await id.verify(async () => [], 'A')).toMatchObject({ ok: false });
    expect(await id.verify(undefined, 'A')).toMatchObject({ ok: false });
  });

  it("ichma-ich sessiya: eng yaqin ajdod yutadi (ichki sessiya tashqi nomidan gapira olmaydi)", async () => {
    const nested = new SessionIdentity({
      attestor: { available: true, peerPids: async () => [101] },
      sessions: async () => [
        { sessionId: 'OUTER', pid: 100 },
        { sessionId: 'INNER', pid: 105 },
      ],
      parents: async () => new Map([[101, 105], [105, 100]]),
      log: silentLogger,
    });
    expect(await nested.verify(async () => [101], 'OUTER')).toMatchObject({ ok: false });
    expect(await nested.verify(async () => [101], 'INNER')).toMatchObject({ ok: true, sessionId: 'INNER' });
  });

  it("yangi sessiya: keshda yo'q bo'lsa yangi ro'yxat bilan qayta uriniladi", async () => {
    let calls = 0;
    const id = new SessionIdentity({
      attestor: { available: true, peerPids: async () => [11] },
      sessions: async (fresh) => {
        calls++;
        return fresh ? live : [];
      },
      parents: async () => parents,
      log: silentLogger,
    });
    expect(await id.verify(async () => [11], 'A')).toMatchObject({ ok: true });
    expect(calls).toBe(2);
  });

  it("unattested (Windows/vosita yo'q): e'lon qilingani qaytadi, mode=unattested", async () => {
    const id = mk([], live, false);
    expect(id.mode).toBe('unattested');
    expect(await id.verify(undefined, 'ANY')).toEqual({ ok: true, sessionId: 'ANY', attested: false });
  });
});

const realPlatform = process.platform === 'darwin' || process.platform === 'linux';
describe.skipIf(!realPlatform)('peer-identity: haqiqiy yadro attestatsiyasi', () => {
  it('Unix socket peer pid\'i mijoz jarayonning pid\'iga teng (e\'lon qilib bo\'lmaydi)', async () => {
    const attestor = createPeerAttestor();
    if (!attestor.available) return; // lsof/ss yo'q mashina
    const dir = mkdtempSync(join(tmpdir(), 'peer-'));
    const path = join(dir, 's.sock');
    let child: ReturnType<typeof spawn> | undefined;
    try {
      const got = await new Promise<number[]>((resolve, reject) => {
        const server = createServer((sock: Socket) => {
          attestor.peerPids(sock).then(resolve, reject).finally(() => {
            sock.destroy();
            server.close();
          });
        });
        server.listen(path, () => {
          child = spawn(process.execPath, ['-e', `const s=require('net').createConnection(${JSON.stringify(path)});s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(0),4000)`], { stdio: 'ignore' });
        });
        setTimeout(() => reject(new Error('timeout')), 8000);
      });
      expect(got).toContain(child!.pid);
      expect(got).not.toContain(process.pid);
    } finally {
      child?.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
