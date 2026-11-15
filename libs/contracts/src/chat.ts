import { z } from 'zod';
import { EpochMsSchema, envelopeMessage } from './envelope.js';

/**
 * Sessiya chat oqimi kontrakti (PLAN "Qarorlar (2.x chat)").
 *
 * MAXFIYLIK QARORI: chat matni center DB'da SAQLANMAYDI. Klient sessiyani ochganda center o'sha mashinaning
 * agentd'idan transcript oqimini so'raydi; agentd lokal JSONL'ni o'qiydi, redakt qiladi, `ChatItem`'larga
 * aylantiradi va center orqali obunachi klientlarga oqizadi. Center faqat uzatadi (relay): na jadval, na log.
 *
 * Oqim:
 *   klient `chat.open` -> center `chat.stream.start` (agentd) -> agentd `chat.items` (backfill, `done`) -> center
 *   `chat.items` + `chat.state live` (klient) -> keyin jonli qo'shimchalar. `chat.close` / uzilish -> oxirgi klient
 *   ketgach `chat.stream.stop`.
 *
 * UPSERT QOIDASI: bir xil `id` li element oldingisini ALMASHTIRADI (klient id bo'yicha). Shu sabab qayta yuborish
 * (resync, jonli yangilanish) xavfsiz. `usage` elementlari shunday yangilanadi (so'rov oqimi davomida tokenlar o'sadi).
 */

export const CHAT_LIMITS = {
  /** `chat.open.limit` default (backfill hajmi, element soni). */
  defaultTail: 200,
  maxTail: 500,
  /** Bitta `chat.items` xabaridagi elementlar. */
  maxItemsPerMessage: 100,
  /** Bitta `chat.items` xabarining taxminiy bayt chegarasi (agent kanali 256 KiB; qolgani zaxira). */
  targetMessageBytes: 160 * 1024,
  maxIdChars: 128,
  /** user/assistant matni (redaktdan keyin kesiladi, `…[truncated]`). */
  maxTextChars: 16_000,
  maxThinkingChars: 4_000,
  maxToolNameChars: 64,
  /** Tool kiritmasining qisqa ko'rinishi: `Bash: npm test`, `Edit: src/app.ts (+12 -3)`. */
  maxSummaryChars: 300,
  /** tool_result matni: 4 KB (UTF-8 bayt; agentd bayt bo'yicha kesadi). */
  maxToolResultBytes: 4096,
  maxNoticeChars: 500,
  maxCursorChars: 64,
  /** agentd bir vaqtda xizmat qiladigan oqimlar. */
  maxStreamsPerAgent: 8,
  /** Bitta klient ulanishi bir vaqtda ochiq tutadigan sessiyalar. */
  maxOpenPerClient: 6,
  /** Center oqim `start` javobini kutish muddati (undan keyin `chat.state error`). */
  startTimeoutMs: 20_000,
} as const;

const IdSchema = z.string().min(1).max(CHAT_LIMITS.maxIdChars);
const CursorSchema = z.string().min(1).max(CHAT_LIMITS.maxCursorChars);
const TokenSchema = z.number().int().min(0).max(1_000_000_000_000);

const base = {
  /** Barqaror id: transcript yozuvi `uuid` (+ `:<blok indeksi>`), `usage:<requestId>`. */
  id: IdSchema,
  /** Yozuv vaqti (epoch ms); noma'lum bo'lsa 0. */
  ts: EpochMsSchema,
};

export const CHAT_USER_VARIANTS = ['prompt', 'command', 'shell', 'task'] as const;

/** Foydalanuvchi prompti (yoki `/command`, `!shell`, fon vazifa bildirishnomasi: `variant`). */
export const ChatUserItemSchema = z.object({
  ...base,
  kind: z.literal('user'),
  text: z.string().max(CHAT_LIMITS.maxTextChars),
  variant: z.enum(CHAT_USER_VARIANTS).optional(),
});

/** Claude javobi (markdown). */
export const ChatAssistantItemSchema = z.object({
  ...base,
  kind: z.literal('assistant'),
  text: z.string().max(CHAT_LIMITS.maxTextChars),
  requestId: IdSchema.optional(),
  model: z.string().max(128).optional(),
});

/** Fikrlash bloki. Faqat `includeThinking` so'ralganda yuboriladi (default: yo'q). */
export const ChatThinkingItemSchema = z.object({
  ...base,
  kind: z.literal('thinking'),
  text: z.string().max(CHAT_LIMITS.maxThinkingChars),
  requestId: IdSchema.optional(),
});

