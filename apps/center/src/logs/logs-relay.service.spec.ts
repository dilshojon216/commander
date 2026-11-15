import { describe, expect, it } from 'vitest';
import { LOG_LIMITS } from '@commander/contracts';
import { AgentDispatchService } from '../realtime/agent-dispatch.service.js';
import { LogsRelayService } from './logs-relay.service.js';

const CID = '123e4567-e89b-42d3-a456-426614174000';
const M1 = 'machine-1';

function make() {
  const dispatch = new AgentDispatchService();
  const sent: Array<{ machineId: string; type: string; payload: unknown }> = [];
  dispatch.register(M1, { deviceId: 'dev', send: (type, payload) => (sent.push({ machineId: M1, type, payload }), true) });
  const relay = new LogsRelayService(dispatch);
  relay.onModuleInit();
  return { relay, dispatch, sent };
}

describe('LogsRelayService', () => {
  it('chunk -> bufer -> cursor bilan o\'qish; redaksiya markazda ham', () => {
    const { relay } = make();
    relay.register(CID, M1);
    expect(relay.read(CID, 0)).toMatchObject({ state: 'starting', lines: [] });
    relay.onAgentChunk(M1, { commandId: CID, seq: 0, lines: ['hello', 'token=ghp_' + 'a'.repeat(30)] });
    const r = relay.read(CID, 0)!;
    expect(r.state).toBe('live');
    expect(r.lines[0]).toBe('hello');
    expect(r.lines[1]).not.toContain('ghp_aaaa');
    relay.onAgentChunk(M1, { commandId: CID, seq: 1, lines: ['x'], done: true, reason: 'complete' });
    const r2 = relay.read(CID, r.nextSeq)!;
    expect(r2).toMatchObject({ state: 'done', lines: ['x'], reason: 'complete', error: null });
    relay.onModuleDestroy();
  });

  it('begona mashinadan kelgan chunk e\'tiborsiz; oldin ro\'yxatdan o\'tmagan oqim sekin yaratiladi', () => {
    const { relay } = make();
    relay.register(CID, M1);
    relay.onAgentChunk('other', { commandId: CID, seq: 0, lines: ['evil'] });
    expect(relay.read(CID, 0)!.lines).toEqual([]);
    const other = '223e4567-e89b-42d3-a456-426614174001';
    relay.onAgentChunk(M1, { commandId: other, seq: 0, lines: ['early'] });
    expect(relay.read(other, 0)!.lines).toEqual(['early']);
    relay.onModuleDestroy();
  });

  it('xato bilan tugash: state=error, xabar redakt qilinadi', () => {
    const { relay } = make();
    relay.onAgentChunk(M1, { commandId: CID, seq: 0, lines: [], done: true, reason: 'error', error: { code: 'logs_failed', message: 'boom' } });
    expect(relay.read(CID, 0)).toMatchObject({ state: 'error', error: { code: 'logs_failed' } });
    relay.onModuleDestroy();
  });

  it('idle o\'quvchi: logs.stop yuboriladi; tugagan oqim TTL dan keyin o\'chadi', () => {
    const { relay, sent } = make();
    const t0 = 1_000_000;
    relay.register(CID, M1, t0);
    relay.onAgentChunk(M1, { commandId: CID, seq: 0, lines: ['a'] }, t0);
    relay.sweep(t0 + LOG_LIMITS.readerIdleMs - 1);
    expect(sent.length).toBe(0);
    relay.sweep(t0 + LOG_LIMITS.readerIdleMs + 1);
    expect(sent).toEqual([{ machineId: M1, type: 'logs.stop', payload: { commandId: CID } }]);
    expect(relay.read(CID, 0, t0 + LOG_LIMITS.readerIdleMs + 2)).toMatchObject({ state: 'done', reason: 'stopped' });
    relay.sweep(t0 + LOG_LIMITS.readerIdleMs + LOG_LIMITS.finishedTtlMs + 10_000);
    expect(relay.count).toBe(0);
    relay.onModuleDestroy();
  });

  it('o\'qish idle taymerini yangilaydi', () => {
    const { relay, sent } = make();
    const t0 = 5_000;
    relay.register(CID, M1, t0);
    relay.onAgentChunk(M1, { commandId: CID, seq: 0, lines: ['a'] }, t0);
    relay.read(CID, 0, t0 + 20_000);
    relay.sweep(t0 + 40_000);
    expect(sent.length).toBe(0);
    relay.onModuleDestroy();
  });

  it('mashina offline: oqim error(machine_offline)', () => {
    const { relay, dispatch } = make();
    relay.register(CID, M1);
    relay.onAgentChunk(M1, { commandId: CID, seq: 0, lines: ['a'] });
    dispatch.unregister(M1, (dispatch as unknown as { senders: Map<string, never> }).senders.get(M1)!);
    expect(relay.read(CID, 0)).toMatchObject({ state: 'error', error: { code: 'machine_offline' } });
    relay.onModuleDestroy();
  });

  it('stop(): agentga logs.stop, qayta stop jim', () => {
    const { relay, sent } = make();
    relay.register(CID, M1);
    expect(relay.stop(CID)).toBe(true);
    expect(relay.stop(CID)).toBe(true);
    expect(sent.length).toBe(1);
    expect(relay.stop('nope')).toBe(false);
    relay.onModuleDestroy();
  });

  it('oqimlar soni chegaralangan: band bo\'lsa ro\'yxat rad, tugagan eskisi siqib chiqariladi', () => {
    const { relay } = make();
    const ids = Array.from({ length: LOG_LIMITS.centerMaxStreams }, (_, i) => `123e4567-e89b-42d3-a456-4266141740${String(i).padStart(2, '0')}`);
    for (const id of ids) expect(relay.register(id, M1, 1)).toBe(true);
    expect(relay.register('323e4567-e89b-42d3-a456-426614174099', M1, 2)).toBe(false);
    relay.onAgentChunk(M1, { commandId: ids[0]!, seq: 0, lines: [], done: true, reason: 'complete' }, 3);
    expect(relay.register('323e4567-e89b-42d3-a456-426614174099', M1, 4)).toBe(true);
    expect(relay.read(ids[0]!, 0)).toBeUndefined();
    relay.onModuleDestroy();
  });

  it('bufer chegarasi: juda ko\'p qator -> eskilari tashlanadi, dropped bildiriladi', () => {
    const { relay } = make();
    relay.register(CID, M1);
    const lines = Array.from({ length: LOG_LIMITS.centerBufferLines + 500 }, (_, i) => `l${i}`);
    for (let i = 0; i < lines.length; i += 200) relay.onAgentChunk(M1, { commandId: CID, seq: i, lines: lines.slice(i, i + 200) });
    const r = relay.read(CID, 0)!;
    expect(r.dropped).toBe(500);
    expect(r.lines[0]).toBe('l500');
    relay.onModuleDestroy();
  });
});
