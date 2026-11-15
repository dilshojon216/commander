import { z } from 'zod';
import type { UsageRecord } from '@commander/contracts';

/**
 * Claude Code transcript JSONL (`~/.claude/projects/<proj>/<session>.jsonl`) dan usage olish.
 * Haqiqiy faylda tekshirilgan (PLAN §13/ADR): assistant yozuvi `requestId`, `timestamp` (ISO), `sessionId`,
 * `cwd`, `message.model`, `message.usage{input_tokens, output_tokens, cache_read_input_tokens,
 * cache_creation_input_tokens}` ga ega. MUHIM: bitta API so'rovi bir nechta assistant yozuviga bo'linadi
 * (thinking/text/tool_use), hammasida BIR XIL requestId va (yakuniy) usage. Shuning uchun requestId bo'yicha
 * guruhlanadi; guruhning `ts` = eng birinchi yozuv vaqti (barqaror). Transcript matni (content) o'qilmaydi.
 */

const UsageSchema = z.looseObject({
  input_tokens: z.number().min(0).optional(),
  output_tokens: z.number().min(0).optional(),
  cache_read_input_tokens: z.number().min(0).optional(),
  cache_creation_input_tokens: z.number().min(0).optional(),
});

const EntrySchema = z.looseObject({
  type: z.string(),
  requestId: z.string().min(1).max(255).optional(),
  timestamp: z.string().optional(),
  sessionId: z.string().min(1).max(255).optional(),
  message: z
    .looseObject({
      model: z.string().optional(),
      usage: UsageSchema.optional(),
    })
    .optional(),
});

export interface TranscriptUsageEntry {
  requestId: string;
  sessionId: string | undefined;
  model: string;
  ts: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/** Bitta qatorni tahlil qiladi. Usage'siz / sintetik / yaroqsiz qator uchun `null`. */
export function parseTranscriptLine(line: string): TranscriptUsageEntry | null {
  if (line.length === 0 || !line.includes('"usage"')) return null; // tez filtr: content'ni parse qilmaymiz
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return null;
  }
  const e = EntrySchema.safeParse(json);
  if (!e.success || e.data.type !== 'assistant') return null;
  const { requestId, timestamp, message } = e.data;
  const usage = message?.usage;
  const model = message?.model;
  if (!requestId || !timestamp || !usage || !model || model.startsWith('<')) return null; // `<synthetic>` va h.k.
  const ts = Date.parse(timestamp);
  if (!Number.isFinite(ts)) return null;
  return {
    requestId,
    sessionId: e.data.sessionId,
    model: model.slice(0, 128),
    ts,
    inputTokens: Math.floor(usage.input_tokens ?? 0),
    outputTokens: Math.floor(usage.output_tokens ?? 0),
    cacheReadTokens: Math.floor(usage.cache_read_input_tokens ?? 0),
    cacheCreationTokens: Math.floor(usage.cache_creation_input_tokens ?? 0),
  };
}

export interface RequestGroup {
  requestId: string;
  sessionId: string | undefined;
  model: string;
  /** Guruhdagi eng erta yozuv vaqti: barqaror (qayta o'qishda ham o'zgarmaydi). */
  ts: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Guruh birinchi yozuvining fayldagi bayt offseti (qayta o'qish boshlanishi uchun). */
  startOffset: number;
  /** Oxirgi yozuv qo'shilgan lokal (wall-clock) vaqt: "tinchlandi"mi aniqlash uchun. */
  lastSeenAt: number;
}

/** Yozuvlarni requestId bo'yicha birlashtiradi: har token turi bo'yicha eng katta qiymat (oqim davomida o'sadi). */
export function mergeIntoGroup(groups: Map<string, RequestGroup>, entry: TranscriptUsageEntry, offset: number, now: number): void {
  const g = groups.get(entry.requestId);
  if (!g) {
    groups.set(entry.requestId, { ...entry, startOffset: offset, lastSeenAt: now });
    return;
  }
  g.ts = Math.min(g.ts, entry.ts);
  g.inputTokens = Math.max(g.inputTokens, entry.inputTokens);
  g.outputTokens = Math.max(g.outputTokens, entry.outputTokens);
  g.cacheReadTokens = Math.max(g.cacheReadTokens, entry.cacheReadTokens);
  g.cacheCreationTokens = Math.max(g.cacheCreationTokens, entry.cacheCreationTokens);
  g.lastSeenAt = now;
}

export function groupToUsageRecord(g: RequestGroup, fallbackSessionId: string, cwd: string | undefined): UsageRecord {
  return {
    requestId: g.requestId,
    claudeSessionId: g.sessionId ?? fallbackSessionId,
    ...(cwd ? { cwd } : {}),
    model: g.model,
    inputTokens: g.inputTokens,
    outputTokens: g.outputTokens,
    cacheReadTokens: g.cacheReadTokens,
    cacheCreationTokens: g.cacheCreationTokens,
    source: 'transcript',
    ts: g.ts,
  };
}
