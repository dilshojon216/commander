import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { UsageRecordSchema } from '@commander/contracts';
import { parseOtlpLogs } from './otlp.js';

const fixture: unknown = JSON.parse(readFileSync(new URL('../test/fixtures/otlp-logs-api-request.json', import.meta.url), 'utf8'));

describe('parseOtlpLogs', () => {
  it("faqat api_request'ni UsageRecord ga aylantiradi (to'liq yozuv)", () => {
    const { requests, skipped } = parseOtlpLogs(fixture);
    expect(requests).toHaveLength(1);
    expect(skipped).toBe(1); // request_id yo'q yozuv
    const { record } = requests[0]!;
    expect(record).toEqual({
      requestId: 'req_TESTFIXTURE00000000000001',
      claudeSessionId: '11111111-2222-3333-4444-555555555555',
      model: 'claude-haiku-5-5',
      inputTokens: 2,
      outputTokens: 4, // intValue matn ko'rinishida ham o'qiladi
      cacheReadTokens: 10834,
      cacheCreationTokens: 81193,
      costUsd: 0.01634914,
      promptId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      source: 'otel',
      ts: Date.parse('2026-11-13T04:02:04.823Z'),
    });
    expect(UsageRecordSchema.safeParse(record).success).toBe(true);
  });

  it("PII va ortiqcha atributlar chiqishga tushmaydi", () => {
    const { requests } = parseOtlpLogs(fixture);
    const json = JSON.stringify(requests);
    for (const secret of ['pii-test@example.invalid', 'user_PIITEST', '00000000-0000-0000-0000-00000000bbbb', '00000000-0000-0000-0000-00000000aaaa', 'iTerm.app', 'test-mac']) {
      expect(json).not.toContain(secret);
    }
    expect(Object.keys(requests[0]!.record).sort()).toEqual(
      ['cacheCreationTokens', 'cacheReadTokens', 'claudeSessionId', 'costUsd', 'inputTokens', 'model', 'outputTokens', 'promptId', 'requestId', 'source', 'ts'].sort(),
    );
  });

  it("vaqt: event.timestamp bo'lmasa timeUnixNano ishlatiladi", () => {
    const body = {
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: '1794542524823000000',
                  body: { stringValue: 'claude_code.api_request' },
                  attributes: [
                    { key: 'request_id', value: { stringValue: 'req_x' } },
                    { key: 'session.id', value: { stringValue: 's1' } },
                    { key: 'model', value: { stringValue: 'm' } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const { requests } = parseOtlpLogs(body);
    expect(requests[0]?.record.ts).toBe(1794542524823);
    expect(requests[0]?.record.inputTokens).toBe(0);
  });

  it("yaroqsiz kirishda bo'sh natija (tashlamaydi)", () => {
    expect(parseOtlpLogs(null).requests).toEqual([]);
    expect(parseOtlpLogs({ resourceLogs: 'x' }).requests).toEqual([]);
    expect(parseOtlpLogs({}).requests).toEqual([]);
  });
});
