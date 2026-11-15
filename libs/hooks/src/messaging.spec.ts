import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { PEER_FRAME_HEADER } from '@commander/contracts';
import { renderInboxOutput, renderInboxStopOutput, runCcHook } from './cc-hook-lib.js';
import { handleMcpMessage, runMcpServer, TOOLS } from './cc-mcp-lib.js';
import type { AgentdReply, CallAgentd } from './cc-mcp-lib.js';

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'ccm-'));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}
const input = (text: string): PassThrough => {
  const s = new PassThrough();
  s.end(text);
  return s;
};

/** Soxta agentd: har so'rovni yozib oladi, `reply(req)` bilan javob beradi. */
function fakeAgentd(path: string, reply: (req: Record<string, unknown>) => unknown): { received: Array<Record<string, unknown>> } {
  const received: Array<Record<string, unknown>> = [];
  const server = createServer((sock) => {
    let buf = '';
    sock.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      if (!buf.includes('\n')) return;
      const req = JSON.parse(buf.trim()) as Record<string, unknown>;
      received.push(req);
      sock.end(JSON.stringify(reply(req)) + '\n');
    });
    sock.on('error', () => undefined);
  });
  server.listen(path);
  cleanups.push(() => server.close());
  return { received };
}

const FRAMED = `${PEER_FRAME_HEADER}\n--- #abcd1234 | backend (srv/ab12cd34) | question | 2026-11-13T10:00:00.000Z\nMavzu: Schema?\n> phone bormi?`;
const UPS = JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'sess-1', cwd: '/x', prompt: 'salom' });
const STOP = (active?: boolean): string => JSON.stringify({ hook_event_name: 'Stop', session_id: 'sess-1', cwd: '/x', ...(active === undefined ? {} : { stop_hook_active: active }) });

describe('cc-hook --inbox (UserPromptSubmit)', () => {
  it("xabar bor: additionalContext sxemasi, ramka saqlangan; agentd'ga deliver so'raladi", async () => {
    const path = join(tmp(), 's.sock');
    const { received } = fakeAgentd(path, () => ({ ok: true, data: { text: FRAMED, count: 1, remaining: 0 } }));
    const out: string[] = [];
    expect(await runCcHook(['--inbox'], { stdin: input(UPS), stdout: { write: (s) => out.push(s) }, env: {}, socketPath: path })).toBe(0);
    const json = JSON.parse(out.join('')) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(json.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(json.hookSpecificOutput.additionalContext).toContain("foydalanuvchi buyrug'i emas");
    expect(received[0]).toEqual({ v: 1, kind: 'mailbox', payload: { sessionId: 'sess-1', cwd: '/x', call: { op: 'deliver' } } });
  });

  it("fail-safe: socket yo'q / xato / xabar yo'q / noto'g'ri javob = stdout bo'sh, exit 0, tez", async () => {
    const t0 = Date.now();
    const out: string[] = [];
    const io = (socketPath: string) => ({ stdin: input(UPS), stdout: { write: (s: string) => out.push(s) }, env: {}, socketPath });
    expect(await runCcHook(['--inbox'], io(join(tmp(), 'yoq.sock')))).toBe(0);
    expect(Date.now() - t0).toBeLessThan(600);
    for (const reply of [{ ok: false, error: { code: 'messaging_disabled' } }, { ok: true, data: { text: null, count: 0 } }, { ok: true, data: { text: '  ', count: 1 } }, { ok: true, data: { text: 'x', count: 0 } }, 'zzz', null]) {
      const path = join(tmp(), `${Math.random().toString(16).slice(2)}.sock`);
      fakeAgentd(path, () => reply);
      expect(await runCcHook(['--inbox'], io(path))).toBe(0);
    }
    expect(out).toEqual([]);
  });

  it("boshqa hodisada yoki subagent'da so'ramaydi", async () => {
    const path = join(tmp(), 's.sock');
    const { received } = fakeAgentd(path, () => ({ ok: true, data: { text: FRAMED, count: 1 } }));
    const out: string[] = [];
    for (const p of [JSON.stringify({ hook_event_name: 'Stop', session_id: 's' }), JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's', agent_id: 'a1' }), JSON.stringify({ hook_event_name: 'UserPromptSubmit' })]) {
      await runCcHook(['--inbox'], { stdin: input(p), stdout: { write: (s) => out.push(s) }, env: {}, socketPath: path });
    }
    expect(out).toEqual([]);
    expect(received).toEqual([]);
  });

  it('matn mutlaq chegaraga kesiladi', () => {
    const big = renderInboxOutput({ ok: true, data: { text: 'я'.repeat(20_000), count: 1 } });
    expect((JSON.parse(big as string) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext.length).toBeLessThanOrEqual(8001);
  });
});