export const ChatToolUseItemSchema = z.object({
  ...base,
  kind: z.literal('tool_use'),
  toolUseId: IdSchema,
  toolName: z.string().min(1).max(CHAT_LIMITS.maxToolNameChars),
  /** Redakt qilingan qisqa ko'rinish (xom kiritma EMAS). */
  summary: z.string().max(CHAT_LIMITS.maxSummaryChars),
  /** Edit/Write/MultiEdit: qo'shilgan va o'chirilgan qatorlar. */
  lines: z.object({ added: z.number().int().min(0), removed: z.number().int().min(0) }).optional(),
  requestId: IdSchema.optional(),
});

export const ChatToolResultItemSchema = z.object({
  ...base,
  kind: z.literal('tool_result'),
  toolUseId: IdSchema,
  /** Mos tool_use shu oqimda ko'rilgan bo'lsa. */
  toolName: z.string().min(1).max(CHAT_LIMITS.maxToolNameChars).optional(),
  ok: z.boolean(),
  /** Redakt qilingan, <= 4 KB; UI'da default yig'ilgan. */
  text: z.string().max(CHAT_LIMITS.maxToolResultBytes),
  truncated: z.boolean(),
});

export const CHAT_NOTICE_CODES = ['compact', 'interrupted', 'error', 'denied', 'info'] as const;

export const ChatNoticeItemSchema = z.object({
  ...base,
  kind: z.literal('notice'),
  code: z.enum(CHAT_NOTICE_CODES),
  level: z.enum(['info', 'error']),
  text: z.string().max(CHAT_LIMITS.maxNoticeChars),
});

/**
 * Bitta API so'rovi (assistant xabari) tokenlari va modeli. Metadata: UI uni shu `requestId` li OXIRGI element ostida
 * ko'rsatadi. `id = usage:<requestId>`; oqim davomida o'sgan qiymat bilan qayta yuboriladi (upsert).
 */
export const ChatUsageItemSchema = z.object({
  ...base,
  kind: z.literal('usage'),
  requestId: IdSchema,
  model: z.string().max(128).optional(),
  inputTokens: TokenSchema,
  outputTokens: TokenSchema,
  cacheReadTokens: TokenSchema,
  cacheCreationTokens: TokenSchema,
});

export const ChatItemSchema = z.discriminatedUnion('kind', [
  ChatUserItemSchema,
  ChatAssistantItemSchema,
  ChatThinkingItemSchema,
  ChatToolUseItemSchema,
  ChatToolResultItemSchema,
  ChatNoticeItemSchema,
  ChatUsageItemSchema,
]);
export type ChatItem = z.infer<typeof ChatItemSchema>;
export type ChatItemKind = ChatItem['kind'];

export const CHAT_ERROR_CODES = ['not_found', 'forbidden_path', 'busy', 'read_failed', 'internal'] as const;
export const ChatErrorCodeSchema = z.enum(CHAT_ERROR_CODES);
export type ChatErrorCode = z.infer<typeof ChatErrorCodeSchema>;

export const CHAT_STATES = ['connecting', 'live', 'offline', 'unavailable', 'error'] as const;
export const ChatStateSchema = z.enum(CHAT_STATES);
export type ChatState = z.infer<typeof ChatStateSchema>;

// --- klient -> center ------------------------------------------------------------------------

/**
 * `sessionId` = `SessionDto.id` (ichki uuid). `limit` = backfill (default `CHAT_LIMITS.defaultTail`).
 * `before` = oldingi javobdagi `cursor`: bu holda KONKRET eski sahifa so'raladi (javob `chat.items {older:true}`).
 */
export const ChatOpenPayloadSchema = z.object({
  sessionId: z.uuid(),
  limit: z.number().int().min(1).max(CHAT_LIMITS.maxTail).optional(),
  before: CursorSchema.optional(),
});
export type ChatOpenPayload = z.infer<typeof ChatOpenPayloadSchema>;
export const ChatOpenMessageSchema = envelopeMessage('chat.open', ChatOpenPayloadSchema);

export const ChatClosePayloadSchema = z.object({ sessionId: z.uuid() });
export type ChatClosePayload = z.infer<typeof ChatClosePayloadSchema>;
export const ChatCloseMessageSchema = envelopeMessage('chat.close', ChatClosePayloadSchema);

