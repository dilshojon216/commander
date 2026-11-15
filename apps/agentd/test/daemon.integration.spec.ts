import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent, UsageRecord } from '@commander/contracts';
import { ConfigSchema, saveConfig } from '../src/config.js';
import { startDaemon } from '../src/daemon.js';
import { generateDeviceKey, storePrivateKey } from '../src/identity.js';
import { silentLogger } from '../src/logger.js';
import { resolvePaths } from '../src/paths.js';
import { FakeCenter } from './fake-center.js';
import { tmpHome, waitFor } from './helpers.js';

const DEVICE = '3f0c9f6e-1b7a-4d77-8d36-0a1b2c3d4e5f';
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function sock(path: string, req: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = createConnection(path);
    let out = '';
    c.on('connect', () => c.end(JSON.stringify(req) + '\n'));
    c.on('data', (d: Buffer) => (out += d.toString('utf8')));
    c.on('close', () => resolve(out));
    c.on('error', reject);
  });
}

describe('agentd daemon (hook socket + OTLP + WS) <-> fake center', () => {
  it('hook va OTLP ma\'lumoti bir xil loyiha ildizi bilan center\'ga yetadi', async () => {
    const h = tmpHome();
    cleanups.push(h.cleanup);
    const paths = resolvePaths(join(h.dir, 'home'));
    const key = generateDeviceKey();
    storePrivateKey(paths, key.privateKey);
    const center = new FakeCenter(key.publicKeyRaw);
    const port = await center.start();
    cleanups.push(() => center.stop().catch(() => undefined));
    saveConfig(paths, ConfigSchema.parse({ centerUrl: `http://127.0.0.1:${port}`, deviceId: DEVICE }));

    // ildiz aniqlash uchun soxta git papka
    const { mkdirSync } = await import('node:fs');
    const repo = join(h.dir, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(repo, 'sub'), { recursive: true });

    const d = await startDaemon({
      paths,
      config: ConfigSchema.parse({ centerUrl: `http://127.0.0.1:${port}`, deviceId: DEVICE }),
      log: silentLogger,
      agentsLister: async () => [{ claudeSessionId: '11111111-2222-3333-4444-555555555555', cwd: join(repo, 'sub'), kind: 'interactive' }],
      otlpPort: 0,
      intervals: { reconcileMs: 60_000, tailMs: 60_000 },
    });
    cleanups.push(() => d.stop());
    await waitFor(() => d.client.getState() === 'ready');

    const sid = '11111111-2222-3333-4444-555555555555';
    const hookReply = await sock(paths.socketFile, { v: 1, kind: 'hook', payload: { hook_event_name: 'SessionStart', session_id: sid, cwd: join(repo, 'sub') } });
    expect(JSON.parse(hookReply)).toEqual({ ok: true });

    const body = readFileSync(new URL('./fixtures/otlp-logs-api-request.json', import.meta.url), 'utf8');
    const res = await fetch(`http://127.0.0.1:${d.otlpPort}/v1/logs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    expect(res.status).toBe(200);

    // statusline -> limits
    await sock(paths.socketFile, { v: 1, kind: 'statusline', payload: { session_id: sid, rate_limits: { seven_day: { used_percentage: 12, resets_at: 1800500000 } } } });

    await waitFor(() => d.outbox.counts().events === 0 && d.outbox.counts().usage === 0 && d.outbox.counts().limits === 0);
    const ev = (center.of('agent.events')[0]!.payload as { events: AgentEvent[] }).events[0]!;
    const us = (center.of('agent.usage')[0]!.payload as { records: UsageRecord[] }).records[0]!;
    expect(ev).toMatchObject({ claudeSessionId: sid, status: 'idle', event: 'SessionStart', cwd: repo });
    expect(us).toMatchObject({ requestId: 'req_TESTFIXTURE00000000000001', cwd: repo, source: 'otel' });
    expect(center.of('agent.limits')[0]!.payload).toMatchObject({ sevenDay: { usedPct: 12, resetsAt: 1800500000000 } });

    // status so'rovi
    const st = JSON.parse(await sock(paths.socketFile, { v: 1, kind: 'status' })) as { ok: boolean; status: { ws: { state: string } } };
    expect(st.status.ws.state).toBe('ready');
  });
});