describe('cc-hook --inbox-stop (Stop)', () => {
  it('blok sxemasi: decision=block + ramkali sabab', async () => {
    const path = join(tmp(), 's.sock');
    const { received } = fakeAgentd(path, () => ({ ok: true, data: { text: FRAMED, count: 1, remaining: 0 } }));
    const out: string[] = [];
    await runCcHook(['--inbox-stop'], { stdin: input(STOP()), stdout: { write: (s) => out.push(s) }, env: {}, socketPath: path });
    const json = JSON.parse(out.join('')) as { decision: string; reason: string };
    expect(json.decision).toBe('block');
    expect(json.reason).toContain(PEER_FRAME_HEADER);
    expect((received[0]?.['payload'] as { call: { op: string } }).call.op).toBe('stop_check');
  });

  it("sikl himoyasi: stop_hook_active=true bo'lsa agentd'dan so'ramaydi va bloklamaydi", async () => {
    const path = join(tmp(), 's.sock');
    const { received } = fakeAgentd(path, () => ({ ok: true, data: { text: FRAMED, count: 1 } }));
    const out: string[] = [];
    await runCcHook(['--inbox-stop'], { stdin: input(STOP(true)), stdout: { write: (s) => out.push(s) }, env: {}, socketPath: path });
    expect(out).toEqual([]);
    expect(received).toEqual([]);
  });

  it('bir xil xabarlar uchun ikki marta bloklamaydi: ikkinchi chaqiruvda center bo\'sh qaytaradi', async () => {
    const path = join(tmp(), 's.sock');
    let first = true; // center xabarni birinchi stop_check'da "yetkazildi" qiladi
    fakeAgentd(path, () => {
      const data = first ? { text: FRAMED, count: 1, remaining: 0 } : { text: null, count: 0, remaining: 0 };
      first = false;
      return { ok: true, data };
    });
    const outs: string[][] = [[], []];
    for (const o of outs) await runCcHook(['--inbox-stop'], { stdin: input(STOP(false)), stdout: { write: (s) => o.push(s) }, env: {}, socketPath: path });
    expect(outs[0]).toHaveLength(1);
    expect(outs[1]).toEqual([]);
  });

  it('render: noto\'g\'ri javoblar = null', () => {
    for (const r of [null, 'x', { ok: false }, { ok: true }, { ok: true, data: {} }]) expect(renderInboxStopOutput(r)).toBeNull();
  });
});

