import { z } from 'zod';
import { AGENT_PROTOCOL_VERSION, EpochMsSchema, envelopeMessage } from './envelope.js';
import { SessionStatusSchema } from './session-status.js';
import { ChatErrorFromAgentMessageSchema, ChatItemsFromAgentMessageSchema, ChatStreamPageMessageSchema, ChatStreamStartMessageSchema, ChatStreamStopMessageSchema } from './chat.js';
import { CenterKeyFingerprintSchema, CenterKeyRotationSchema, KeyRotateMessageSchema, KeyRotateResultMessageSchema, KeyRotationRequiredMessageSchema } from './key-rotation.js';
import { AgentControlStateSchema, CenterPublicKeySchema, CommandAckMessageSchema, CommandDispatchMessageSchema, CommandResultMessageSchema } from './commands.js';
import { AgentProjectSnapshotMessageSchema } from './projects.js';
import { MailboxReplyMessageSchema, MailboxRequestMessageSchema } from './messaging.js';
import { AgentHealthMessageSchema } from './health.js';
import { LogsChunkMessageSchema, LogsStopMessageSchema } from './logs.js';
import { ConfigChunkMessageSchema, ConfigStateReportSchema } from './config-sync.js';
import { ApprovalCancelMessageSchema, ApprovalDecisionMessageSchema, ApprovalExpiredMessageSchema, ApprovalRequestMessageSchema } from './approvals.js';

/**
 * agentd <-> center WebSocket kontrakti (task 1.4). Endpoint: `wss://<center>/ws/agent`.
 *
 * Ikkala tomon (center va agentd) FAQAT shu fayldan import qiladi. Hamma xabar JSON matn kadri
 * (binary kadr protokol xatosi), UTF-8, bitta xabar <= `AGENT_LIMITS.maxMessageBytes`.
 *
 * Oqim:
 *   1. agentd WS ochadi (hech qanday auth sarlavhasi shart emas).
 *   2. center darhol `auth.challenge` yuboradi (bir martalik nonce, ulanishga bog'langan).
 *   3. agentd `AUTH_TIMEOUT_MS` ichida `auth.response` yuboradi: Ed25519 imzo
 *      `buildAgentAuthString({nonce, ts, deviceId})` satri ustida. Boshqa har qanday xabar
 *      autentifikatsiyadan oldin protokol xatosi (close 4003).
 *   4. center `auth.ok` (yoki `auth.error` + close 4001) yuboradi.
 *   5. agentd `agent.heartbeat` (har `heartbeatIntervalMs`), `agent.events`, `agent.usage`,
 *      `agent.limits` yuboradi. center har qabul qilingan va DB'ga COMMIT qilingan xabar uchun
 *      `ack {ids:[envelope.id]}` qaytaradi. Ack kelmaguncha agentd xabarni outbox'da saqlaydi va
 *      qayta ulanganda qayta yuboradi (at-least-once). Qayta yuborish xavfsiz: eventId /
 *      (requestId, ts) / (machine, source, observedAt) bo'yicha idempotent.
 *   6. Qabul qilib bo'lmaydigan xabar uchun center `nack` yuboradi (`retriable` bayrog'iga qarang).
 *
 * Heartbeat ack qilinmaydi (ack faqat `agent.events|usage|limits` uchun).
 */

export const AGENT_WS_PATH = '/ws/agent';

/** Server va klient bir xil o'qiydigan chegaralar. `auth.ok` ularni agentd'ga ham e'lon qiladi. */
export const AGENT_LIMITS = {
  /** Bitta WS xabari (xom UTF-8 bayt). Oshsa center ulanishni 1009 bilan yopadi. */
  maxMessageBytes: 256 * 1024,
  maxEventsPerBatch: 100,
  maxUsageRecordsPerBatch: 200,
  maxActiveSessions: 200,
  maxAckIds: 200,
  /** Ulanish boshiga o'rtacha xabar tezligi (1 daqiqalik oyna). Oshgani `rate_limited` nack oladi. */
  maxMessagesPerMinute: 600,
} as const;

/** `auth.challenge` dan keyin `auth.response` ni kutish muddati. */
export const AGENT_AUTH_TIMEOUT_MS = 10_000;
export const AGENT_HEARTBEAT_INTERVAL_MS = 15_000;
/** Shu muddat davomida hech qanday xabar kelmasa center ulanishni yopadi va mashinani offline qiladi. */
export const AGENT_HEARTBEAT_TIMEOUT_MS = 60_000;
/** `auth.response.ts` va center vaqti farqi (ms). Oshsa `stale_timestamp`. */
export const AGENT_AUTH_MAX_SKEW_MS = 60_000;

