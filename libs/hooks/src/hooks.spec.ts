import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { renderPermissionOutput, resolveDeadlineMs, runCcHook } from './cc-hook-lib.js';
import { resolveCommand, runCcStatusline } from './cc-statusline-lib.js';

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'cch-'));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

function input(text: string): PassThrough {
  const s = new PassThrough();
  s.end(text);
  return s;
}

function fakeAgentd(path: string, reply: string): { received: string[]; server: Server } {
  const received: string[] = [];
  const server = createServer((sock) => {
    let buf = '';
    sock.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      if (buf.includes('\n')) {
        received.push(buf.trim());
        sock.end(reply + '\n');
      }
    });
    sock.on('error', () => undefined);
  });
  server.listen(path);
  cleanups.push(() => server.close());
  return { received, server };
}

const HOOK = JSON.stringify({ hook_event_name: 'Stop', session_id: 'zz', cwd: '/x' });

describe('cc-hook fail-safe', () => {
  it("socket yo'q: tez chiqadi (exit 0), stdout bo'sh", async () => {
    const out: string[] = [];
    const t0 = Date.now();
    const code = await runCcHook([], { stdin: input(HOOK), stdout: { write: (s) => out.push(s) }, env: {}, socketPath: join(tmp(), 'yoq.sock') });
    expect(code).toBe(0);
    expect(out).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it("noto'g'ri JSON, bo'sh stdin: jim, exit 0", async () => {
    const out: string[] = [];
    for (const text of ['not json', '']) {
      expect(await runCcHook([], { stdin: input(text), stdout: { write: (s) => out.push(s) }, env: {}, socketPath: join(tmp(), 'x.sock') })).toBe(0);
    }
    expect(out).toEqual([]);
  });

  it("agentd javob bermasa ham muddatda tugaydi", async () => {
    const path = join(tmp(), 's.sock');
    const server = createServer(() => undefined); // ulanadi, hech narsa qaytarmaydi
    server.listen(path);
    cleanups.push(() => server.close());
    const t0 = Date.now();
    expect(await runCcHook([], { stdin: input(HOOK), stdout: { write: () => undefined }, env: {}, socketPath: path })).toBe(0);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("hook JSON'ini socketga to'g'ri konvertda yuboradi; status rejimida stdout bo'sh", async () => {
    const path = join(tmp(), 's.sock');
    const { received } = fakeAgentd(path, '{"ok":true}');
    const out: string[] = [];
    await runCcHook([], { stdin: input(HOOK), stdout: { write: (s) => out.push(s) }, env: {}, socketPath: path });
    await new Promise((r) => setTimeout(r, 50));
    expect(JSON.parse(received[0]!)).toEqual({ v: 1, kind: 'hook', payload: JSON.parse(HOOK) });
    expect(out).toEqual([]);
  });

  it('PermissionRequest chiqish sxemasi: allow/deny aynan hujjatdagi shaklda; qo\'shimcha maydonlar o\'tmaydi', () => {
    expect(JSON.parse(renderPermissionOutput({ ok: true, decision: { behavior: 'allow', updatedInput: { x: 1 }, updatedPermissions: [1] } })!)).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
    expect(JSON.parse(renderPermissionOutput({ ok: true, decision: { behavior: 'deny', message: 'yo\'q', interrupt: true } })!)).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'yo\'q' } },
    });
    expect(JSON.parse(renderPermissionOutput({ ok: true, decision: { behavior: 'deny' } })!).hookSpecificOutput.decision.message).toBeTruthy();
  });

  it("verdikt -> chiqish: har qanday xato/noaniq javobda chiqish YO'Q (hech qachon allow emas)", () => {
    const bad: unknown[] = [
      null, undefined, true, 'allow', 42, [], {},
      { ok: true }, { ok: true, decision: null }, { ok: true, decision: 'allow' }, { ok: true, decision: {} },
      { ok: false, decision: { behavior: 'allow' } }, { decision: { behavior: 'allow' } },
      { ok: true, decision: { behavior: 'ALLOW' } }, { ok: true, decision: { behavior: 'ask' } }, { ok: true, decision: { behavior: ['allow'] } },
      { ok: 'true', decision: { behavior: 'allow' } }, { ok: true, behavior: 'allow' }, { decision: 'allow', behavior: 'allow' },
    ];
    for (const r of bad) expect(renderPermissionOutput(r)).toBeNull();
  });

  it('--permission: allow va deny agentd javobidan stdout\'ga chiqadi; deadline agentd\'ga uzatiladi', async () => {
    const path = join(tmp(), 's.sock');
    const { received } = fakeAgentd(path, JSON.stringify({ ok: true, decision: { behavior: 'allow' } }));
    const out: string[] = [];
    expect(await runCcHook(['--permission', '--deadline-ms=45000'], { stdin: input(HOOK), stdout: { write: (s) => out.push(s) }, env: {}, socketPath: path })).toBe(0);
    expect(JSON.parse(out.join(''))).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
    expect(JSON.parse(received[0]!)).toMatchObject({ v: 1, kind: 'permission', deadlineMs: 45000, payload: JSON.parse(HOOK) });

    const path2 = join(tmp(), 's2.sock');
    fakeAgentd(path2, JSON.stringify({ ok: true, decision: { behavior: 'deny', message: 'xavfli' } }));
    const out2: string[] = [];
    await runCcHook(['--permission'], { stdin: input(HOOK), stdout: { write: (s) => out2.push(s) }, env: {}, socketPath: path2 });
    expect(JSON.parse(out2.join('')).hookSpecificOutput.decision).toEqual({ behavior: 'deny', message: 'xavfli' });
  });

  it("--permission: agentd yo'q / null qaror / buzuq javob / uzilish => stdout bo'sh, exit 0, TEZ", async () => {
    for (const reply of ['{"ok":true,"decision":null,"reason":"expired"}', 'not json', '{"ok":false}', '']) {
      const path = join(tmp(), 'x.sock');
      fakeAgentd(path, reply);
      const out: string[] = [];
      expect(await runCcHook(['--permission'], { stdin: input(HOOK), stdout: { write: (s) => out.push(s) }, env: {}, socketPath: path })).toBe(0);
      expect(out).toEqual([]);
    }
    const out: string[] = [];
    const t0 = Date.now();
    expect(await runCcHook(['--permission'], { stdin: input(HOOK), stdout: { write: (s) => out.push(s) }, env: {}, socketPath: join(tmp(), 'yoq.sock') })).toBe(0);
    expect(out).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(500);
    // buzuq stdin
    expect(await runCcHook(['--permission'], { stdin: input('{'), stdout: { write: (s) => out.push(s) }, env: {}, socketPath: join(tmp(), 'yoq.sock') })).toBe(0);
    expect(out).toEqual([]);
  });

  it("--permission: agentd qotib qolsa ham deadline + slack dan keyin chiqadi (osilmaydi)", async () => {
    const path = join(tmp(), 's.sock');
    const server = createServer(() => undefined); // ulanadi, hech narsa yozmaydi
    server.listen(path);
    cleanups.push(() => server.close());
    const out: string[] = [];
    const t0 = Date.now();
    expect(await runCcHook(['--permission', '--deadline-ms=1000'], { stdin: input(HOOK), stdout: { write: (s) => out.push(s) }, env: {}, socketPath: path })).toBe(0);
    const dt = Date.now() - t0;
    expect(out).toEqual([]);
    expect(dt).toBeGreaterThanOrEqual(900);
    expect(dt).toBeLessThan(3800);
  });

  it('resolveDeadlineMs: argv > env > sukut, chegaralangan', () => {
    expect(resolveDeadlineMs([], {})).toBe(300_000);
    expect(resolveDeadlineMs([], { COMMANDER_PERMISSION_DEADLINE_MS: '60000' })).toBe(60_000);
    expect(resolveDeadlineMs(['--deadline-ms=5000'], { COMMANDER_PERMISSION_DEADLINE_MS: '60000' })).toBe(5000);
    expect(resolveDeadlineMs(['--deadline-ms=1'], {})).toBe(1000);
    expect(resolveDeadlineMs(['--deadline-ms=99999999'], {})).toBe(900_000);
    expect(resolveDeadlineMs(['--deadline-ms=abc'], {})).toBe(300_000);
  });

  const dist = new URL('../dist/cc-hook.js', import.meta.url).pathname;
  it.skipIf(!existsSync(dist))("haqiqiy jarayon: socket yo'q => exit 0, stdout/stderr bo'sh, tez", () => {
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [dist], { input: HOOK, env: { ...process.env, COMMANDER_SOCKET: join(tmp(), 'yoq.sock') }, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
    expect(Date.now() - t0).toBeLessThan(1500);
  });
});

describe('cc-statusline', () => {
  const SL = JSON.stringify({ session_id: 'zz', rate_limits: { seven_day: { used_percentage: 1, resets_at: 1800000000 } } });

  it("buyruq manbasi ustuvorligi: argv > env > config", () => {
    expect(resolveCommand(['a', 'b'], { COMMANDER_STATUSLINE_CMD: 'env' }, () => 'cfg')).toBe('a b');
    expect(resolveCommand([], { COMMANDER_STATUSLINE_CMD: 'env' }, () => 'cfg')).toBe('env');
    expect(resolveCommand([], {}, () => 'cfg')).toBe('cfg');
    expect(resolveCommand([], {}, () => undefined)).toBeUndefined();
  });

  it("agentd'ga yuboradi va foydalanuvchi buyrug'ini shu stdin bilan ishga tushiradi (socket yo'q bo'lsa ham)", async () => {
    const dir = tmp();
    const path = join(dir, 's.sock');
    const { received } = fakeAgentd(path, '{"ok":true}');
    const marker = join(dir, 'seen.txt');
    const code = await runCcStatusline([`cat > ${marker}; exit 3`], { stdin: input(SL), env: process.env, socketPath: path, readConfig: () => undefined });
    expect(code).toBe(3); // bola exit kodi o'zgarmaydi
    expect(JSON.parse(received[0]!)).toMatchObject({ v: 1, kind: 'statusline', payload: { session_id: 'zz' } });
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(marker, 'utf8')).toBe(SL); // stdin aynan o'tdi

    const code2 = await runCcStatusline(['true'], { stdin: input(SL), env: process.env, socketPath: join(dir, 'yoq.sock'), readConfig: () => undefined });
    expect(code2).toBe(0);
  });

  it("chiqish o'zgarmaydi (haqiqiy jarayon)", () => {
    const d = new URL('../dist/cc-statusline.js', import.meta.url).pathname;
    if (!existsSync(d)) return;
    const r = spawnSync(process.execPath, [d, 'printf "LINE1\\nLINE2"'], { input: SL, env: { ...process.env, COMMANDER_SOCKET: join(tmp(), 'yoq.sock') }, encoding: 'utf8' });
    expect(r.stdout).toBe('LINE1\nLINE2');
    expect(r.status).toBe(0);
  });
});