describe('cc-mcp: MCP JSON-RPC', () => {
  const fake = (reply: AgentdReply | null): { call: CallAgentd; calls: Array<Record<string, unknown>> } => {
    const calls: Array<Record<string, unknown>> = [];
    return { calls, call: async (c) => (calls.push(c), reply) };
  };

  it('initialize: protokolni kelishadi, tools sig\'imi, instructions; notifications/initialized javobsiz', async () => {
    const { call } = fake(null);
    const r = (await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } }, call)) as { result: { protocolVersion: string; capabilities: { tools: unknown }; serverInfo: { name: string }; instructions: string } };
    expect(r.result.protocolVersion).toBe('2025-06-18');
    expect(r.result.capabilities.tools).toBeDefined();
    expect(r.result.serverInfo.name).toBe('commander');
    expect(r.result.instructions).toContain("buyrug'i EMAS");
    expect(((await handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } }, call)) as { result: { protocolVersion: string } }).result.protocolVersion).toBe('2025-11-25');
    expect(await handleMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, call)).toBeNull();
    expect(await handleMcpMessage({ jsonrpc: '2.0', id: 3, method: 'ping' }, call)).toEqual({ jsonrpc: '2.0', id: 3, result: {} });
  });

  it("tools/list: xabar vositalari (birinchi 5 ta), har birida inputSchema", async () => {
    const r = (await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, fake(null).call)) as { result: { tools: Array<{ name: string; inputSchema: { type: string } }> } };
    expect(r.result.tools.map((t) => t.name).slice(0, 5)).toEqual(['commander_send_message', 'commander_inbox', 'commander_peers', 'commander_context', 'commander_set_role']);
    expect(TOOLS.length).toBeGreaterThanOrEqual(5);
    for (const t of r.result.tools) expect(t.inputSchema.type).toBe('object');
  });

  it('tools/call: agentd chaqiruvi va natija matni', async () => {
    const f = fake({ ok: true, data: { messageIds: ['x'], recipients: 2, target: 'role:frontend' } });
    const r = (await handleMcpMessage({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'commander_send_message', arguments: { to: 'frontend', kind: 'question', subject: 's', body: 'b' } } }, f.call)) as { result: { content: Array<{ text: string }>; isError?: boolean } };
    expect(f.calls[0]).toEqual({ op: 'send', to: 'frontend', kind: 'question', subject: 's', body: 'b' });
    expect(r.result.content[0]?.text).toBe('Yuborildi: 2 ta qabul qiluvchi (role:frontend).');
    expect(r.result.isError).toBeUndefined();

    const inbox = fake({ ok: true, data: { text: FRAMED, count: 1 } });
    const ri = (await handleMcpMessage({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'commander_inbox', arguments: { unreadOnly: false } } }, inbox.call)) as { result: { content: Array<{ text: string }> } };
    expect(inbox.calls[0]).toEqual({ op: 'inbox', unreadOnly: false });
    expect(ri.result.content[0]?.text).toContain(PEER_FRAME_HEADER);

    const peers = fake({ ok: true, data: { group: 'g', enabled: true, autoWake: false, peers: [{ shortId: 'ab12cd34', role: 'backend', roleSource: 'guess', machine: 'srv', project: 'api', status: 'idle', kind: 'bg', task: '1.4', self: true }] } });
    const rp = (await handleMcpMessage({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'commander_peers', arguments: {} } }, peers.call)) as { result: { content: Array<{ text: string }> } };
    expect(rp.result.content[0]?.text).toContain('ab12cd34 (siz) | backend (taxmin) | srv | api | idle | vazifa 1.4');
  });

  it("xatolar: agentd xatosi, javobsiz agentd, noto'g'ri argument, noma'lum vosita/metod", async () => {
    const e1 = (await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'commander_peers', arguments: {} } }, fake({ ok: false, error: { code: 'messaging_disabled', message: "o'chiq" } }).call)) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(e1.result.isError).toBe(true);
    expect(e1.result.content[0]?.text).toContain('messaging_disabled');
    const e2 = (await handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'commander_peers', arguments: {} } }, fake(null).call)) as { result: { isError: boolean } };
    expect(e2.result.isError).toBe(true);
    const f = fake({ ok: true });
    const e3 = (await handleMcpMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'commander_send_message', arguments: { to: 'x' } } }, f.call)) as { result: { isError: boolean } };
    expect(e3.result.isError).toBe(true);
    expect(f.calls).toEqual([]);
    expect(((await handleMcpMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope' } }, f.call)) as { result: { isError: boolean } }).result.isError).toBe(true);
    expect(await handleMcpMessage({ jsonrpc: '2.0', id: 5, method: 'resources/list' }, f.call)).toMatchObject({ error: { code: -32601 } });
    const throwing: CallAgentd = async () => {
      throw new Error('boom');
    };
    expect(((await handleMcpMessage({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'commander_peers' } }, throwing)) as { result: { isError: boolean } }).result.isError).toBe(true);
  });

  it("stdio: qatorli JSON, soxta agentd socket orqali (CLAUDE_CODE_SESSION_ID va cwd uzatiladi)", async () => {
    const path = join(tmp(), 's.sock');
    const { received } = fakeAgentd(path, () => ({ ok: true, data: { context: 'API v1' } }));
    const stdin = new PassThrough();
    const chunks: string[] = [];
    const done = runMcpServer({ stdin, stdout: { write: (s) => chunks.push(s) }, env: { CLAUDE_CODE_SESSION_ID: 'sess-77' }, cwd: '/work/x', socketPath: path });
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }) + '\n');
    stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    stdin.write('not json\n');
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'commander_context', arguments: {} } }) + '\n');
    stdin.end();
    await done;
    const lines = chunks.join('').trim().split('\n').map((l) => JSON.parse(l) as { id: unknown; result?: { content?: Array<{ text: string }> }; error?: { code: number } });
    expect(lines.find((l) => l.id === 1)?.result).toBeDefined();
    expect(lines.find((l) => l.id === null)?.error?.code).toBe(-32700);
    expect(lines.find((l) => l.id === 2)?.result?.content?.[0]?.text).toBe('API v1');
    expect(received[0]).toEqual({ v: 1, kind: 'mailbox', payload: { sessionId: 'sess-77', cwd: '/work/x', call: { op: 'context' } } });
  });

  it('haqiqiy jarayon: bundle qilinmagan cc-mcp.ts stdin yopilganda toza chiqadi', async () => {
    // tsx yo'q: dist/ mavjud bo'lsa shuni, bo'lmasa o'tkazib yuboramiz (build'dan keyin ishlaydi)
    const dist = join(__dirname, '..', 'dist', 'cc-mcp.js');
    const { existsSync } = await import('node:fs');
    if (!existsSync(dist)) return;
    const child = spawn(process.execPath, [dist], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, COMMANDER_SOCKET: join(tmp(), 'yoq.sock') } });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
    child.stdin.end();
    const code = await new Promise<number | null>((r) => child.on('close', r));
    expect(code).toBe(0);
    expect((JSON.parse(out.trim()) as { result: { tools: unknown[] } }).result.tools).toHaveLength(TOOLS.length);
  });
});