/** WebSocket close kodlari (4000-4999 = ilova kodlari). */
export const AGENT_WS_CLOSE = {
  /** Server o'chyapti/restart: agentd darhol (backoff'siz) qayta ulansin. */
  goingAway: 1001,
  authFailed: 4001,
  authTimeout: 4002,
  /** Noto'g'ri JSON/envelope, autentifikatsiyasiz xabar, binary kadr. Qayta ulanish bug'ni tuzatmaydi. */
  protocolError: 4003,
  rateLimited: 4008,
  /** Shu qurilma boshqa ulanishdan keldi (eski ulanish yopiladi). */
  replaced: 4009,
  /** Qurilma revoke qilingan: qayta ulanmang (har urinish rad etiladi). */
  revoked: 4010,
  heartbeatTimeout: 4011,
} as const;

// --- Umumiy qiymatlar ------------------------------------------------------------------------

const SessionIdSchema = z.string().min(1).max(255);
const CwdSchema = z.string().min(1).max(4096);
const TokenCountSchema = z.number().int().min(0).max(1_000_000_000_000);

// --- Auth ------------------------------------------------------------------------------------

export const AGENT_AUTH_STRING_VERSION = 'COMMANDER-AGENT-AUTH-V1';

/** base64url, 32 bayt tasodifiy (43 belgi). */
export const AuthNonceSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
/** Ed25519 imzosi (64 bayt), base64url paddingsiz (86 belgi). `identity.ts` dagi bilan bir xil. */
export const AgentSignatureSchema = z.string().regex(/^[A-Za-z0-9_-]{86}$/);

export interface AgentAuthStringParts {
  /** `auth.challenge.payload.nonce`, aynan o'sha satr. */
  nonce: string;
  /** `auth.response.payload.ts` (epoch ms, o'nlik butun son). */
  ts: number;
  deviceId: string;
}

/**
 * Imzolanadigan kanonik satr (UTF-8, `\n` bilan ajratilgan 4 qator, oxirida `\n` YO'Q):
 *
 *   COMMANDER-AGENT-AUTH-V1
 *   <nonce>
 *   <ts, o'nlik epoch ms>
 *   <deviceId, kichik harf>
 *
 * Imzo: Ed25519 (`crypto.sign(null, Buffer.from(satr, 'utf8'), privateKey)`), base64url paddingsiz.
 * Versiya prefiksi HTTP imzosidan (`COMMANDER-SIG-V1`) farq qiladi: bir imzo ikki kontekstda
 * yaroqsiz (domen ajratish). Center va agentd ikkalasi shu funksiyani chaqiradi.
 */
export function buildAgentAuthString(p: AgentAuthStringParts): string {
  return [AGENT_AUTH_STRING_VERSION, p.nonce, String(p.ts), p.deviceId.toLowerCase()].join('\n');
}

export const AuthChallengePayloadSchema = z.object({
  nonce: AuthNonceSchema,
  serverTime: EpochMsSchema,
  /** Shu muddatdan keyin challenge yaroqsiz (= `AGENT_AUTH_TIMEOUT_MS`). */
  expiresInMs: z.number().int().positive(),
});
export type AuthChallengePayload = z.infer<typeof AuthChallengePayloadSchema>;
export const AuthChallengeMessageSchema = envelopeMessage('auth.challenge', AuthChallengePayloadSchema);
export type AuthChallengeMessage = z.infer<typeof AuthChallengeMessageSchema>;

export const AuthResponsePayloadSchema = z.object({
  deviceId: z.uuid(),
  /** Agentd soati, epoch ms. Imzo ichida. Center soatidan `AGENT_AUTH_MAX_SKEW_MS` dan ko'p farq qilmasin. */
  ts: EpochMsSchema,
  signature: AgentSignatureSchema,
  agentdVersion: z.string().min(1).max(64),
  /** `claude --version`; Claude Code o'rnatilmagan bo'lsa yuborilmaydi. */
  claudeVersion: z.string().min(1).max(64).optional(),
  hostname: z.string().min(1).max(255),
  /** Masalan `darwin`, `linux` (`process.platform`). */
  os: z.string().min(1).max(64),
  /** Agent pin qilgan markaz kaliti fingerprint'i (5.1): eski pin bo'lsa center imzolangan aylantirish e'lonini yuboradi. */
  centerKeyFingerprint: CenterKeyFingerprintSchema.optional(),
});
export type AuthResponsePayload = z.infer<typeof AuthResponsePayloadSchema>;
export const AuthResponseMessageSchema = envelopeMessage('auth.response', AuthResponsePayloadSchema);
export type AuthResponseMessage = z.infer<typeof AuthResponseMessageSchema>;

