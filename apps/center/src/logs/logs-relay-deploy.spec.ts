import { describe, expect, it } from 'vitest';
import { LOG_LIMITS } from '@commander/contracts';
import { AgentDispatchService } from '../realtime/agent-dispatch.service.js';
import { LogsRelayService } from './logs-relay.service.js';

const CID = '123e4567-e89b-42d3-a456-426614174000';
const M1 = 'machine-1';

describe('LogsRelayService: deploy chiqishi (persistent oqim, 6.5)', () => {
  function make() {
    const dispatch = new AgentDispatchService();
    const sent: Array<{ type: string; payload: unknown }> = [];
    dispatch.register(M1, { deviceId: 'dev', send: (type, payload) => (sent.push({ type, payload }), true) });
    return { relay: new LogsRelayService(dispatch), sent };
  }

  it('oddiy oqim o\'quvchisiz 30 s dan keyin to\'xtatiladi (logs.stop), deploy oqimi esa YO\'Q', () => {
    const { relay, sent } = make();
    const t0 = 1_000_000;
    const plain = '223e4567-e89b-42d3-a456-426614174001';
    relay.register(plain, M1, t0);
    relay.register(CID, M1, t0, true);
    relay.onAgentChunk(M1, { commandId: CID, seq: 0, lines: ['step 1'] }, t0);
    relay.sweep(t0 + LOG_LIMITS.readerIdleMs + 1000);
    expect(sent).toEqual([{ type: 'logs.stop', payload: { commandId: plain } }]);
    expect(relay.read(CID, 0, t0 + 60_000)).toMatchObject({ state: 'live', lines: ['step 1'] });
    // deploy tugaguncha yig'iladi
    relay.onAgentChunk(M1, { commandId: CID, seq: 1, lines: ['step 2'], done: true, reason: 'complete' }, t0 + 120_000);
    expect(relay.read(CID, 1, t0 + 120_001)).toMatchObject({ state: 'done', lines: ['step 2'], reason: 'complete' });
  });

  it('mutlaq chegara: 3 soatdan keyin ham tugamagan deploy oqimi to\'xtatiladi; register ikkinchi marta persistent qiladi', () => {
    const { relay, sent } = make();
    const t0 = 5_000_000;
    relay.register(CID, M1, t0); // oddiy
    relay.register(CID, M1, t0, true); // keyin persistent deb belgilanadi
    relay.sweep(t0 + 2 * 60 * 60_000);
    expect(sent).toHaveLength(0);
    relay.sweep(t0 + 3 * 60 * 60_000 + 1000);
    expect(sent).toEqual([{ type: 'logs.stop', payload: { commandId: CID } }]);
  });

  it('mashina offline bo\'lsa deploy oqimi xato bilan tugaydi (machine_offline)', () => {
    const dispatch = new AgentDispatchService();
    dispatch.register(M1, { deviceId: 'dev', send: () => true });
    const relay = new LogsRelayService(dispatch);
    relay.onModuleInit();
    relay.register(CID, M1, Date.now(), true);
    relay.onAgentChunk(M1, { commandId: CID, seq: 0, lines: ['a'] });
    dispatch.unregister(M1, (dispatch as unknown as { senders: Map<string, never> }).senders.get(M1)!);
    expect(relay.read(CID, 0)).toMatchObject({ state: 'error', error: { code: 'machine_offline' } });
    relay.onModuleDestroy();
  });
});
