import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOG_LIMITS } from '@commander/contracts';
import type { LogsChunkPayload } from '@commander/contracts';
import { createLogger } from './logger.js';
import { LogsTail } from './logs-tail.js';
import type { LogProc, LogsTailDeps } from './logs-tail.js';
import { PolicySchema } from './policy.js';

const CID = '123e4567-e89b-42d3-a456-426614174000';
const posix = process.platform !== 'win32';

class FakeProc implements LogProc {
  out: Array<(b: Buffer) => void> = [];
  err: Array<(b: Buffer) => void> = [];
  exit: Array<(c: number | null) => void> = [];
  killed = false;
  onStdout(cb: (b: Buffer) => void): void {
    this.out.push(cb);
  }
  onStderr(cb: (b: Buffer) => void): void {
    this.err.push(cb);
  }
  onExit(cb: (c: number | null) => void): void {
    this.exit.push(cb);
  }
  kill(): void {
    this.killed = true;
  }
  emit(text: string): void {
    for (const f of this.out) f(Buffer.from(text));
  }
  finish(code = 0): void {
    for (const f of this.exit) f(code);
  }
}

interface Rig {
  tail: LogsTail;
  chunks: LogsChunkPayload[];
  spawns: Array<{ bin: string; args: string[]; proc: FakeProc }>;
  runs: Array<{ bin: string; args: string[] }>;
  accept: { value: boolean };
}

function rig(over: Partial<LogsTailDeps> & { remote?: Record<string, unknown>; lists?: Record<string, { code: number; stdout: string }> } = {}): Rig {
  const chunks: LogsChunkPayload[] = [];
  const spawns: Rig['spawns'] = [];
  const runs: Rig['runs'] = [];
  const accept = { value: true };
  const lists = over.lists ?? { docker: { code: 0, stdout: 'web-1\napi\n' }, system: { code: 0, stdout: 'nginx.service loaded active running x\n' }, user: { code: 0, stdout: 'my.service loaded active running y\n' } };
  const policy = PolicySchema.parse({ remote: { enabled: true, ...(over.remote ?? {}) } });
  const deps: LogsTailDeps = {
    log: createLogger({ write: () => undefined }),
    send: (p) => {
      if (!accept.value) return false;
      chunks.push(p);
      return true;
    },
    policy: () => policy,
    bin: (n) => `/usr/bin/${n}`,
    run: async (bin, args) => {
      runs.push({ bin, args });
      if (bin.endsWith('docker')) return lists['docker']!;
      return args.includes('--user') ? lists['user']! : lists['system']!;
    },
    spawn: (bin, args) => {
      const proc = new FakeProc();
      spawns.push({ bin, args, proc });
      return proc;
    },
    platform: 'linux',
    home: '/home/test',
    backpressureWaitMs: 200,
    ...over,
  };
  return { tail: new LogsTail(deps), chunks, spawns, runs, accept };
}

const linesOf = (chunks: LogsChunkPayload[]): string[] => chunks.flatMap((c) => c.lines);

