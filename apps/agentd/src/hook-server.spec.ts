import { createConnection } from 'node:net';
import { statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tmpHome } from '../test/helpers.js';
import { HookServer } from './hook-server.js';
import { silentLogger } from './logger.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

function ask(path: string, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = createConnection(path);
    let out = '';
    c.on('connect', () => c.end(text));
    c.on('data', (d: Buffer) => (out += d.toString('utf8')));
    c.on('close', () => resolve(out));
    c.on('error', reject);
  });
}

async function start() {
  const h = tmpHome();
  cleanups.push(h.cleanup);
  const calls: Array<[string, unknown]> = [];
  const path = join(h.dir, 'agentd.sock');
  const server = new HookServer(
    path,
    { onHook: (p) => void calls.push(['hook', p]), onStatusline: (p) => void calls.push(['statusline', p]), onPermission: (_p, _d, c) => c.reply({ ok: true, decision: null }), status: () => ({ up: true }) },
    silentLogger,
  );
  await server.start();
  cleanups.unshift(() => server.stop());
  return { path, calls, server, dir: h.dir };
}

describe('HookServer', () => {
  it("socket 0600; hook/statusline/status so'rovlariga javob beradi", async () => {
    const { path, calls } = await start();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await ask(path, JSON.stringify({ v: 1, kind: 'hook', payload: { a: 1 } }) + '\n'))).toEqual({ ok: true });
    expect(JSON.parse(await ask(path, JSON.stringify({ v: 1, kind: 'statusline', payload: { b: 2 } })))).toEqual({ ok: true }); // yangi qatorsiz (end bilan)
    expect(JSON.parse(await ask(path, JSON.stringify({ v: 1, kind: 'status' }) + '\n'))).toEqual({ ok: true, status: { up: true } });
    expect(calls).toEqual([
      ['hook', { a: 1 }],
      ['statusline', { b: 2 }],
    ]);
  });

  it("yaroqsiz so'rov bad_request, handler chaqirilmaydi", async () => {
    const { path, calls } = await start();
    expect(JSON.parse(await ask(path, 'not json\n'))).toEqual({ ok: false, error: 'bad_request' });
    expect(JSON.parse(await ask(path, JSON.stringify({ v: 1, kind: 'nope' }) + '\n'))).toEqual({ ok: false, error: 'bad_request' });
    expect(calls).toHaveLength(0);
  });

  it("eskirgan (o'lik) socket fayli o'chirilib qayta ochiladi; ishlayotgani bor bo'lsa rad etadi", async () => {
    const { path, server, dir } = await start();
    const second = new HookServer(path, { onHook: () => undefined, onStatusline: () => undefined, onPermission: () => undefined, status: () => ({}) }, silentLogger);
    await expect(second.start()).rejects.toThrow(/allaqachon ishlayapti/);
    await server.stop();
    writeFileSync(join(dir, 'agentd.sock'), ''); // qolgan oddiy fayl (o'lik socket o'rnida)
    const third = new HookServer(path, { onHook: () => undefined, onStatusline: () => undefined, onPermission: () => undefined, status: () => ({ ok: 1 }) }, silentLogger);
    await third.start();
    cleanups.unshift(() => third.stop());
    expect(JSON.parse(await ask(path, JSON.stringify({ v: 1, kind: 'status' }) + '\n')).ok).toBe(true);
  });
});
