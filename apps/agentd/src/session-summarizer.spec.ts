import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MailboxCall, MailboxReplyPayload } from '@commander/contracts';
import { openDb } from './db.js';
import { SessionStore } from './session-store.js';
import { SessionSummarizer } from './session-summarizer.js';
import type { Logger } from './logger.js';

const log: Logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return log; } } as unknown as Logger;
const SECRET = 'sk-ant-api03-SUPERSECRETVALUE1234567890abcdef';

const line = (o: unknown): string => JSON.stringify(o);
function transcript(): string {
  const rows: string[] = [];
  for (let i = 0; i < 3; i++) {
    rows.push(line({ type: 'user', uuid: `u${i}`, message: { content: `So'rov ${i}` } }));
    rows.push(line({ type: 'assistant', uuid: `a${i}`, requestId: `r${i}`, message: { id: `m${i}`, model: 'c', content: [{ type: 'text', text: `Javob ${i}` }, { type: 'tool_use', id: `t${i}`, name: 'Edit', input: { file_path: `src/f${i}.ts`, old_string: 'a', new_string: 'b' } }], usage: { input_tokens: 5000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }));
  }
  return rows.join('\n') + '\n';
}

const haikuOut = (text: string): string => JSON.stringify([{ type: 'system', model: 'claude-haiku-5' }, { type: 'result', is_error: false, result: text, usage: { input_tokens: 1200, output_tokens: 150 } }]);
const GOOD = haikuOut(`{"summary":"Login tuzatildi. Kalit ${SECRET} topildi.","done":["fix"],"files":["src/f0.ts"],"open_items":[],"decisions":[]}`);

let dir: string;
let now: number;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'summ-'));
  now = 1_800_000_000_000;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function setup(opts: { check?: MailboxReplyPayload | ((c: MailboxCall) => MailboxReplyPayload); exec?: (args: string[]) => Promise<string>; enabled?: boolean } = {}) {
  const db = openDb(':memory:');
  const store = new SessionStore(db, () => now);
  const path = join(dir, 's1.jsonl');
  writeFileSync(path, transcript());
  store.touchFromHook('s1', { cwd: '/work/api', root: '/work/api', transcriptPath: path });
  const calls: MailboxCall[] = [];
  const execs: string[][] = [];
  const reply = (data: unknown): MailboxReplyPayload => ({ reqId: 'x', ok: true, data });
  const mailbox = {
    async request(_sid: string, call: MailboxCall): Promise<MailboxReplyPayload> {
      calls.push(call);
      if (call.op === 'summary_check') {
        const c = opts.check ?? reply({ allow: true, minPrompts: 2, minTokens: 1000 });
        return typeof c === 'function' ? c(call) : c;
      }
      return reply({ stored: true, proposals: 0 });
    },
  };
  const s = new SessionSummarizer({
    db,
    store,
    mailbox,
    log,
    claudeBin: 'claude',
    dir: join(dir, 'empty'),
    enabled: () => opts.enabled ?? true,
    now: () => now,
    idleMs: 10 * 60_000,
    exec: async (args) => {
      execs.push(args);
      return (opts.exec ?? (async () => GOOD))(args);
    },
  });
  return { s, store, calls, execs, db };
}

