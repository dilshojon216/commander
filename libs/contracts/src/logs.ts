import { z } from 'zod';
import { envelopeMessage } from './envelope.js';

/**
 * Log ko'ruvchi kontrakti (task 6.6). Imzolangan, FAQAT o'qiydigan buyruq `logs.tail`.
 *
 * Oqim:
 *   klient `POST /v1/machines/:id/logs` -> center `logs.tail` buyrug'ini yaratadi (audit + imzolangan dispatch + lokal siyosat)
 *   -> agentd manbani tekshiradi (docker ro'yxati / systemd ro'yxati / ruxsat etilgan log ildizi) va `logs.chunk` xabarlarini
 *   oqizadi (ack/outbox YO'Q, chat relay kabi jonli) -> center xotiradagi chegaralangan buferga yig'adi -> klient
 *   `GET /v1/logs/:commandId?after=<seq>` bilan o'qiydi (cursor). `follow` <= 10 daqiqa; klient o'qimay qo'ysa (idle) yoki
 *   `DELETE /v1/logs/:commandId` kelsa center agentga `logs.stop` yuboradi.
 *
 * MAXFIYLIK: log matni DB'ga HECH QACHON yozilmaydi (`commands.result` ga ham, auditga ham: faqat manba turi va nomi).
 * agentd chiqishni redakt qiladi (qator chegarasidan oshgan PEM kaliti ham), center qayta redakt qiladi.
 */

export const LOG_SOURCES = ['docker', 'journal', 'file'] as const;
export const LogSourceSchema = z.enum(LOG_SOURCES);
export type LogSource = z.infer<typeof LogSourceSchema>;

export const LOG_LIMITS = {
  defaultLines: 200,
  maxLines: 2000,
  /** Bitta so'rovning snapshot chiqishi (bayt): oxirgi qismi saqlanadi. */
  maxSnapshotBytes: 256 * 1024,
  /** `follow` oqimi umumiy hajmi (bayt): undan keyin `done(byte_cap)`. */
  maxFollowBytes: 8 * 1024 * 1024,
  /** `follow` davomiyligi. */
  followMaxMs: 10 * 60_000,
  /** Snapshot bosqichi (docker/journalctl) muddati. */
  snapshotTimeoutMs: 20_000,
  /** Bitta `logs.chunk` (agent kanali 256 KiB; zaxira bilan). */
  chunkMaxBytes: 64 * 1024,
  chunkMaxLines: 200,
  lineMaxChars: 2000,
  nameMaxChars: 128,
  pathMaxChars: 1024,
  /** agentd bir vaqtda xizmat qiladigan oqimlar. */
  maxStreamsPerAgent: 4,
  /** `follow` chunk'lari orasidagi eng kichik oraliq (agent kanali 600 xabar/daq chegarasi uchun). */
  followFlushMs: 1000,
  /** Center: bitta oqim buferi (bayt/qator): eng eskilari tashlanadi (`dropped`). */
  centerBufferBytes: 512 * 1024,
  centerBufferLines: 5000,
  /** Center: bir vaqtda faol oqimlar. */
  centerMaxStreams: 12,
  /** Klient shuncha ms o'qimasa (idle) oqim to'xtatiladi. */
  readerIdleMs: 30_000,
  /** Tugagan oqim buferi shuncha ms saqlanadi (keyin o'chadi). */
  finishedTtlMs: 2 * 60_000,
  /** Bitta o'qishda qaytadigan eng ko'p qator. */
  readPageLines: 1000,
} as const;

/** Konteyner/unit nomi: faqat xavfsiz belgilar va harf/raqam bilan boshlanadi (CLI bayrog'iga o'xshay olmaydi). */
export const LOG_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,127}$/;

/** `since`: nisbiy (`10m`, `2h`, `1d`, `30s`) yoki ISO sana/vaqt. Boshqa (erkin matn) HECH QACHON CLI'ga o'tmaydi. */
export const LOG_SINCE_RE = /^(?:\d{1,4}[smhd]|\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?Z?)$/;

const isAbsPath = (p: string): boolean => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p);

/** Manba/nom juftligi: docker/journal uchun nom regex'i, fayl uchun mutlaq yo'l (`..` segmentsiz, NUL yo'q). */
export function logNameIssue(source: LogSource, name: string): string | null {
  if (name.includes('\0')) return 'name must not contain NUL';
  if (source === 'file') {
    if (name.length > LOG_LIMITS.pathMaxChars) return 'path is too long';
    if (!isAbsPath(name)) return 'file logs need an absolute path';
    if (name.split(/[\\/]/).includes('..')) return 'path must not contain ".." segments';
    return null;
  }
  return LOG_NAME_RE.test(name) ? null : 'invalid name';
}

