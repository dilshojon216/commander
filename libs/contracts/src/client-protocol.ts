import { z } from 'zod';
import { ApprovalDtoSchema } from './approvals.js';
import { LimitsResponseSchema, MachineDtoSchema, SessionDtoSchema, TokenTotalsSchema } from './api.js';
import { EpochMsSchema, envelopeMessage } from './envelope.js';
import { ClientTokenScopeSchema } from './identity.js';
import { CommandUpdatedMessageSchema } from './commands.js';
import { ProjectUpdatedMessageSchema } from './projects.js';
import { AlertCreatedMessageSchema, AlertUpdatedMessageSchema } from './watchdog.js';
import { QueueUpdatedMessageSchema } from './queue.js';
import { OrchestrationUpdatedMessageSchema } from './orchestration.js';
import { MessageCreatedMessageSchema, MessageUpdatedMessageSchema } from './messaging.js';
import { MachineHealthUpdatedMessageSchema } from './health.js';
import { ChatCloseMessageSchema, ChatItemsToClientMessageSchema, ChatOpenMessageSchema, ChatStateMessageSchema } from './chat.js';

/**
 * Klient <-> center WebSocket kontrakti (task 1.6). Endpoint: `wss://<center>/ws/client`.
 * Envelope agent kanali bilan bir xil: `{ v:1, id, type, ts, payload }` (JSON matn kadri; binary = protokol xatosi).
 *
 * AUTH (token HECH QACHON query string'da emas: loglarga tushmasin). Ikki yo'l:
 *  1. `Sec-WebSocket-Protocol: commander.v1, cmdr-token.<cmdr_...>`: brauzer/Flutter/Swift uchun qulay;
 *     server `commander.v1` ni tanlaydi (token javobda qaytarilmaydi);
 *  2. ulangach 10 s ichida birinchi xabar `auth {token}`.
 * Muvaffaqiyat: `auth.ok`; xato: `auth.error` + close 4001 (4010: revoke/expired).
 *
 * OQIM: auth -> `subscribe {channels}` -> `subscribed`. Keyin server push'lari. Snapshot REST'dan:
 * TARTIB MUHIM: avval `subscribe`, keyin REST snapshot (aks holda oradagi delta yo'qoladi).
 * Push'lar "o'zgargan holat" (to'liq DTO), delta emas: klient id bo'yicha almashtiradi.
 * Kafolat: at-most-once, tartib har kalit uchun saqlanadi; qayta ulanganda snapshot qayta olinadi.
 *
 * Lockdown: o'qish push'lari davom etadi (lockdown faqat mutating amallarni to'sadi); holat o'zgarsa
 * `lockdown.updated` (hammaga, obunasiz). Revoke/expired: har ~5 s tekshiriladi, ulanish 4010 bilan uziladi.
 */

export const CLIENT_WS_PATH = '/ws/client';
export const CLIENT_WS_SUBPROTOCOL = 'commander.v1';
/** `Sec-WebSocket-Protocol` ichidagi token prefiksi: `cmdr-token.<token>`. */
export const CLIENT_WS_TOKEN_SUBPROTOCOL_PREFIX = 'cmdr-token.';

export const CLIENT_LIMITS = {
  /** Klient -> server bitta xabar (bayt). */
  maxMessageBytes: 16 * 1024,
  maxMessagesPerMinute: 120,
  authTimeoutMs: 10_000,
  /** `usage.tick` oralig'i (ms): shu oynada yig'ilgan delta'lar bitta xabarga jamlanadi. */
  usageTickMs: 2_000,
  /** Yozish buferi shundan oshsa sekin klient uziladi (1013). */
  maxBufferedBytes: 1024 * 1024,
} as const;

export const CLIENT_WS_CLOSE = {
  goingAway: 1001,
  authFailed: 4001,
  authTimeout: 4002,
  protocolError: 4003,
  rateLimited: 4008,
  /** Token revoke qilingan yoki muddati o'tgan. Qayta ulanmang. */
  revoked: 4010,
} as const;

/** Obuna kanallari. Hammasi `read` scope talab qiladi (`commands`: `command.updated`, 2.3; prompt matni redakt qilingan). */
export const CLIENT_CHANNELS = ['sessions', 'machines', 'usage', 'limits', 'approvals', 'commands', 'projects', 'messages', 'health', 'queue', 'alerts', 'orchestrations'] as const;
export const ClientChannelSchema = z.enum(CLIENT_CHANNELS);
export type ClientChannel = z.infer<typeof ClientChannelSchema>;

// --- klient -> server ------------------------------------------------------------------------

export const ClientAuthPayloadSchema = z.object({ token: z.string().min(1).max(128) });
export const ClientAuthMessageSchema = envelopeMessage('auth', ClientAuthPayloadSchema);

export const ClientSubscribePayloadSchema = z.object({ channels: z.array(ClientChannelSchema).min(1).max(CLIENT_CHANNELS.length) });
export type ClientSubscribePayload = z.infer<typeof ClientSubscribePayloadSchema>;
export const ClientSubscribeMessageSchema = envelopeMessage('subscribe', ClientSubscribePayloadSchema);
export const ClientUnsubscribeMessageSchema = envelopeMessage('unsubscribe', ClientSubscribePayloadSchema);
export const ClientPingMessageSchema = envelopeMessage('ping', z.object({}).optional());

export const ClientToServerMessageSchema = z.discriminatedUnion('type', [
  ClientAuthMessageSchema,
  ClientSubscribeMessageSchema,
  ClientUnsubscribeMessageSchema,
  ClientPingMessageSchema,
  ChatOpenMessageSchema,
  ChatCloseMessageSchema,
]);
export type ClientToServerMessage = z.infer<typeof ClientToServerMessageSchema>;