export const AuthOkPayloadSchema = z.object({
  deviceId: z.uuid(),
  machineId: z.uuid(),
  serverTime: EpochMsSchema,
  heartbeatIntervalMs: z.number().int().positive(),
  heartbeatTimeoutMs: z.number().int().positive(),
  limits: z.object({
    maxMessageBytes: z.number().int().positive(),
    maxEventsPerBatch: z.number().int().positive(),
    maxUsageRecordsPerBatch: z.number().int().positive(),
    maxMessagesPerMinute: z.number().int().positive(),
  }),
  /**
   * Markazning buyruq imzolash kalitining public qismi (xom 32 bayt Ed25519, base64url). agentd uni PIN qiladi
   * (enrollment'da yoki birinchi `auth.ok`da, TOFU) va keyingi har `auth.ok`da solishtiradi; mos kelmasa buyruqlarni
   * rad etadi. Eski center yubormasligi mumkin (ixtiyoriy).
   */
  centerPublicKey: CenterPublicKeySchema.optional(),
  /**
   * Markaz kalitini aylantirish e'lonlari zanjiri (5.1): agentning pin'idan boshlab, har biri ESKI kalit bilan imzolangan.
   * agentd imzoni pin qilingan kalit bilan tekshirib, pin'ni TOFUsiz yangilaydi.
   */
  centerKeyRotations: z.array(CenterKeyRotationSchema).max(8).optional(),
  /** Markaz qurilma kalitini aylantirishni talab qilmoqda (5.1): agentd `key.rotate` yuboradi. */
  rotationRequired: z.boolean().optional(),
});
export type AuthOkPayload = z.infer<typeof AuthOkPayloadSchema>;
export const AuthOkMessageSchema = envelopeMessage('auth.ok', AuthOkPayloadSchema);
export type AuthOkMessage = z.infer<typeof AuthOkMessageSchema>;

/**
 * - `unauthorized`: noma'lum qurilma yoki noto'g'ri imzo (ikkalasi bir xil: qurilma holati sirli).
 * - `device_revoked`: imzo to'g'ri, lekin qurilma bekor qilingan. Qayta ulanmang.
 * - `stale_timestamp`: soat farqi katta. agentd soatini tuzatsin (qayta urinish mumkin).
 * - `bad_request`: `auth.response` sxemaga mos emas.
 * - `timeout`: `AGENT_AUTH_TIMEOUT_MS` ichida `auth.response` kelmadi.
 */
export const AUTH_ERROR_CODES = ['unauthorized', 'device_revoked', 'stale_timestamp', 'bad_request', 'timeout'] as const;
export const AuthErrorCodeSchema = z.enum(AUTH_ERROR_CODES);
export type AuthErrorCode = z.infer<typeof AuthErrorCodeSchema>;

export const AuthErrorPayloadSchema = z.object({
  code: AuthErrorCodeSchema,
  message: z.string().max(500),
});
export type AuthErrorPayload = z.infer<typeof AuthErrorPayloadSchema>;
export const AuthErrorMessageSchema = envelopeMessage('auth.error', AuthErrorPayloadSchema);
export type AuthErrorMessage = z.infer<typeof AuthErrorMessageSchema>;

// --- agent.heartbeat -------------------------------------------------------------------------

export const SESSION_KINDS = ['interactive', 'bg', 'tmux'] as const;
export const SessionKindSchema = z.enum(SESSION_KINDS);

export const ActiveSessionSchema = z.object({
  claudeSessionId: SessionIdSchema,
  cwd: CwdSchema.optional(),
  kind: SessionKindSchema.optional(),
  /**
   * tmux pane id (`%3`; 2.6): faqat agentd tekshirgan (ajdod + egalik + oldingi plan) interaktiv sessiyalar uchun.
   * Bor bo'lsa `kind` = `tmux`. tty/soket yo'llari yuborilmaydi.
   */
  tmuxPane: z.string().regex(/^%\d{1,9}$/).optional(),
});
export type ActiveSession = z.infer<typeof ActiveSessionSchema>;