const baseFields = {
  source: LogSourceSchema,
  name: z.string().min(1).max(LOG_LIMITS.pathMaxChars),
  lines: z.number().int().min(1).max(LOG_LIMITS.maxLines),
  since: z.string().regex(LOG_SINCE_RE).optional(),
  follow: z.boolean().optional(),
};

/** `logs.tail` imzolangan payload (agentd uni qayta tekshiradi). */
export const LogsTailPayloadSchema = z
  .object(baseFields)
  .superRefine((v, ctx) => {
    const issue = logNameIssue(v.source, v.name);
    if (issue) ctx.addIssue({ code: 'custom', path: ['name'], message: issue });
  });
export type LogsTailPayload = z.infer<typeof LogsTailPayloadSchema>;

/** REST: `POST /v1/machines/:id/logs`. */
export const StartLogsBodySchema = z
  .object({ ...baseFields, lines: baseFields.lines.default(LOG_LIMITS.defaultLines) })
  .strict()
  .superRefine((v, ctx) => {
    const issue = logNameIssue(v.source, v.name);
    if (issue) ctx.addIssue({ code: 'custom', path: ['name'], message: issue });
  });
export type StartLogsBody = z.infer<typeof StartLogsBodySchema>;

// --- agentd -> center / center -> agentd (jonli, ack'siz) ----------------------------------------

export const LOG_END_REASONS = ['complete', 'timeout', 'stopped', 'byte_cap', 'ended', 'error'] as const;
export const LogEndReasonSchema = z.enum(LOG_END_REASONS);
export type LogEndReason = z.infer<typeof LogEndReasonSchema>;

export const LogsChunkPayloadSchema = z.object({
  commandId: z.uuid(),
  /** Oqim ichida o'suvchi tartib raqami (0 dan). */
  seq: z.number().int().min(0).max(1_000_000_000),
  lines: z.array(z.string().max(LOG_LIMITS.lineMaxChars + 64)).max(LOG_LIMITS.chunkMaxLines),
  /** Orqa bosim tufayli agentd tashlagan qatorlar soni (shu chunk'dan OLDIN). */
  dropped: z.number().int().min(0).max(1_000_000_000).optional(),
  /** Snapshot 256 KB chegarasida kesildi (eng eski qatorlar tashlandi). */
  truncated: z.boolean().optional(),
  done: z.boolean().optional(),
  reason: LogEndReasonSchema.optional(),
  error: z.object({ code: z.string().min(1).max(64), message: z.string().max(300) }).optional(),
});
export type LogsChunkPayload = z.infer<typeof LogsChunkPayloadSchema>;
export const LogsChunkMessageSchema = envelopeMessage('logs.chunk', LogsChunkPayloadSchema);

export const LogsStopPayloadSchema = z.object({ commandId: z.uuid() });
export type LogsStopPayload = z.infer<typeof LogsStopPayloadSchema>;
export const LogsStopMessageSchema = envelopeMessage('logs.stop', LogsStopPayloadSchema);

// --- REST javoblari -----------------------------------------------------------------------------

export const LogsReadQuerySchema = z
  .object({
    /** Oxirgi olingan `nextSeq` (default 0: buferdagi eng eskisidan). */
    after: z.coerce.number().int().min(0).max(1_000_000_000).default(0),
  })
  .strict();
export type LogsReadQuery = z.infer<typeof LogsReadQuerySchema>;

export const LOG_STREAM_STATES = ['starting', 'live', 'done', 'error'] as const;
export const LogStreamStateSchema = z.enum(LOG_STREAM_STATES);
export type LogStreamState = z.infer<typeof LogStreamStateSchema>;

export const LogsReadResponseSchema = z.object({
  commandId: z.uuid(),
  state: LogStreamStateSchema,
  /** Qatorlar (redakt qilingan, tartibli). */
  lines: z.array(z.string()),
  /** Keyingi so'rovda `after` sifatida yuboriladi. */
  nextSeq: z.number().int().min(0),
  /** Bufer to'lib (yoki orqa bosim) tufayli tashlangan qatorlar soni (`after` dan beri). */
  dropped: z.number().int().min(0),
  truncated: z.boolean(),
  reason: LogEndReasonSchema.nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
});
export type LogsReadResponse = z.infer<typeof LogsReadResponseSchema>;

/** Dashboard "Claude'dan so'rash" uchun tanlangan qatorlar (redakt qilingan, chegaralangan). */
export const LOG_ASK_LIMITS = { maxLines: 200, maxChars: 8000 } as const;