// --- server -> klient ------------------------------------------------------------------------

export const CLIENT_AUTH_ERROR_CODES = ['unauthorized', 'insufficient_scope', 'bad_request', 'timeout'] as const;
export const ClientAuthErrorCodeSchema = z.enum(CLIENT_AUTH_ERROR_CODES);

export const ServerAuthOkMessageSchema = envelopeMessage(
  'auth.ok',
  z.object({
    deviceId: z.uuid(),
    kind: z.string(),
    scopes: z.array(ClientTokenScopeSchema),
    serverTime: EpochMsSchema,
    channels: z.array(ClientChannelSchema),
    lockdown: z.object({ enabled: z.boolean(), since: z.string().nullable() }),
  }),
);
export const ServerAuthErrorMessageSchema = envelopeMessage('auth.error', z.object({ code: ClientAuthErrorCodeSchema, message: z.string().max(500) }));

export const ServerSubscribedMessageSchema = envelopeMessage('subscribed', z.object({ channels: z.array(ClientChannelSchema) }));
export const ServerPongMessageSchema = envelopeMessage('pong', z.object({ serverTime: EpochMsSchema }));
export const ServerErrorMessageSchema = envelopeMessage(
  'error',
  z.object({ code: z.enum(['invalid_message', 'unknown_type', 'rate_limited', 'not_authenticated']), message: z.string().max(500), id: z.uuid().optional() }),
);

export const SessionUpdatedMessageSchema = envelopeMessage('session.updated', z.object({ session: SessionDtoSchema }));
export const MachineUpdatedMessageSchema = envelopeMessage('machine.updated', z.object({ machine: MachineDtoSchema }));

export const UsageTickBucketSchema = TokenTotalsSchema.pick({
  inputTokens: true,
  outputTokens: true,
  cacheReadTokens: true,
  cacheCreationTokens: true,
  costUsd: true,
  requests: true,
});
/**
 * Jamlangan delta'lar (>= `usageTickMs` oralig'ida bittadan ko'p emas; yangi usage bo'lmasa yuborilmaydi).
 * Bu YANGI qo'shilgan tokenlar (jami emas): klient o'z hisoblagichiga qo'shadi; aniq jami uchun REST.
 */
export const UsageTickMessageSchema = envelopeMessage(
  'usage.tick',
  z.object({
    from: EpochMsSchema,
    to: EpochMsSchema,
    total: UsageTickBucketSchema,
    byMachine: z.array(z.object({ machineId: z.uuid() }).extend(UsageTickBucketSchema.shape)),
    /** `projectId = null`: cwd noma'lum. */
    byProject: z.array(z.object({ projectId: z.uuid().nullable() }).extend(UsageTickBucketSchema.shape)),
  }),
);

export const LimitsUpdatedMessageSchema = envelopeMessage('limits.updated', z.object({ limits: LimitsResponseSchema }));
export const ApprovalCreatedMessageSchema = envelopeMessage('approval.created', z.object({ approval: ApprovalDtoSchema }));
/** Har yakuniy holat uchun (approved|denied|expired|cancelled): `approval.status` ga qarang. */
export const ApprovalResolvedMessageSchema = envelopeMessage('approval.resolved', z.object({ approval: ApprovalDtoSchema }));
export const LockdownUpdatedMessageSchema = envelopeMessage('lockdown.updated', z.object({ enabled: z.boolean(), since: z.string().nullable() }));

export const ServerToClientMessageSchema = z.discriminatedUnion('type', [
  ServerAuthOkMessageSchema,
  ServerAuthErrorMessageSchema,
  ServerSubscribedMessageSchema,
  ServerPongMessageSchema,
  ServerErrorMessageSchema,
  SessionUpdatedMessageSchema,
  MachineUpdatedMessageSchema,
  UsageTickMessageSchema,
  LimitsUpdatedMessageSchema,
  ApprovalCreatedMessageSchema,
  ApprovalResolvedMessageSchema,
  LockdownUpdatedMessageSchema,
  CommandUpdatedMessageSchema,
  ProjectUpdatedMessageSchema,
  ChatItemsToClientMessageSchema,
  ChatStateMessageSchema,
  MessageCreatedMessageSchema,
  MessageUpdatedMessageSchema,
  AlertCreatedMessageSchema,
  AlertUpdatedMessageSchema,
  MachineHealthUpdatedMessageSchema,
  QueueUpdatedMessageSchema,
  OrchestrationUpdatedMessageSchema,
]);
export type ServerToClientMessage = z.infer<typeof ServerToClientMessageSchema>;
export type UsageTickPayload = z.infer<typeof UsageTickMessageSchema>['payload'];

/** Qaysi push turi qaysi kanalga tegishli (lockdown.updated kanalsiz: hammaga). */
export const CHANNEL_BY_PUSH_TYPE = {
  'session.updated': 'sessions',
  'machine.updated': 'machines',
  'usage.tick': 'usage',
  'limits.updated': 'limits',
  'approval.created': 'approvals',
  'approval.resolved': 'approvals',
  'command.updated': 'commands',
  'project.updated': 'projects',
  'message.created': 'messages',
  'message.updated': 'messages',
  'alert.created': 'alerts',
  'alert.updated': 'alerts',
  'machine.health': 'health',
  'queue.updated': 'queue',
  'orchestration.updated': 'orchestrations',
} as const satisfies Record<string, ClientChannel>;

/** Brauzer uchun `Sec-WebSocket-Protocol` qiymatlari ro'yxati. */
export function buildClientSubprotocols(token: string): string[] {
  return [CLIENT_WS_SUBPROTOCOL, `${CLIENT_WS_TOKEN_SUBPROTOCOL_PREFIX}${token}`];
}