export const AgentHeartbeatPayloadSchema = z.object({
  /**
   * `claude agents --json` dagi hozir tirik sessiyalar (ixtiyoriy). center ularning
   * `last_seen_at` ini yangilaydi; ro'yxatda yo'q sessiyani O'ZI tugatmaydi: bunga agentd
   * `agent.events` orqali `status: 'ended', reason: 'vanished'` yuboradi.
   */
  activeSessions: z.array(ActiveSessionSchema).max(AGENT_LIMITS.maxActiveSessions).optional(),
  /** 1 daqiqalik load average (ixtiyoriy). */
  load: z.number().min(0).max(10_000).optional(),
  /** Lokal siyosat holati (2.3): markaz UI'da `controllable` ni shundan hisoblaydi. Yo'llar yuborilmaydi. */
  control: AgentControlStateSchema.optional(),
  /** Sozlamalar sinxronlash drift hisoboti (3.7): har ~10 daqiqada va qo'llash/qaytarishdan keyin. */
  config: ConfigStateReportSchema.optional(),
});
export type AgentHeartbeatPayload = z.infer<typeof AgentHeartbeatPayloadSchema>;
export const AgentHeartbeatMessageSchema = envelopeMessage('agent.heartbeat', AgentHeartbeatPayloadSchema);
export type AgentHeartbeatMessage = z.infer<typeof AgentHeartbeatMessageSchema>;

// --- agent.events ----------------------------------------------------------------------------

export const AgentEventSchema = z.object({
  /** Idempotentlik kaliti: agentd hodisa tug'ilganda BIR MARTA yaratadi va qayta yuborishda o'zgartirmaydi. */
  eventId: z.uuid(),
  claudeSessionId: SessionIdSchema,
  /** Hook nomi (`SessionStart`, `PreToolUse`, `Notification`, `Stop`, `SessionEnd`, `PermissionRequest`, ...). */
  event: z.string().min(1).max(64),
  /** `awaiting_approval` = PermissionRequest navbatda (yangi, v0'da yo'q). */
  status: SessionStatusSchema,
  cwd: CwdSchema,
  /**
   * Additiv: `cwd` git ildizi (`.git` topilgan) bo'lsa `'git'`, aks holda `'dir'`. Center shunga qarab: git ildizi uchun
   * loyiha shu yo'l bilan yaratiladi; `dir` bo'lsa eng yaqin ma'lum ota loyiha ishlatiladi. Eski agentd'da yo'q.
   */
  rootKind: z.enum(['git', 'dir']).optional(),
  /** Center 2000 belgidan uzunini RAD etadi: agentd o'zi qisqartiradi. */
  message: z.string().max(2000).nullish(),
  notificationType: z.string().max(64).nullish(),
  transcriptPath: z.string().max(4096).nullish(),
  /** Tugash sababi (`status: 'ended'` bilan): `vanished`, `logout`, `clear`, ... Bo'lmasa NULL. */
  reason: z.string().max(64).nullish(),
  /** Hook'dagi `permission_mode` (`default`, `acceptEdits`, `plan`, `bypassPermissions`, ...). Ixtiyoriy; yo'q bo'lsa markaz avvalgisini saqlaydi. */
  permissionMode: z.string().min(1).max(32).nullish(),
  /**
   * Faol vazifa id'si (task 2.9; additiv). FAQAT id (`1.4`): prompt matni hech qachon yuborilmaydi.
   * `taskSource='explicit'`: `/task <id>` yoki `#task:<id>`; `'branch'`: git branch nomidan TAXMIN.
   * `taskKey` yo'q/null + `taskSource='branch'` = branch endi vazifaga mos kelmaydi (markaz branch-span'ni yopadi).
   * Faqat marker/branch o'zgarganda yuboriladi (har hodisada emas).
   */
  taskKey: z.string().min(1).max(32).nullish(),
  taskSource: z.enum(['explicit', 'branch']).nullish(),
  /** 3.5 (additiv): `SessionStart`da git HEAD sha'si (sessiya diff'i bazasi). Faqat sha; git yo'q bo'lsa yo'q. */
  headSha: z.string().regex(/^[0-9a-f]{7,64}$/).nullish(),
  /**
   * Hodisa YUZ BERGAN vaqt (epoch ms; agentd soati). Center buni `session_events.ts` va sessiya
   * holati vaqti sifatida ishlatadi. Qayta yuborishda o'zgarmasin. Kelajakdagi ts (>now) serverda now ga
   * tushiriladi; `statusSince` dan eski hodisa faqat jurnalga yoziladi, joriy holatni o'zgartirmaydi.
   */
  ts: EpochMsSchema,
});
export type AgentEvent = z.infer<typeof AgentEventSchema>;

