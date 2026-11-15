import { z } from 'zod';
import type { UsageRecord } from '@commander/contracts';

/**
 * OTLP/HTTP JSON `/v1/logs` dan `claude_code.api_request` hodisalarini ajratadi (spike S1, PLAN §13).
 * FAQAT kontraktga kerak maydonlar olinadi; `user.email`, `user.id`, `user.account_*`, `organization.id`,
 * prompt matnlari va boshqa hamma atributlar tashlanadi (PII).
 */

const AnyValueSchema = z
  .object({
    stringValue: z.string().optional(),
    // proto3 JSON: int64 matn bo'lishi ham mumkin.
    intValue: z.union([z.number(), z.string()]).optional(),
    doubleValue: z.number().optional(),
    boolValue: z.boolean().optional(),
  })
  .loose();

const KeyValueSchema = z.object({ key: z.string(), value: AnyValueSchema.optional() });

const LogRecordSchema = z
  .object({
    timeUnixNano: z.union([z.string(), z.number()]).optional(),
    body: AnyValueSchema.optional(),
    attributes: z.array(KeyValueSchema).optional(),
  })
  .loose();

const LogsRequestSchema = z
  .object({
    resourceLogs: z
      .array(
        z
          .object({
            scopeLogs: z.array(z.object({ logRecords: z.array(LogRecordSchema).optional() }).loose()).optional(),
          })
          .loose(),
      )
      .optional(),
  })
  .loose();

type Attrs = Map<string, z.infer<typeof AnyValueSchema>>;

function attrMap(list: Array<z.infer<typeof KeyValueSchema>> | undefined): Attrs {
  const m: Attrs = new Map();
  for (const kv of list ?? []) if (kv.value) m.set(kv.key, kv.value);
  return m;
}

const str = (a: Attrs, k: string): string | undefined => {
  const v = a.get(k)?.stringValue;
  return v !== undefined && v !== '' ? v : undefined;
};

const num = (a: Attrs, k: string): number | undefined => {
  const v = a.get(k);
  if (!v) return undefined;
  if (v.intValue !== undefined) {
    const n = Number(v.intValue);
    return Number.isFinite(n) ? n : undefined;
  }
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.stringValue !== undefined) {
    const n = Number(v.stringValue);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
};

function tokenCount(a: Attrs, k: string): number {
  const n = num(a, k);
  return n !== undefined && n >= 0 ? Math.floor(n) : 0;
}

/** Hodisa vaqti: `event.timestamp` (ISO) ustun, bo'lmasa `timeUnixNano`. So'rovning O'Z vaqti. */
function eventTimeMs(a: Attrs, rec: z.infer<typeof LogRecordSchema>): number | undefined {
  const iso = str(a, 'event.timestamp');
  if (iso) {
    const t = Date.parse(iso);
    if (Number.isFinite(t)) return t;
  }
  if (rec.timeUnixNano !== undefined) {
    const ns = typeof rec.timeUnixNano === 'string' ? Number(rec.timeUnixNano) : rec.timeUnixNano;
    if (Number.isFinite(ns) && ns > 0) return Math.floor(ns / 1e6);
  }
  return undefined;
}

export interface ParsedApiRequest {
  /** `cwd` OTel'da yo'q: chaqiruvchi sessiya jadvalidan to'ldiradi. */
  record: Omit<UsageRecord, 'cwd'>;
}

export interface OtlpLogsParseResult {
  requests: ParsedApiRequest[];
  /** api_request bo'lmagan yoki yaroqsiz yozuvlar soni (log uchun). */
  skipped: number;
}

export function parseOtlpLogs(body: unknown): OtlpLogsParseResult {
  const parsed = LogsRequestSchema.safeParse(body);
  if (!parsed.success) return { requests: [], skipped: 0 };
  const requests: ParsedApiRequest[] = [];
  let skipped = 0;

  for (const rl of parsed.data.resourceLogs ?? []) {
    for (const sl of rl.scopeLogs ?? []) {
      for (const rec of sl.logRecords ?? []) {
        const a = attrMap(rec.attributes);
        const name = str(a, 'event.name') ?? rec.body?.stringValue;
        if (name !== 'api_request' && name !== 'claude_code.api_request') continue;

        const requestId = str(a, 'request_id');
        const sessionId = str(a, 'session.id');
        const model = str(a, 'model');
        const ts = eventTimeMs(a, rec);
        if (!requestId || !sessionId || !model || ts === undefined || requestId.length > 255 || sessionId.length > 255) {
          skipped++;
          continue;
        }
        const cost = num(a, 'cost_usd');
        const promptId = str(a, 'prompt.id');
        requests.push({
          record: {
            requestId,
            claudeSessionId: sessionId,
            model: model.slice(0, 128),
            inputTokens: tokenCount(a, 'input_tokens'),
            outputTokens: tokenCount(a, 'output_tokens'),
            cacheReadTokens: tokenCount(a, 'cache_read_tokens'),
            cacheCreationTokens: tokenCount(a, 'cache_creation_tokens'),
            ...(cost !== undefined && cost >= 0 ? { costUsd: cost } : {}),
            ...(promptId && promptId.length <= 255 ? { promptId } : {}),
            source: 'otel' as const,
            ts,
          },
        });
      }
    }
  }
  return { requests, skipped };
}