describe('SessionSummarizer', () => {
  it('summarizes an ended session locally and sends only the redacted result (haiku flags are the safe set)', async () => {
    const { s, store, calls, execs } = setup();
    store.setStatus('s1', 'ended');
    await s.enqueue('s1');
    expect(execs).toHaveLength(1);
    const a = execs[0]!;
    expect(a).toEqual(expect.arrayContaining(['-p', '--model', 'haiku', '--tools', '', '--setting-sources', 'local', '--no-session-persistence']));
    expect(a[a.indexOf('--tools') + 1]).toBe('');
    const sent = calls.find((c) => c.op === 'session_summary');
    expect(sent).toBeDefined();
    if (sent?.op !== 'session_summary') throw new Error('unreachable');
    expect(sent.summary.trigger).toBe('ended');
    expect(sent.summary.promptCount).toBe(3);
    expect(sent.summary.tokensUsed).toBe(1350);
    expect(sent.summary.model).toBe('claude-haiku-5');
    expect(JSON.stringify(sent)).not.toContain('SUPERSECRETVALUE');
    expect(sent.summary.summary).toContain('[REDACTED]');
  });

  it('does not re-run until the transcript grows', async () => {
    const { s, store, execs } = setup();
    store.setStatus('s1', 'ended');
    await s.enqueue('s1');
    await s.enqueue('s1');
    expect(execs).toHaveLength(1);
  });

  it('skips haiku when the session is below the center thresholds', async () => {
    const { s, store, execs, calls } = setup({ check: { reqId: 'x', ok: true, data: { allow: true, minPrompts: 10, minTokens: 0 } } });
    store.setStatus('s1', 'ended');
    await s.enqueue('s1');
    expect(execs).toHaveLength(0);
    expect(calls.some((c) => c.op === 'session_summary')).toBe(false);
  });

  it('does nothing when the center forbids it (disabled / daily cap) and backs off', async () => {
    const { s, store, execs } = setup({ check: { reqId: 'x', ok: true, data: { allow: false, reason: 'daily_cap', minPrompts: 2, minTokens: 0 } } });
    store.setStatus('s1', 'ended');
    await s.enqueue('s1');
    await s.enqueue('s1'); // retryAt hali kelmagan: markazdan qayta so'ralmaydi
    expect(execs).toHaveLength(0);
  });

  it('does nothing when the center is offline (limit is saved) and when disabled locally', async () => {
    const off = setup({ check: { reqId: 'x', ok: false, error: { code: 'center_offline', message: 'x' } } });
    off.store.setStatus('s1', 'ended');
    await off.s.enqueue('s1');
    expect(off.execs).toHaveLength(0);
    const dis = setup({ enabled: false });
    dis.store.setStatus('s1', 'ended');
    await dis.s.enqueue('s1');
    await dis.s.scan();
    expect(dis.calls).toHaveLength(0);
  });

  it('keeps the result for a retry when sending failed (haiku is not run twice)', async () => {
    let fail = true;
    const { s, store, execs, calls } = setup();
    // birinchi yuborish muvaffaqiyatsiz bo'lishi uchun mailbox'ni almashtiramiz
    const orig = (s as unknown as { d: { mailbox: { request: (sid: string, c: MailboxCall) => Promise<MailboxReplyPayload> } } }).d.mailbox;
    const base = orig.request.bind(orig);
    orig.request = async (sid, c) => (c.op === 'session_summary' && fail ? { reqId: 'x', ok: false, error: { code: 'center_offline', message: 'x' } } : base(sid, c));
    store.setStatus('s1', 'ended');
    await s.enqueue('s1');
    expect(execs).toHaveLength(1);
    fail = false;
    now += 3 * 60_000; // retryAt o'tdi
    await s.enqueue('s1');
    expect(execs).toHaveLength(1);
    expect(calls.filter((c) => c.op === 'session_summary').length).toBeGreaterThanOrEqual(1);
  });

  it('idle trigger: scan picks open sessions silent for 10+ minutes but not busy ones', async () => {
    const { s, store, execs, calls } = setup();
    store.setStatus('s1', 'waiting');
    await s.scan(); // hozirgina hook keldi (now == lastHookAt): tinch emas
    expect(execs).toHaveLength(0);
    now += 11 * 60_000;
    await s.scan();
    expect(execs).toHaveLength(1);
    const sent = calls.find((c) => c.op === 'session_summary');
    if (sent?.op !== 'session_summary') throw new Error('unreachable');
    expect(sent.summary.trigger).toBe('idle');
  });

  it('a failed/garbage haiku result sends nothing', async () => {
    const { s, store, calls } = setup({ exec: async () => haikuOut('JSON emas') });
    store.setStatus('s1', 'ended');
    await s.enqueue('s1');
    expect(calls.some((c) => c.op === 'session_summary')).toBe(false);
  });
});