export const AgentEventsPayloadSchema = z.object({
  events: z.array(AgentEventSchema).min(1).max(AGENT_LIMITS.maxEventsPerBatch),
});
export type AgentEventsPayload = z.infer<typeof AgentEventsPayloadSchema>;
export const AgentEventsMessageSchema = envelopeMessage('agent.events', AgentEventsPayloadSchema);
export type AgentEventsMessage = z.infer<typeof AgentEventsMessageSchema>;

// --- agent.usage -----------------------------------------------------------------------------

export const USAGE_SOURCES = ['otel', 'transcript'] as const;
export const UsageSourceSchema = z.enum(USAGE_SOURCES);
export type UsageSource = z.infer<typeof UsageSourceSchema>;

export const UsageRecordSchema = z.object({
  /** Anthropic `request_id` (OTel) yoki transcript `requestId`. Dedup kaliti (machine, requestId, ts). */
  requestId: z.string().min(1).max(255),
  claudeSessionId: SessionIdSchema,
  /** Loyiha atributsiyasi uchun: center `upsert_project(machine, cwd)` chaqiradi. Yo'q bo'lsa project = NULL. */
  cwd: CwdSchema.optional(),
  model: z.string().min(1).max(128),
  inputTokens: TokenCountSchema,
  outputTokens: TokenCountSchema,
  cacheReadTokens: TokenCountSchema,
  cacheCreationTokens: TokenCountSchema,
  /** API-ekvivalent narx (obunada haqiqiy to'lov emas). */
  costUsd: z.number().min(0).max(1_000_000).nullish(),
  promptId: z.string().min(1).max(255).optional(),
  source: UsageSourceSchema,
  /**
   * SO'ROVNING O'Z vaqti (API javobi vaqti, epoch ms). Bitta request uchun HAR DOIM bir xil qiymat
   * (qayta yuborishda ham, OTel va transcript manbalari orasida ham): dedup kaliti
   * (machine, requestId, ts) shunga tayanadi. `Date.now()` ishlatmang.
   */
  ts: EpochMsSchema,
});
export type UsageRecord = z.infer<typeof UsageRecordSchema>;

export const AgentUsagePayloadSchema = z.object({
  records: z.array(UsageRecordSchema).min(1).max(AGENT_LIMITS.maxUsageRecordsPerBatch),
});
export type AgentUsagePayload = z.infer<typeof AgentUsagePayloadSchema>;
export const AgentUsageMessageSchema = envelopeMessage('agent.usage', AgentUsagePayloadSchema);
export type AgentUsageMessage = z.infer<typeof AgentUsageMessageSchema>;

// --- agent.limits ----------------------------------------------------------------------------

export const LimitWindowSchema = z.object({
  /** Foiz (status line `used_percentage`), 0..1000 (100 dan oshishi mumkin). */
  usedPct: z.number().min(0).max(1000),
  /** Oyna qachon yangilanadi, epoch ms (agentd status line'dagi sekundni ms ga o'giradi). */
  resetsAt: EpochMsSchema,
});
export type LimitWindow = z.infer<typeof LimitWindowSchema>;

export const AgentLimitsPayloadSchema = z
  .object({
    fiveHour: LimitWindowSchema.optional(),
    sevenDay: LimitWindowSchema.optional(),
    claudeSessionId: SessionIdSchema.optional(),
    /**
     * Qiymat kuzatilgan vaqt (epoch ms). Retry'da o'zgarmasin: (machine, 'official', observedAt) dedup kaliti.
     * Markazda akkaunt bo'yicha eng yangi `observedAt` g'olib.
     */
    observedAt: EpochMsSchema,
  })
  .refine((v) => v.fiveHour !== undefined || v.sevenDay !== undefined, {
    message: 'at least one of fiveHour / sevenDay is required',
  });
export type AgentLimitsPayload = z.infer<typeof AgentLimitsPayloadSchema>;
export const AgentLimitsMessageSchema = envelopeMessage('agent.limits', AgentLimitsPayloadSchema);
export type AgentLimitsMessage = z.infer<typeof AgentLimitsMessageSchema>;

// --- center -> agent: ack / nack -------------------------------------------------------------

/**
 * `ids` = qabul qilingan agent xabarlarining `envelope.id` lari. Ack FAQAT DB COMMIT'dan keyin.
 * Allaqachon qayta ishlangan (dublikat) xabar ham ack qilinadi.
 */