// --- center -> klient ------------------------------------------------------------------------

export const ChatItemsToClientPayloadSchema = z.object({
  sessionId: z.uuid(),
  items: z.array(ChatItemSchema).max(CHAT_LIMITS.maxItemsPerMessage),
  /** `true`: mavjud ro'yxatni to'liq ALMASHTIR (backfill/resync). */
  replace: z.boolean().optional(),
  /** `true`: eski sahifa (ro'yxat BOSHIGA qo'shiladi). */
  older: z.boolean().optional(),
  /** Backfill/eski sahifada: keyingi eski sahifa uchun `before`; `null` = faylning boshiga yetildi. */
  cursor: CursorSchema.nullable().optional(),
});
export type ChatItemsToClientPayload = z.infer<typeof ChatItemsToClientPayloadSchema>;
export const ChatItemsToClientMessageSchema = envelopeMessage('chat.items', ChatItemsToClientPayloadSchema);

export const ChatStateMessageSchema = envelopeMessage(
  'chat.state',
  z.object({ sessionId: z.uuid(), state: ChatStateSchema, code: ChatErrorCodeSchema.optional() }),
);

// --- center -> agentd ------------------------------------------------------------------------

export const ChatStreamStartPayloadSchema = z.object({
  /** Center yaratadi (uuid); qayta ulanishda yangisi. */
  streamId: z.uuid(),
  claudeSessionId: z.string().min(1).max(255),
  /** Markazda ma'lum yo'l; agentd uni QAYTA TEKSHIRADI (`~/.claude/projects` ichida bo'lishi shart). */
  transcriptPath: z.string().min(1).max(4096).optional(),
  tail: z.number().int().min(1).max(CHAT_LIMITS.maxTail),
  includeThinking: z.boolean().optional(),
});
export type ChatStreamStartPayload = z.infer<typeof ChatStreamStartPayloadSchema>;
export const ChatStreamStartMessageSchema = envelopeMessage('chat.stream.start', ChatStreamStartPayloadSchema);

export const ChatStreamStopPayloadSchema = z.object({ streamId: z.uuid() });
export const ChatStreamStopMessageSchema = envelopeMessage('chat.stream.stop', ChatStreamStopPayloadSchema);

/** Mavjud oqim uchun eski sahifa (center `chat.open {before}` ni shunday uzatadi). Javob `chat.items {pageId}`. */
export const ChatStreamPagePayloadSchema = z.object({
  streamId: z.uuid(),
  pageId: z.uuid(),
  before: CursorSchema,
  limit: z.number().int().min(1).max(CHAT_LIMITS.maxTail),
});
export type ChatStreamPagePayload = z.infer<typeof ChatStreamPagePayloadSchema>;
export const ChatStreamPageMessageSchema = envelopeMessage('chat.stream.page', ChatStreamPagePayloadSchema);

// --- agentd -> center ------------------------------------------------------------------------

/**
 * Ack/nack YO'Q (telemetriya emas, jonli oqim). `done`: backfill tugadi (center `live` holatiga o'tkazadi).
 * `replace`: oqim `start` (yoki qayta `start` = resync) backfill'i. `pageId`: `chat.stream.page` javobi.
 */
export const ChatItemsFromAgentPayloadSchema = z.object({
  streamId: z.uuid(),
  pageId: z.uuid().optional(),
  items: z.array(ChatItemSchema).max(CHAT_LIMITS.maxItemsPerMessage),
  replace: z.boolean().optional(),
  older: z.boolean().optional(),
  cursor: CursorSchema.nullable().optional(),
  done: z.boolean().optional(),
});
export type ChatItemsFromAgentPayload = z.infer<typeof ChatItemsFromAgentPayloadSchema>;
export const ChatItemsFromAgentMessageSchema = envelopeMessage('chat.items', ChatItemsFromAgentPayloadSchema);

export const ChatErrorFromAgentPayloadSchema = z.object({
  streamId: z.uuid(),
  pageId: z.uuid().optional(),
  code: ChatErrorCodeSchema,
});
export type ChatErrorFromAgentPayload = z.infer<typeof ChatErrorFromAgentPayloadSchema>;
export const ChatErrorFromAgentMessageSchema = envelopeMessage('chat.error', ChatErrorFromAgentPayloadSchema);
