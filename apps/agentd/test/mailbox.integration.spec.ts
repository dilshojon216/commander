import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { PEER_FRAME_HEADER } from '@commander/contracts';
import type { MailboxCall, MailboxRequestPayload } from '@commander/contracts';
import { runCcHook } from '../../../libs/hooks/src/cc-hook-lib.js';
import { handleMcpMessage, makeAgentdCaller } from '../../../libs/hooks/src/cc-mcp-lib.js';
import { ConfigSchema, saveConfig } from '../src/config.js';
import { startDaemon, type DaemonHandle } from '../src/daemon.js';
import { generateDeviceKey, storePrivateKey } from '../src/identity.js';
import type { LiveSession } from '../src/agents-cli.js';
import { silentLogger } from '../src/logger.js';
import type { PeerAttestor } from '../src/peer-identity.js';
import { resolvePaths, type AgentdPaths } from '../src/paths.js';
import { FakeCenter } from './fake-center.js';
import { tmpHome, waitFor } from './helpers.js';

const DEVICE = '3f0c9f6e-1b7a-4d77-8d36-0a1b2c3d4e5f';
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const SID = 'sess-mailbox-1';
const FRAMED = `${PEER_FRAME_HEADER}\n--- #abcd1234 | backend | question | 2026-11-13T10:00:00.000Z\nMavzu: Schema?\n> phone bormi?`;

interface Rig {
  center: FakeCenter;
  d: DaemonHandle;
  paths: AgentdPaths;
  reqs(): MailboxRequestPayload[];
  hook(argv: string[], stdin: string): Promise<{ out: string; ms: number }>;
  tool(name: string, args: Record<string, unknown>, env?: NodeJS.ProcessEnv, cwd?: string): Promise<{ text: string; isError: boolean; ms: number }>;
}

const UNATTESTED: PeerAttestor = { available: false, peerPids: async () => [] };

async function rig(opts: { centerUp?: boolean; attestor?: PeerAttestor; lister?: () => Promise<LiveSession[]>; parents?: Map<number, number>; reply?: (call: MailboxCall) => { ok: boolean; data?: unknown; error?: { code: string; message: string } } } = {}): Promise<Rig> {
  const h = tmpHome();
  cleanups.push(h.cleanup);
  const paths = resolvePaths(join(h.dir, 'home'));
  const key = generateDeviceKey();
  storePrivateKey(paths, key.privateKey);
  const center = new FakeCenter(key.publicKeyRaw);
  center.handler = (msg, ws: WebSocket, c) => {
    if (msg.type === 'mailbox.request') {
      const p = msg.payload as MailboxRequestPayload;
      const r = opts.reply?.(p.call) ?? { ok: true, data: { text: FRAMED, count: 1, remaining: 0 } };
      c.send(ws, 'mailbox.reply', { reqId: p.reqId, ...r });
      return 'skip';
    }
    return 'default';
  };
  const port = await center.start();
  if (opts.centerUp === false) await center.stop();
  else cleanups.push(() => center.stop().catch(() => undefined));
  const config = ConfigSchema.parse({ centerUrl: `http://127.0.0.1:${port}`, deviceId: DEVICE });
  saveConfig(paths, config);
  const d = await startDaemon({ paths, config, log: silentLogger, agentsLister: opts.lister ?? (async () => []), peerAttestor: opts.attestor ?? UNATTESTED, ...(opts.parents ? { procParents: async () => opts.parents! } : {}), otlpPort: 0, intervals: { reconcileMs: 60_000, tailMs: 60_000 }, wsClient: { backoff: { baseMs: 50, maxMs: 100 } } });
  cleanups.push(() => d.stop());
  if (opts.centerUp !== false) await waitFor(() => d.client.getState() === 'ready');
  return {
    center,
    d,
    paths,
    reqs: () => center.of('mailbox.request').map((r) => r.payload as MailboxRequestPayload),
    hook: async (argv, stdin) => {
      const s = new PassThrough();
      s.end(stdin);
      const out: string[] = [];
      const t0 = Date.now();
      await runCcHook(argv, { stdin: s, stdout: { write: (x) => out.push(x) }, env: {}, socketPath: paths.socketFile });
      return { out: out.join(''), ms: Date.now() - t0 };
    },
    tool: async (name, args, env = { CLAUDE_CODE_SESSION_ID: SID }, cwd = '/tmp/proj') => {
      const t0 = Date.now();
      const res = (await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, makeAgentdCaller({ env, cwd, socketPath: paths.socketFile }))) as { result: { content: Array<{ text: string }>; isError?: boolean } };
      return { text: res.result.content[0]?.text ?? '', isError: res.result.isError === true, ms: Date.now() - t0 };
    },
  };
}

const UPS = JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: SID, cwd: '/tmp/proj', prompt: 'salom' });
const STOP = JSON.stringify({ hook_event_name: 'Stop', session_id: SID, cwd: '/tmp/proj' });