describe('AskUserQuestion javobi (6.13)', () => {
  const toolInput = {
    questions: [
      { question: 'Which color?', header: 'Color', options: [{ label: 'Red (Recommended)', description: 'r' }, { label: 'Blue', description: 'b' }], multiSelect: false },
      { question: 'Which toppings?', header: 'Toppings', options: [{ label: 'Cheese' }, { label: 'Ham' }, { label: 'Olives' }], multiSelect: true },
    ],
  };
  const payload = { hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion', tool_input: toolInput };
  const allow = (answers: unknown) => ({ ok: true, decision: { behavior: 'allow', answers } });

  it('indekslarni ASL savol/yorliqlarga moslab updatedInput.answers yasaydi (multiSelect "A, B", erkin matn)', () => {
    const out = JSON.parse(
      renderPermissionOutput(allow([{ q: 1, picks: [2, 0], other: ' Pepperoni ' }, { q: 0, picks: [0] }]), payload)!,
    ) as { hookSpecificOutput: { decision: { behavior: string; updatedInput: Record<string, unknown> } } };
    expect(out.hookSpecificOutput.decision.behavior).toBe('allow');
    expect(out.hookSpecificOutput.decision.updatedInput).toEqual({
      ...toolInput,
      answers: { 'Which color?': 'Red (Recommended)', 'Which toppings?': 'Cheese, Olives, Pepperoni' },
    });
  });

  it('erkin matn bir tanlovli savolga javob bo\'la oladi', () => {
    const out = JSON.parse(renderPermissionOutput(allow([{ q: 0, picks: [], other: 'Green' }, { q: 1, picks: [1] }]), payload)!);
    expect(out.hookSpecificOutput.decision.updatedInput.answers).toEqual({ 'Which color?': 'Green', 'Which toppings?': 'Ham' });
  });

  it('javobsiz yoki noto\'g\'ri `allow` = chiqish yo\'q (lokal dialog); hech qachon jim allow emas', () => {
    expect(renderPermissionOutput({ ok: true, decision: { behavior: 'allow' } }, payload)).toBeNull();
    expect(renderPermissionOutput(allow([]), payload)).toBeNull();
    expect(renderPermissionOutput(allow([{ q: 0, picks: [0] }]), payload)).toBeNull(); // 2-savol javobsiz
    expect(renderPermissionOutput(allow([{ q: 0, picks: [9] }, { q: 1, picks: [0] }]), payload)).toBeNull();
    expect(renderPermissionOutput(allow([{ q: 0, picks: [0, 1] }, { q: 1, picks: [0] }]), payload)).toBeNull(); // bir tanlovli: 2 ta
    expect(renderPermissionOutput(allow([{ q: 0, picks: [0] }, { q: 0, picks: [1] }]), payload)).toBeNull();
    expect(renderPermissionOutput(allow([{ q: 0, picks: [0] }, { q: 1, picks: [0, 0] }]), payload)).toBeNull();
    expect(renderPermissionOutput(allow([{ q: 0, picks: [0] }, { q: 1, picks: [] }]), payload)).toBeNull();
    expect(renderPermissionOutput(allow([{ q: 0, picks: [0] }, { q: 1, picks: [0] }]), { ...payload, tool_input: { questions: 'x' } })).toBeNull();
  });

  it('bir xil savol matnli ikki savol (kalit noaniq) = chiqish yo\'q', () => {
    const dup = { ...payload, tool_input: { questions: [toolInput.questions[0], toolInput.questions[0]] } };
    expect(renderPermissionOutput(allow([{ q: 0, picks: [0] }, { q: 1, picks: [0] }]), dup)).toBeNull();
  });

  it('deny AskUserQuestion uchun ham oddiy ishlaydi; boshqa vosita uchun answers e\'tiborsiz', () => {
    const deny = JSON.parse(renderPermissionOutput({ ok: true, decision: { behavior: 'deny', message: 'yo\'q' } }, payload)!);
    expect(deny.hookSpecificOutput.decision).toEqual({ behavior: 'deny', message: 'yo\'q' });
    const other = JSON.parse(renderPermissionOutput(allow([{ q: 0, picks: [0] }]), { tool_name: 'Bash', tool_input: { command: 'ls' } })!);
    expect(other.hookSpecificOutput.decision).toEqual({ behavior: 'allow' });
  });
});
