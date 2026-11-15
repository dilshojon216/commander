import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent, UsageRecord } from '@commander/contracts';
import { openDb } from '../src/db.js';
import { silentLogger } from '../src/logger.js';
import { Outbox, type OutboxCaps } from '../src/outbox.js';
import { SessionStore } from '../src/session-store.js';

export function makeStores(now: () => number = Date.now, caps?: OutboxCaps) {
  const db = openDb(':memory:');
  const outbox = new Outbox(db, silentLogger, caps, now);
  const store = new SessionStore(db, now);
  return { db, outbox, store };
}

export function event(over: Partial<AgentEvent> = {}): AgentEvent {
  return { eventId: randomUUID(), claudeSessionId: 's1', event: 'Stop', status: 'done', cwd: '/proj', ts: Date.now(), ...over };
}

let reqCounter = 0;
export function usage(over: Partial<UsageRecord> = {}): UsageRecord {
  return {
    requestId: `req_${++reqCounter}`,
    claudeSessionId: 's1',
    model: 'claude-sonnet-5-5',
    inputTokens: 1,
    outputTokens: 2,
    cacheReadTokens: 3,
    cacheCreationTokens: 4,
    source: 'otel',
    ts: Date.now(),
    ...over,
  };
}

/** Qisqa yo'lli vaqtinchalik papka (unix socket yo'li 104 belgidan oshmasin). */
export function tmpHome(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'agd-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 5000, stepMs = 10): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: muddat tugadi');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