describe('sessiyalararo xabar: cc-hook / cc-mcp <-> agentd <-> fake center', () => {
  it("vosita: commander_record_decision matni markazga ketishdan oldin redakt qilinadi (qoida 5)", async () => {
    const r = await rig({ reply: () => ({ ok: true, data: { text: 'Qaror jurnalga yozildi: Kalit' } }) });
    const out = await r.tool('commander_record_decision', { title: 'Kalit', decision: 'sk-ant-api03-SUPERSECRETVALUE1234567890abcdef ishlatamiz', reason: 'token=abcd1234efgh5678ijkl', alternatives: ['gh' + 'p_' + 'a'.repeat(36)] });
    expect(out.isError).toBe(false);
    const call = r.reqs().find((q) => q.call.op === 'record_decision')!.call as unknown as { decision: string; reason: string; alternatives: string[] };
    expect(JSON.stringify(call)).not.toContain('SUPERSECRETVALUE');
    expect(JSON.stringify(call)).not.toContain('aaaaaaaaaaaaaaaaaaaa');
    expect(call.decision).toContain('[REDACTED]');
  });

  it('UserPromptSubmit --inbox: center blokini additionalContext sifatida beradi; so\'rov sessiya id bilan', async () => {
    const r = await rig();
    const { out } = await r.hook(['--inbox'], UPS);
    expect(JSON.parse(out).hookSpecificOutput).toEqual({ hookEventName: 'UserPromptSubmit', additionalContext: FRAMED });
    expect(r.reqs()).toHaveLength(1);
    expect(r.reqs()[0]).toMatchObject({ claudeSessionId: SID, call: { op: 'deliver' } });
  });

  it('Stop --inbox-stop: bir martalik blok; stop_hook_active bo\'lsa center\'ga umuman so\'ramaydi', async () => {
    let delivered = false;
    const r = await rig({
      reply: (call) => {
        if (call.op !== 'stop_check') return { ok: true };
        const data = delivered ? { text: null, count: 0, remaining: 0 } : { text: FRAMED, count: 1, remaining: 0 };
        delivered = true;
        return { ok: true, data };
      },
    });
    const first = await r.hook(['--inbox-stop'], STOP);
    expect(JSON.parse(first.out)).toMatchObject({ decision: 'block' });
    expect(JSON.parse(first.out).reason).toContain(PEER_FRAME_HEADER);
    expect((await r.hook(['--inbox-stop'], STOP)).out).toBe('');
    const before = r.reqs().length;
    expect((await r.hook(['--inbox-stop'], JSON.stringify({ hook_event_name: 'Stop', session_id: SID, stop_hook_active: true }))).out).toBe('');
    expect(r.reqs()).toHaveLength(before);
  });

  it("vosita: send matni markazga ketishdan oldin redakt qilinadi; center xatosi isError bo'ladi", async () => {
    const r = await rig({ reply: (c) => (c.op === 'send' ? { ok: true, data: { messageIds: ['x'], recipients: 1, target: 'role:frontend' } } : { ok: true }) });
    const res = await r.tool('commander_send_message', { to: 'frontend', kind: 'api_change', subject: 'token=abc123supersecret', body: 'API_KEY=sk-ant-api03-ABCDEFGHIJKLMNOPQRST va Bearer abcdefghijklmnop1234 hammasi' });
    expect(res).toMatchObject({ text: 'Yuborildi: 1 ta qabul qiluvchi (role:frontend).', isError: false });
    const sent = r.reqs()[0]!.call as Extract<MailboxCall, { op: 'send' }>;
    expect(sent.subject).not.toContain('abc123supersecret');
    expect(sent.body).not.toContain('ABCDEFGHIJKLMNOPQRST');
    expect(sent.body).not.toContain('abcdefghijklmnop1234');
    expect(sent.body).toContain('[REDACTED]');

    const bad = await rig({ reply: () => ({ ok: false, error: { code: 'messaging_disabled', message: "Sessiyalararo xabar o'chiq" } }) });
    const e = await bad.tool('commander_peers', {});
    expect(e.isError).toBe(true);
    expect(e.text).toContain('messaging_disabled');
  });

  it("noto'g'ri parametr (uzun tema/noma'lum tur) center'ga bormaydi", async () => {
    const r = await rig();
    const res = await r.tool('commander_send_message', { to: 'x', kind: 'spam', subject: 's', body: 'b' });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('invalid_request');
    expect(r.reqs()).toHaveLength(0);
  });

  it('center offline: hook jim va tez, vosita center_offline xatosi; hech narsa yozilmaydi', async () => {
    const r = await rig({ centerUp: false });
    const h = await r.hook(['--inbox'], UPS);
    expect(h.out).toBe('');
    expect(h.ms).toBeLessThan(4600);
    const t = await r.tool('commander_inbox', {});
    expect(t.isError).toBe(true);
    expect(t.text).toContain('center_offline');
    expect(r.d.outbox).toBeDefined();
  });

  it("sessiya id yo'q: cwd bo'yicha YAGONA ochiq sessiya; bir nechta bo'lsa rad", async () => {
    const r = await rig();
    r.d.store.touchFromHook('only-one', { cwd: '/work/a', root: '/work/a' });
    const ok = await r.tool('commander_peers', {}, {}, '/work/a');
    expect(ok.isError).toBe(false);
    expect(r.reqs()[0]!.claudeSessionId).toBe('only-one');

    r.d.store.touchFromHook('second', { cwd: '/work/a', root: '/work/a' });
    const amb = await r.tool('commander_peers', {}, {}, '/work/a');
    expect(amb.isError).toBe(true);
    expect(amb.text).toContain('session_unknown');
    expect((await r.tool('commander_peers', {}, {}, '/work/none')).text).toContain('session_unknown');
    expect(r.reqs()).toHaveLength(1);
  });
});