describe('LogsTail: docker', () => {
  it('snapshot: argumentlar massivi (`--` bilan), qatorlar chunk\'lar bilan, done va natija', async () => {
    const r = rig();
    const p = r.tail.tail(CID, { source: 'docker', name: 'web-1', lines: 50 });
    await vi.waitFor(() => expect(r.spawns.length).toBe(1));
    expect(r.runs[0]!.args).toEqual(['ps', '-a', '--format', '{{.Names}}']);
    expect(r.spawns[0]!.args).toEqual(['logs', '--tail', '50', '--', 'web-1']);
    r.spawns[0]!.proc.emit('line one\nline two\n');
    r.spawns[0]!.proc.finish(0);
    const out = await p;
    expect(out).toMatchObject({ ok: true });
    expect(linesOf(r.chunks)).toEqual(['line one', 'line two']);
    expect(r.chunks.at(-1)).toMatchObject({ done: true, reason: 'complete', commandId: CID });
    expect(r.chunks.map((c) => c.seq)).toEqual([0, 1]);
    expect(r.tail.activeCount).toBe(0);
  });

  it('ro\'yxatda yo\'q nom (bayroq/in\'ektsiya) hech qachon spawn qilinmaydi', async () => {
    const r = rig();
    for (const name of ['--help', '-f', 'web-1 --follow', 'web-1; id', '../web-1', 'WEB-1']) {
      const out = await r.tail.tail(CID, { source: 'docker', name, lines: 5 });
      expect(out, name).toMatchObject({ ok: false, code: 'logs_not_found' });
    }
    expect(r.spawns.length).toBe(0);
  });

  it('docker yo\'q / daemon javob bermaydi', async () => {
    expect(await rig({ bin: () => undefined }).tail.tail(CID, { source: 'docker', name: 'a', lines: 5 })).toMatchObject({ ok: false, code: 'logs_source_unavailable' });
    const r = rig({ lists: { docker: { code: 1, stdout: '' }, system: { code: 1, stdout: '' }, user: { code: 1, stdout: '' } } });
    expect(await r.tail.tail(CID, { source: 'docker', name: 'a', lines: 5 })).toMatchObject({ ok: false, code: 'logs_source_unavailable' });
  });

  it('since: docker\'ga ISO sifatida beriladi; follow bayrog\'i', async () => {
    const r = rig({ now: () => Date.parse('2026-11-14T12:00:00Z') });
    const p = r.tail.tail(CID, { source: 'docker', name: 'api', lines: 10, since: '10m', follow: true });
    const out = await p;
    expect(out).toMatchObject({ ok: true, result: { detail: 'follow started' } });
    expect(r.spawns[0]!.args).toEqual(['logs', '--tail', '10', '--since', '2026-11-14T11:50:00.000Z', '--follow', '--', 'api']);
    r.tail.stopAll();
  });

  it('chiqish redakt qilinadi (sir chunk\'ga tushmaydi)', async () => {
    const r = rig();
    const p = r.tail.tail(CID, { source: 'docker', name: 'api', lines: 10 });
    await vi.waitFor(() => expect(r.spawns.length).toBe(1));
    r.spawns[0]!.proc.emit('Authorization: Bearer abcdef0123456789abcdef\npassword=hunter22 ok\nGITHUB=ghp_' + 'b'.repeat(30) + '\n');
    r.spawns[0]!.proc.finish(0);
    await p;
    expect(linesOf(r.chunks).join('\n')).not.toMatch(/abcdef0123456789|hunter22|ghp_b{30}/);
  });

  it('snapshot 256 KB bilan cheklanadi: oxirgi qismi qoladi, truncated bayrog\'i', async () => {
    const r = rig();
    const p = r.tail.tail(CID, { source: 'docker', name: 'api', lines: 2000 });
    await vi.waitFor(() => expect(r.spawns.length).toBe(1));
    const big = Array.from({ length: 2000 }, (_, i) => `${String(i).padStart(4, '0')} ${'x'.repeat(995)}`).join('\n') + '\n';
    r.spawns[0]!.proc.emit(big);
    r.spawns[0]!.proc.finish(0);
    const out = await p;
    expect(out).toMatchObject({ ok: true });
    const all = linesOf(r.chunks);
    const bytes = all.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0);
    expect(bytes).toBeLessThanOrEqual(LOG_LIMITS.maxSnapshotBytes);
    expect(all.at(-1)!.startsWith('1999 ')).toBe(true);
    expect(all[0]!.startsWith('0000 ')).toBe(false);
    expect(r.chunks[0]!.truncated).toBe(true);
    for (const c of r.chunks) {
      expect(c.lines.length).toBeLessThanOrEqual(LOG_LIMITS.chunkMaxLines);
      expect(Buffer.byteLength(JSON.stringify(c))).toBeLessThan(256 * 1024);
    }
  });

  it('nolga teng chiqish bilan xato: logs_failed + done(error)', async () => {
    const r = rig();
    const p = r.tail.tail(CID, { source: 'docker', name: 'api', lines: 10 });
    await vi.waitFor(() => expect(r.spawns.length).toBe(1));
    r.spawns[0]!.proc.finish(1);
    expect(await p).toMatchObject({ ok: false, code: 'logs_failed' });
    expect(r.chunks.at(-1)).toMatchObject({ done: true, reason: 'error', error: { code: 'logs_failed' } });
  });

  it('snapshot muddati: qatorlar bo\'lsa ok(timeout), bo\'lmasa xato; jarayon o\'ldiriladi', async () => {
    vi.useFakeTimers();
    try {
      const r = rig();
      const p = r.tail.tail(CID, { source: 'docker', name: 'api', lines: 10 });
      await vi.advanceTimersByTimeAsync(10);
      r.spawns[0]!.proc.emit('only line\n');
      await vi.advanceTimersByTimeAsync(LOG_LIMITS.snapshotTimeoutMs + 100);
      expect(await p).toMatchObject({ ok: true });
      expect(r.spawns[0]!.proc.killed).toBe(true);
      expect(r.chunks.at(-1)).toMatchObject({ done: true, reason: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('LogsTail: follow', () => {
  it('10 daqiqadan keyin done(timeout) va jarayon o\'ldiriladi', async () => {
    vi.useFakeTimers();
    try {
      const r = rig();
      const out = await r.tail.tail(CID, { source: 'docker', name: 'api', lines: 10, follow: true });
      expect(out).toMatchObject({ ok: true });
      expect(r.tail.activeCount).toBe(1);
      r.spawns[0]!.proc.emit('a\n');
      await vi.advanceTimersByTimeAsync(LOG_LIMITS.followFlushMs + 10);
      expect(linesOf(r.chunks)).toEqual(['a']);
      await vi.advanceTimersByTimeAsync(LOG_LIMITS.followMaxMs);
      expect(r.chunks.at(-1)).toMatchObject({ done: true, reason: 'timeout' });
      expect(r.spawns[0]!.proc.killed).toBe(true);
      expect(r.tail.activeCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop(): done(stopped), qolgan qatorlar yuboriladi', async () => {
    const r = rig();
    await r.tail.tail(CID, { source: 'docker', name: 'api', lines: 10, follow: true });
    r.spawns[0]!.proc.emit('x\ny\n');
    r.tail.stop(CID);
    await vi.waitFor(() => expect(r.chunks.at(-1)?.done).toBe(true));
    expect(linesOf(r.chunks)).toEqual(['x', 'y']);
    expect(r.chunks.at(-1)).toMatchObject({ reason: 'stopped' });
    expect(r.spawns[0]!.proc.killed).toBe(true);
  });

  it('orqa bosim: ws band bo\'lsa qatorlar tashlanadi va keyingi chunk\'da dropped hisoblanadi', async () => {
    vi.useFakeTimers();
    try {
      const r = rig();
      await r.tail.tail(CID, { source: 'docker', name: 'api', lines: 10, follow: true });
      r.accept.value = false;
      r.spawns[0]!.proc.emit('lost1\nlost2\nlost3\n');
      await vi.advanceTimersByTimeAsync(LOG_LIMITS.followFlushMs + 10);
      expect(r.chunks.length).toBe(0);
      r.accept.value = true;
      r.spawns[0]!.proc.emit('kept\n');
      await vi.advanceTimersByTimeAsync(LOG_LIMITS.followFlushMs + 10);
      expect(linesOf(r.chunks)).toEqual(['kept']);
      expect(r.chunks[0]!.dropped).toBe(3);
      r.tail.stopAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it('follow navbati chegaralangan: juda ko\'p qator kelsa eskilari tashlanadi', async () => {
    vi.useFakeTimers();
    try {
      const r = rig();
      await r.tail.tail(CID, { source: 'docker', name: 'api', lines: 10, follow: true });
      r.accept.value = false;
      for (let i = 0; i < 20; i++) r.spawns[0]!.proc.emit(Array.from({ length: 100 }, (_, j) => `l${i}-${j}`).join('\n') + '\n');
      r.accept.value = true;
      await vi.advanceTimersByTimeAsync(LOG_LIMITS.followFlushMs + 10);
      const sent = linesOf(r.chunks);
      expect(sent.length).toBeLessThanOrEqual(LOG_LIMITS.chunkMaxLines * 5);
      expect(sent.at(-1)).toBe('l19-99');
      expect(r.chunks[0]!.dropped ?? 0).toBeGreaterThan(0);
      r.tail.stopAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it('follow hajm chegarasi (8 MB): done(byte_cap)', async () => {
    const r = rig();
    await r.tail.tail(CID, { source: 'docker', name: 'api', lines: 10, follow: true });
    const line = 'y'.repeat(1900);
    const block = Array.from({ length: 500 }, () => line).join('\n') + '\n';
    for (let i = 0; i < 12 && r.tail.activeCount > 0; i++) r.spawns[0]!.proc.emit(block);
    await vi.waitFor(() => expect(r.chunks.at(-1)?.done).toBe(true));
    expect(r.chunks.at(-1)).toMatchObject({ reason: 'byte_cap' });
    expect(r.spawns[0]!.proc.killed).toBe(true);
  });

  it('bir vaqtdagi oqimlar chegarasi: logs_busy', async () => {
    const r = rig();
    for (let i = 0; i < LOG_LIMITS.maxStreamsPerAgent; i++) {
      expect(await r.tail.tail(`123e4567-e89b-42d3-a456-42661417400${i}`, { source: 'docker', name: 'api', lines: 5, follow: true })).toMatchObject({ ok: true });
    }
    expect(await r.tail.tail(CID, { source: 'docker', name: 'api', lines: 5, follow: true })).toMatchObject({ ok: false, code: 'logs_busy' });
    r.tail.stopAll();
  });

  it('bir xil commandId qayta ishga tushmaydi', async () => {
    const r = rig();
    await r.tail.tail(CID, { source: 'docker', name: 'api', lines: 5, follow: true });
    expect(await r.tail.tail(CID, { source: 'docker', name: 'api', lines: 5, follow: true })).toMatchObject({ ok: false, code: 'logs_busy' });
    r.tail.stopAll();
  });
});

describe('LogsTail: siyosat va journal', () => {
  it('allowLogs=false -> action_not_allowed, hech narsa ishga tushmaydi', async () => {
    const r = rig({ remote: { allowLogs: false } });
    expect(await r.tail.tail(CID, { source: 'docker', name: 'api', lines: 5 })).toMatchObject({ ok: false, code: 'action_not_allowed' });
    expect(r.runs.length + r.spawns.length).toBe(0);
  });

  it('journal: unit ro\'yxatdan (system), `--unit=` shakli', async () => {
    const r = rig();
    const p = r.tail.tail(CID, { source: 'journal', name: 'nginx', lines: 100 });
    await vi.waitFor(() => expect(r.spawns.length).toBe(1));
    expect(r.spawns[0]!.args).toEqual(['--unit=nginx.service', '-n', '100', '--no-pager', '-o', 'short-iso']);
    r.spawns[0]!.proc.emit('Nov 14 x\n');
    r.spawns[0]!.proc.finish(0);
    expect(await p).toMatchObject({ ok: true });
  });

  it('journal: user unit `--user` bilan; ro\'yxatda yo\'q unit rad', async () => {
    const r = rig();
    const p = r.tail.tail(CID, { source: 'journal', name: 'my.service', lines: 5, follow: true });
    expect(await p).toMatchObject({ ok: true });
    expect(r.spawns[0]!.args.slice(0, 2)).toEqual(['--user', '--unit=my.service']);
    r.tail.stopAll();
    expect(await r.tail.tail('223e4567-e89b-42d3-a456-426614174001', { source: 'journal', name: '--user', lines: 5 })).toMatchObject({ ok: false, code: 'logs_not_found' });
    expect(await r.tail.tail('223e4567-e89b-42d3-a456-426614174002', { source: 'journal', name: 'ssh', lines: 5 })).toMatchObject({ ok: false, code: 'logs_not_found' });
  });

  it('journal macOS\'da mavjud emas', async () => {
    const r = rig({ platform: 'darwin' });
    expect(await r.tail.tail(CID, { source: 'journal', name: 'nginx', lines: 5 })).toMatchObject({ ok: false, code: 'logs_source_unavailable' });
  });
});

describe('LogsTail: fayl', () => {
  let dir: string;
  let root: string;
  let outside: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'cmdr-logfile-'));
    root = path.join(dir, 'logs');
    outside = path.join(dir, 'outside');
    mkdirSync(root);
    mkdirSync(outside);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const fileRig = (extra: Record<string, unknown> = {}): Rig => rig({ remote: { allowedLogRoots: [root], ...extra }, sensitive: [], filePollMs: 20 });

  it('oxirgi N qator', async () => {
    const f = path.join(root, 'app.log');
    writeFileSync(f, Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n') + '\n');
    const r = fileRig();
    expect(await r.tail.tail(CID, { source: 'file', name: f, lines: 3 })).toMatchObject({ ok: true });
    expect(linesOf(r.chunks)).toEqual(['line 47', 'line 48', 'line 49']);
    expect(r.chunks.at(-1)).toMatchObject({ done: true, reason: 'complete' });
  });

  it('ildizlar bo\'sh bo\'lsa rad; ildizdan tashqari fayl rad; hech narsa o\'qilmaydi', async () => {
    const f = path.join(outside, 'x.log');
    writeFileSync(f, 'secret\n');
    expect(await fileRig().tail.tail(CID, { source: 'file', name: f, lines: 3 })).toMatchObject({ ok: false, code: 'logs_not_allowed' });
    const g = path.join(root, 'ok.log');
    writeFileSync(g, 'ok\n');
    const r = rig({ remote: {}, sensitive: [] });
    expect(await r.tail.tail(CID, { source: 'file', name: g, lines: 3 })).toMatchObject({ ok: false, code: 'logs_not_allowed' });
    expect(r.chunks.length).toBe(0);
  });

  it.runIf(posix)('symlink bilan ildizdan chiqish rad', async () => {
    const secret = path.join(outside, 'secret.log');
    writeFileSync(secret, 'TOP SECRET\n');
    symlinkSync(secret, path.join(root, 'link.log'));
    const r = fileRig();
    expect(await r.tail.tail(CID, { source: 'file', name: path.join(root, 'link.log'), lines: 3 })).toMatchObject({ ok: false, code: 'logs_not_allowed' });
    expect(linesOf(r.chunks).join('')).not.toContain('SECRET');
  });

  it('macOS standart ildizi (~/Library/Logs/commander) siyosatsiz ruxsat', async () => {
    const home = path.join(dir, 'home');
    const def = path.join(home, 'Library', 'Logs', 'commander');
    mkdirSync(def, { recursive: true });
    const f = path.join(def, 'agentd.log');
    writeFileSync(f, 'hello\n');
    const r = rig({ remote: {}, sensitive: [], home, platform: 'darwin' });
    expect(await r.tail.tail(CID, { source: 'file', name: f, lines: 3 })).toMatchObject({ ok: true });
    expect(linesOf(r.chunks)).toEqual(['hello']);
  });

  it('follow: qo\'shilgan qatorlar oqadi; fayl qirqilsa boshidan davom etadi', async () => {
    const f = path.join(root, 'live.log');
    writeFileSync(f, 'old\n');
    const r = fileRig();
    expect(await r.tail.tail(CID, { source: 'file', name: f, lines: 5, follow: true })).toMatchObject({ ok: true });
    appendFileSync(f, 'new1\nnew2\n');
    await vi.waitFor(() => expect(linesOf(r.chunks)).toEqual(['old', 'new1', 'new2']), { timeout: 5000 });
    writeFileSync(f, 'again\n'); // qirqildi
    await vi.waitFor(() => expect(linesOf(r.chunks).at(-1)).toBe('again'), { timeout: 5000 });
    r.tail.stop(CID);
    await vi.waitFor(() => expect(r.chunks.at(-1)?.done).toBe(true));
  });

  it('redaksiya fayl satrlarida ham', async () => {
    const f = path.join(root, 's.log');
    writeFileSync(f, 'api_key=sk-' + 'z'.repeat(30) + '\n');
    const r = fileRig();
    await r.tail.tail(CID, { source: 'file', name: f, lines: 3 });
    expect(linesOf(r.chunks).join('')).not.toContain('zzzzzzzzzz');
  });
});