export const AckPayloadSchema = z.object({
  ids: z.array(z.uuid()).min(1).max(AGENT_LIMITS.maxAckIds),
});
export type AckPayload = z.infer<typeof AckPayloadSchema>;
export const AckMessageSchema = envelopeMessage('ack', AckPayloadSchema);
export type AckMessage = z.infer<typeof AckMessageSchema>;

/**
 * - `invalid_payload` (retriable=false): sxemaga mos emas. agentd xabarni outbox'dan O'CHIRSIN (qayta yuborish foydasiz).
 * - `unknown_type` (retriable=false): center bu `type` ni bilmaydi.
 * - `rate_limited` (retriable=true): `retryAfterMs` dan keyin shu xabarni qayta yuboring.
 * - `internal` (retriable=true): center vaqtincha qayta ishlay olmadi (DB xatosi); backoff bilan qayta yuboring.
 */
export const NACK_CODES = ['invalid_payload', 'unknown_type', 'rate_limited', 'internal'] as const;
export const NackCodeSchema = z.enum(NACK_CODES);
export type NackCode = z.infer<typeof NackCodeSchema>;

export const NackPayloadSchema = z.object({
  /** Rad etilgan xabarning `envelope.id` si (envelope o'qilgan bo'lsa). */
  id: z.uuid().optional(),
  code: NackCodeSchema,
  message: z.string().max(500),
  retriable: z.boolean(),
  retryAfterMs: z.number().int().positive().optional(),
});
export type NackPayload = z.infer<typeof NackPayloadSchema>;
export const NackMessageSchema = envelopeMessage('nack', NackPayloadSchema);
export type NackMessage = z.infer<typeof NackMessageSchema>;

// --- Birlashtirilgan unionlar ----------------------------------------------------------------

/** Autentifikatsiyadan KEYIN agent yuborishi mumkin bo'lgan xabarlar. */
export const AgentToCenterMessageSchema = z.discriminatedUnion('type', [
  AgentHeartbeatMessageSchema,
  AgentEventsMessageSchema,
  AgentUsageMessageSchema,
  AgentLimitsMessageSchema,
  AgentProjectSnapshotMessageSchema,
  ApprovalRequestMessageSchema,
  ApprovalCancelMessageSchema,
  CommandAckMessageSchema,
  CommandResultMessageSchema,
  ChatItemsFromAgentMessageSchema,
  ChatErrorFromAgentMessageSchema,
  MailboxRequestMessageSchema,
  AgentHealthMessageSchema,
  ConfigChunkMessageSchema,
  KeyRotateMessageSchema,
  LogsChunkMessageSchema,
]);
export type AgentToCenterMessage = z.infer<typeof AgentToCenterMessageSchema>;

export const CenterToAgentMessageSchema = z.discriminatedUnion('type', [
  AuthChallengeMessageSchema,
  AuthOkMessageSchema,
  AuthErrorMessageSchema,
  AckMessageSchema,
  NackMessageSchema,
  ApprovalDecisionMessageSchema,
  ApprovalExpiredMessageSchema,
  CommandDispatchMessageSchema,
  ChatStreamStartMessageSchema,
  ChatStreamStopMessageSchema,
  ChatStreamPageMessageSchema,
  MailboxReplyMessageSchema,
  ConfigChunkMessageSchema,
  KeyRotateResultMessageSchema,
  KeyRotationRequiredMessageSchema,
  LogsStopMessageSchema,
]);
export type CenterToAgentMessage = z.infer<typeof CenterToAgentMessageSchema>;

/** Ack qilinadigan (ma'lumot tashuvchi) xabar turlari. */
export const ACKED_MESSAGE_TYPES = ['agent.events', 'agent.usage', 'agent.limits', 'agent.project_snapshot', 'approval.request', 'approval.cancel', 'command.ack', 'command.result'] as const;

/** agent -> center turlari (autentifikatsiyadan keyin); noma'lum `type` `unknown_type`, yaroqsiz payload `invalid_payload` nack oladi. */
export const AGENT_MESSAGE_TYPES = [
  'agent.heartbeat',
  'agent.events',
  'agent.usage',
  'agent.limits',
  'agent.project_snapshot',
  'approval.request',
  'approval.cancel',
  'command.ack',
  'command.result',
  'chat.items',
  'chat.error',
  'mailbox.request',
  'agent.health',
  'config.chunk',
  'key.rotate',
  'logs.chunk',
] as const;