describe('M-14: sessiya identity peer jarayonga bog\'langan (enforce rejimi)', () => {
  const SID_A = 'sess-aaaa-1';
  const SID_B = 'sess-bbbb-2';
  // A: pid 1000 (cc-mcp 1001 uning avlodi), B: pid 2000. 3001 — begona, hech bir sessiya ostida emas.
  const parents = new Map<number, number>([
    [1001, 1000],
    [1000, 10],
    [1101, 1001], // A ichidagi Bash -> cc-mcp emas, lekin A avlodi
    [2001, 2000],
    [2000, 10],
    [3001, 1], // reparent bo'lgan (init) jarayon
  ]);
  const lister = async (): Promise<LiveSession[]> => [
    { claudeSessionId: SID_A, pid: 1000, kind: 'interactive' },
    { claudeSessionId: SID_B, pid: 2000, kind: 'interactive' },
  ];
  const attestorOf = (...pids: number[]): PeerAttestor => ({ available: true, peerPids: async () => pids });

  it("o'z sessiyasi nomidan: ruxsat; sessionId peer'dan olinadi (e'lon qilinmasa ham)", async () => {
    const r = await rig({ attestor: attestorOf(1001), lister, parents });
    const ok = await r.tool('commander_peers', {}, { CLAUDE_CODE_SESSION_ID: SID_A });
    expect(ok.isError).toBe(false);
    expect(r.reqs()[0]!.claudeSessionId).toBe(SID_A);
    const noClaim = await r.tool('commander_peers', {}, {}, '/nowhere');
    expect(noClaim.isError).toBe(false);
    expect(r.reqs()[1]!.claudeSessionId).toBe(SID_A);
  });

  it("boshqa sessiya (B) nomidan e'lon qilgan peer (A ostida) RAD ETILADI: send / orch_step_update / orch_dispatch center'ga bormaydi", async () => {
    const r = await rig({ attestor: attestorOf(1101), lister, parents });
    const send = await r.tool('commander_send_message', { to: 'all', kind: 'info', subject: 's', body: 'b' }, { CLAUDE_CODE_SESSION_ID: SID_B });
    expect(send.isError).toBe(true);
    expect(send.text).toContain('different session');
    const upd = await r.tool('commander_step_update', { stepId: 'a', status: 'done', summary: 'x' }, { CLAUDE_CODE_SESSION_ID: SID_B });
    expect(upd.isError).toBe(true);
    const disp = await r.tool('commander_dispatch', { stepId: 'a', mode: 'new_session', prompt: 'p' }, { CLAUDE_CODE_SESSION_ID: SID_B });
    expect(disp.isError).toBe(true);
    expect(r.reqs()).toHaveLength(0);
    // o'z nomidan (A) o'tadi
    expect((await r.tool('commander_peers', {}, { CLAUDE_CODE_SESSION_ID: SID_A })).isError).toBe(false);
  });

  it("hook: boshqa sessiya id'si bilan --inbox bo'sh qaytadi (boshqa sessiya xabarlari olinmaydi)", async () => {
    const r = await rig({ attestor: attestorOf(2001), lister, parents });
    const forged = JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: SID_A, cwd: '/x', prompt: 'p' });
    expect((await r.hook(['--inbox'], forged)).out).toBe('');
    expect(r.reqs()).toHaveLength(0);
  });

  it("sessiya ostida bo'lmagan jarayon (reparent/begona) va aniqlanmagan peer rad etiladi", async () => {
    const orphan = await rig({ attestor: attestorOf(3001), lister, parents });
    expect((await orphan.tool('commander_peers', {}, { CLAUDE_CODE_SESSION_ID: SID_A })).isError).toBe(true);
    const unknown = await rig({ attestor: attestorOf(), lister, parents });
    expect((await unknown.tool('commander_peers', {}, { CLAUDE_CODE_SESSION_ID: SID_A })).isError).toBe(true);
    expect(orphan.reqs()).toHaveLength(0);
    expect(unknown.reqs()).toHaveLength(0);
  });

  it("cwd bo'yicha taxmin enforce rejimida yo'q: faqat peer ajdodi", async () => {
    const r = await rig({ attestor: attestorOf(3001), lister, parents });
    r.d.store.touchFromHook('only-one', { cwd: '/work/a', root: '/work/a' } as never);
    const res = await r.tool('commander_peers', {}, {}, '/work/a');
    expect(res.isError).toBe(true);
    expect(r.reqs()).toHaveLength(0);
  });
});
