import { describe, expect, it } from 'vitest';
import { groupToUsageRecord, mergeIntoGroup, parseTranscriptLine, type RequestGroup } from './transcript.js';

const usage = { input_tokens: 2, cache_creation_input_tokens: 4362, cache_read_input_tokens: 120869, output_tokens: 815, output_tokens_details: { thinking_tokens: 144 } };

function line(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'assistant',
    requestId: 'req_A',
    timestamp: '2026-11-11T12:43:30.602Z',
    sessionId: 'sess-1',
    cwd: '/x',
    isSidechain: false,
    message: { id: 'msg_1', model: 'claude-sonnet-5-5', usage, content: [{ type: 'text', text: 'SECRET-CONTENT' }] },
    ...over,
  });
}

describe('parseTranscriptLine', () => {
  it('haqiqiy maydon nomlaridan usage oladi', () => {
    expect(parseTranscriptLine(line())).toEqual({
      requestId: 'req_A',
      sessionId: 'sess-1',
      model: 'claude-sonnet-5-5',
      ts: Date.parse('2026-11-11T12:43:30.602Z'),
      inputTokens: 2,
      outputTokens: 815,
      cacheReadTokens: 120869,
      cacheCreationTokens: 4362,
    });
  });

  it("usage'siz, user, sintetik va yaroqsiz qatorlar null", () => {
    expect(parseTranscriptLine('')).toBeNull();
    expect(parseTranscriptLine('{not json "usage"')).toBeNull();
    expect(parseTranscriptLine(JSON.stringify({ type: 'user', message: { content: 'x' } }))).toBeNull();
    expect(parseTranscriptLine(line({ message: { model: '<synthetic>', usage } }))).toBeNull();
    expect(parseTranscriptLine(line({ requestId: undefined }))).toBeNull();
    expect(parseTranscriptLine(line({ timestamp: 'nope' }))).toBeNull();
  });

  it('natijada content yo\'q', () => {
    expect(JSON.stringify(parseTranscriptLine(line()))).not.toContain('SECRET-CONTENT');
  });
});

describe('mergeIntoGroup / groupToUsageRecord (bitta so\'rov = bir nechta yozuv)', () => {
  it("requestId bo'yicha birlashadi; ts = eng erta; tokenlar = maksimum", () => {
    const groups = new Map<string, RequestGroup>();
    const a = parseTranscriptLine(line({ timestamp: '2026-11-11T12:43:30.000Z', message: { model: 'm', usage: { ...usage, output_tokens: 10 } } }))!;
    const b = parseTranscriptLine(line({ timestamp: '2026-11-11T12:43:31.500Z' }))!;
    mergeIntoGroup(groups, b, 200, 1000); // tartibsiz kelsa ham
    mergeIntoGroup(groups, a, 100, 2000);
    expect(groups.size).toBe(1);
    const g = groups.get('req_A')!;
    expect(g.ts).toBe(Date.parse('2026-11-11T12:43:30.000Z'));
    expect(g.outputTokens).toBe(815);
    expect(g.startOffset).toBe(200); // birinchi ko'rilgan yozuv offseti
    expect(g.lastSeenAt).toBe(2000);
    const rec = groupToUsageRecord(g, 'fallback', '/proj');
    expect(rec).toMatchObject({ requestId: 'req_A', source: 'transcript', cwd: '/proj', claudeSessionId: 'sess-1', ts: g.ts });
  });

  it("sessionId yo'q bo'lsa fallback ishlatiladi", () => {
    const groups = new Map<string, RequestGroup>();
    mergeIntoGroup(groups, { ...parseTranscriptLine(line())!, sessionId: undefined }, 0, 0);
    expect(groupToUsageRecord(groups.get('req_A')!, 'fb', undefined).claudeSessionId).toBe('fb');
  });
});
