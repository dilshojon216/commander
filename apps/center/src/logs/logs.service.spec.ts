import { HttpException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { AgentControlState, CommandDto } from '@commander/contracts';
import { precheckCommand } from '../commands/control-logic.js';
import { AgentDispatchService } from '../realtime/agent-dispatch.service.js';
import { LogsRelayService } from './logs-relay.service.js';
import { LogsService } from './logs.service.js';
import { LogsTelegram } from './logs-telegram.js';

const MID = '123e4567-e89b-42d3-a456-426614174000';
const CID = '223e4567-e89b-42d3-a456-426614174001';

const dto = (over: Partial<CommandDto> = {}): CommandDto =>
  ({ id: CID, type: 'logs.tail', status: 'sent', machineId: MID, machineSlug: 'm', errorCode: null, errorMessage: null, ...over }) as CommandDto;

function make(initial: CommandDto) {
  let current = initial;
  const created: unknown[] = [];
  const commands = {
    create: async (body: unknown) => (created.push(body), { command: current, idempotent: false }),
    getDto: async () => current,
    waitFinished: async () => ({ command: current, timedOut: false }),
  };
  const dispatch = new AgentDispatchService();
  const stops: unknown[] = [];
  dispatch.register(MID, { deviceId: 'd', send: (t, p) => (stops.push([t, p]), true) });
  const relay = new LogsRelayService(dispatch);
  const svc = new LogsService(commands as never, relay);
  return { svc, relay, created, stops, set: (c: CommandDto) => (current = c) };
}

describe('LogsService', () => {
  it('start: buyruq tanasi (logs.tail) yaratiladi va oqim ro\'yxatdan o\'tadi', async () => {
    const t = make(dto());
    const out = await t.svc.start(MID, { source: 'docker', name: 'web', lines: 50, follow: true, since: '10m' }, { deviceId: 'dev', actorKind: 'web', ip: null });
    expect(out.command.id).toBe(CID);
    expect(t.created[0]).toEqual({ type: 'logs.tail', machineId: MID, source: 'docker', name: 'web', lines: 50, since: '10m', follow: true });
    expect(t.relay.count).toBe(1);
  });

  it('rad etilgan buyruq oqim ochmaydi; o\'qish buyruq xatosini ko\'rsatadi', async () => {
    const t = make(dto({ status: 'rejected', errorCode: 'policy_disabled', errorMessage: 'off' }));
    await t.svc.start(MID, { source: 'docker', name: 'web', lines: 5 }, { deviceId: 'dev', actorKind: 'web', ip: null });
    expect(t.relay.count).toBe(0);
    expect(await t.svc.read(CID, 0)).toMatchObject({ state: 'error', error: { code: 'policy_disabled' }, lines: [] });
  });

  it('read: boshlanmagan -> starting; chunk -> live qatorlar; done(done chunk) -> done; tugagan buyruq oqimsiz -> done(ended)', async () => {
    const t = make(dto());
    await t.svc.start(MID, { source: 'docker', name: 'web', lines: 5 }, { deviceId: 'dev', actorKind: 'web', ip: null });
    expect(await t.svc.read(CID, 0)).toMatchObject({ state: 'starting', lines: [] });
    t.relay.onAgentChunk(MID, { commandId: CID, seq: 0, lines: ['a', 'b'] });
    const r = await t.svc.read(CID, 0);
    expect(r).toMatchObject({ state: 'live', lines: ['a', 'b'], nextSeq: 2 });
    t.relay.onAgentChunk(MID, { commandId: CID, seq: 1, lines: [], done: true, reason: 'complete' });
    expect(await t.svc.read(CID, 2)).toMatchObject({ state: 'done', reason: 'complete', lines: [] });
    const lone = make(dto({ status: 'done' }));
    expect(await lone.svc.read(CID, 0)).toMatchObject({ state: 'done', reason: 'ended' });
  });

  it('boshlanish oldidan buyruq muvaffaqiyatsiz (agent_timeout) bo\'lsa oqim "starting" da qolmaydi', async () => {
    const t = make(dto());
    await t.svc.start(MID, { source: 'docker', name: 'web', lines: 5 }, { deviceId: 'dev', actorKind: 'web', ip: null });
    t.set(dto({ status: 'failed', errorCode: 'agent_timeout', errorMessage: 'late' }));
    expect(await t.svc.read(CID, 0)).toMatchObject({ state: 'error', error: { code: 'agent_timeout' } });
  });

  it('boshqa turdagi buyruq 404; stop agentga logs.stop yuboradi', async () => {
    const other = make(dto({ type: 'session.start' }));
    await expect(other.svc.read(CID, 0)).rejects.toThrow(/not found/i);
    const t = make(dto());
    await t.svc.start(MID, { source: 'docker', name: 'web', lines: 5, follow: true }, { deviceId: 'dev', actorKind: 'web', ip: null });
    expect(await t.svc.stop(CID)).toEqual({ stopped: true });
    expect(t.stops).toEqual([['logs.stop', { commandId: CID }]]);
  });

  it('markaz band bo\'lsa 429 logs_busy (buyruq yaratilmaydi)', async () => {
    const t = make(dto());
    for (let i = 0; i < 12; i++) t.relay.register(`123e4567-e89b-42d3-a456-4266141740${String(i).padStart(2, '0')}`, MID);
    await expect(t.svc.start(MID, { source: 'docker', name: 'web', lines: 5 }, { deviceId: 'dev', actorKind: 'web', ip: null })).rejects.toBeInstanceOf(HttpException);
    expect(t.created.length).toBe(0);
  });

  it('snapshot: buyruq tugagach bufer qatorlari qaytadi', async () => {
    const t = make(dto({ status: 'done' }));
    // agent chunk'lari buyruq yaratilishidan keyin, waitFinished paytida keladi
    const origWait = (t.svc as unknown as { commands: { waitFinished: () => Promise<unknown> } }).commands.waitFinished;
    (t.svc as unknown as { commands: { waitFinished: () => Promise<unknown> } }).commands.waitFinished = async () => {
      t.relay.onAgentChunk(MID, { commandId: CID, seq: 0, lines: ['l1', 'l2'] });
      t.relay.onAgentChunk(MID, { commandId: CID, seq: 1, lines: [], done: true, reason: 'complete' });
      return origWait();
    };
    const s = await t.svc.snapshot(MID, { source: 'docker', name: 'web', lines: 2 }, { deviceId: 'dev', actorKind: 'telegram', ip: null });
    expect(s.lines).toEqual(['l1', 'l2']);
    expect(t.created[0]).not.toHaveProperty('follow');
  });
});

describe('precheck logs.tail (markaz oldindan rad)', () => {
  const control = (over: Partial<AgentControlState> = {}): AgentControlState =>
    ({ enabled: true, allowStart: true, allowPrompt: true, allowStop: true, allowSetMode: true, allowAutoMode: false, maxConcurrentStarted: 3, allowedRootCount: 1, centerKeyPinned: true, runningAsRoot: false, logs: true, allowLogs: true, ...over }) as AgentControlState;
  const input = (c: AgentControlState | null, online = true) => ({ type: 'logs.tail' as const, machineOnline: online, control: c, machineOs: 'linux' });
  it('ok / offline / eski agent / siyosat o\'chiq / policy_disabled', () => {
    expect(precheckCommand(input(control()))).toBeNull();
    expect(precheckCommand(input(control(), false))).toMatchObject({ code: 'machine_offline' });
    expect(precheckCommand(input(control({ logs: undefined })))).toMatchObject({ code: 'agent_outdated' });
    expect(precheckCommand(input(control({ allowLogs: false })))).toMatchObject({ code: 'action_not_allowed' });
    expect(precheckCommand(input(control({ enabled: false })))).toMatchObject({ code: 'policy_disabled' });
    expect(precheckCommand(input(null))).toMatchObject({ code: 'agent_outdated' });
  });
});

describe('LogsTelegram.handle', () => {
  function tg(over: { device?: string | null; snapshot?: () => Promise<unknown> } = {}) {
    const ds = { query: async () => [{ id: MID, slug: 'mac', name: 'Mac' }] };
    const logs = {
      snapshot: over.snapshot ?? (async () => ({ command: dto({ status: 'done' }), lines: ['hello <b>', 'token=ghp_' + 'z'.repeat(30)], truncated: false, dropped: 0 })),
    };
    const access = { deviceFor: async () => (over.device === undefined ? 'dev-1' : over.device) };
    return new LogsTelegram(ds as never, logs as never, access as never);
  }
  it('muvaffaqiyat: HTML-escape + redaksiya', async () => {
    const [out] = await tg().handle('mac web-1 5', '42');
    expect(out).toContain('hello &lt;b&gt;');
    expect(out).not.toContain('ghp_zzzz');
  });
  it('yomon argument / noma\'lum mashina / ruxsatsiz chat / buyruq xatosi', async () => {
    expect((await tg().handle('mac --follow', '42'))[0]).toContain("Nom noto'g'ri");
    expect((await tg().handle('', '42'))[0]).toContain('/logs');
    expect((await tg().handle('nope web', '42'))[0]).toContain('Mashina topilmadi');
    expect(await tg({ device: null }).handle('mac web', '42')).toEqual(['Bu chat uchun ruxsat bekor qilingan.']);
    const failing = tg({ snapshot: async () => ({ command: dto({ status: 'rejected', errorCode: 'logs_not_found' }), lines: [], truncated: false, dropped: 0 }) });
    expect((await failing.handle('mac web', '42'))[0]).toContain('topilmadi');
    const busy = tg({ snapshot: async () => { throw new HttpException({ error: 'logs_busy', message: 'x' }, 429); } });
    expect((await busy.handle('mac web', '42'))[0]).toContain('ko\'p');
  });
});
