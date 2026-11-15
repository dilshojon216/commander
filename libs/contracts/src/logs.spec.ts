import { describe, expect, it } from 'vitest';
import { COMMAND_LIMITS, COMMAND_TYPES, CommandDispatchPayloadSchema, CenterToAgentMessageSchema, AgentToCenterMessageSchema, LOG_LIMITS, LogsChunkPayloadSchema, LogsReadQuerySchema, StartLogsBodySchema, isLogsCommandType, logNameIssue } from './index.js';

const CID = '123e4567-e89b-42d3-a456-426614174000';
const sig = 'A'.repeat(86);
const nonce = 'B'.repeat(43);

describe('logs.tail kontrakti', () => {
  it('buyruq turi ro\'yxatda, logs.tail dispatch union\'da, timeout belgilangan', () => {
    expect(COMMAND_TYPES).toContain('logs.tail');
    expect(isLogsCommandType('logs.tail')).toBe(true);
    expect(isLogsCommandType('project.diff')).toBe(false);
    expect(COMMAND_LIMITS.runTimeoutMs['logs.tail']).toBeGreaterThan(0);
    const ok = CommandDispatchPayloadSchema.safeParse({ commandId: CID, nonce, expiresAt: Date.now() + 1000, sig, type: 'logs.tail', payload: { source: 'docker', name: 'web-1', lines: 100 } });
    expect(ok.success).toBe(true);
    const bad = CommandDispatchPayloadSchema.safeParse({ commandId: CID, nonce, expiresAt: Date.now() + 1000, sig, type: 'logs.tail', payload: { source: 'docker', name: '--help', lines: 100 } });
    expect(bad.success).toBe(false);
  });
  it('nom qoidalari', () => {
    expect(logNameIssue('docker', 'web_1.x-2')).toBeNull();
    expect(logNameIssue('docker', '-rf')).not.toBeNull();
    expect(logNameIssue('file', '/var/log/app.log')).toBeNull();
    expect(logNameIssue('file', 'C:\\logs\\app.log')).toBeNull();
    expect(logNameIssue('file', '/var/log/../x')).not.toBeNull();
    expect(logNameIssue('file', 'app.log')).not.toBeNull();
    expect(logNameIssue('docker', 'a\0b')).not.toBeNull();
  });
  it('chunk sxemasi: qatorlar/hajm chegarasi, done+error', () => {
    expect(LogsChunkPayloadSchema.safeParse({ commandId: CID, seq: 0, lines: ['a'] }).success).toBe(true);
    expect(LogsChunkPayloadSchema.safeParse({ commandId: CID, seq: 0, lines: Array.from({ length: LOG_LIMITS.chunkMaxLines + 1 }, () => 'x') }).success).toBe(false);
    expect(LogsChunkPayloadSchema.safeParse({ commandId: CID, seq: 0, lines: ['x'.repeat(LOG_LIMITS.lineMaxChars + 100)] }).success).toBe(false);
    expect(LogsChunkPayloadSchema.safeParse({ commandId: CID, seq: 1, lines: [], done: true, reason: 'error', error: { code: 'logs_failed', message: 'x' } }).success).toBe(true);
    expect(LogsChunkPayloadSchema.safeParse({ commandId: CID, seq: 1, lines: [], reason: 'bogus' }).success).toBe(false);
  });
  it('agent protokoli: logs.chunk (agent->center) va logs.stop (center->agent)', () => {
    const env = (type: string, payload: unknown) => ({ v: 1, id: CID, ts: Date.now(), type, payload });
    expect(AgentToCenterMessageSchema.safeParse(env('logs.chunk', { commandId: CID, seq: 0, lines: ['a'] })).success).toBe(true);
    expect(CenterToAgentMessageSchema.safeParse(env('logs.stop', { commandId: CID })).success).toBe(true);
  });
  it('REST tana va cursor so\'rovi', () => {
    expect(StartLogsBodySchema.parse({ source: 'journal', name: 'nginx' })).toMatchObject({ lines: LOG_LIMITS.defaultLines });
    expect(StartLogsBodySchema.safeParse({ source: 'docker', name: 'a', lines: 2001 }).success).toBe(false);
    expect(LogsReadQuerySchema.parse({ after: '5' })).toEqual({ after: 5 });
    expect(LogsReadQuerySchema.parse({})).toEqual({ after: 0 });
    expect(LogsReadQuerySchema.safeParse({ after: -1 }).success).toBe(false);
  });
});
