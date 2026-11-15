import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { Logger } from '@nestjs/common';
import type { RawData, WebSocket } from 'ws';
import {
  AGENT_LIMITS,
  AGENT_MESSAGE_TYPES,
  AGENT_WS_CLOSE,
  AgentToCenterMessageSchema,
  AuthResponseMessageSchema,
  EnvelopeSchema,
  createEnvelope,
} from '@commander/contracts';
import type { AuthErrorCode, Envelope, NackCode } from '@commander/contracts';
import type { Device } from '../database/entities/device.entity.js';
import type { AuditService } from '../identity/audit/audit.service.js';
import type { DeviceKeysService, KeyRotateOutcome } from '../identity/devices/device-keys.service.js';
import { fingerprintOfRaw } from '../commands/center-key-rotation.js';
import { FixedWindowLimiter } from '../identity/common/rate-limiter.js';
import type { SecurityEvents } from '../identity/common/security-events.service.js';
import { SignatureError } from '../identity/devices/device-signature.verifier.js';
import type { DeviceSignatureVerifier } from '../identity/devices/device-signature.verifier.js';
import type { AgentChannelOptions } from './agent-channel.options.js';
import { ApprovalOverloadError, ApprovalRejectedError } from '../approvals/approvals.errors.js';
import type { ApprovalsService } from '../approvals/approvals.service.js';
import type { AgentDispatchService, AgentSender } from '../realtime/agent-dispatch.service.js';
import type { AgentIngestService } from './agent-ingest.service.js';
import type { AgentPresenceService } from './agent-presence.service.js';
import type { ProjectSnapshotService } from '../projects/project-snapshot.service.js';
import type { ChatRelayService } from '../chat/chat-relay.service.js';
import type { LogsRelayService } from '../logs/logs-relay.service.js';
import type { MessagingService } from '../messaging/messaging.service.js';
import type { MachineHealthService } from '../health/machine-health.service.js';
import type { ConfigSyncService } from '../config-sync/config-sync.service.js';
import { CommandRejectedError } from '../commands/commands.errors.js';
import type { CommandSignerService } from '../commands/command-signer.service.js';
import type { CommandsService } from '../commands/commands.service.js';

/** Ulanish ro'yxati: bitta qurilma = bitta faol ulanish. */
export interface ConnectionRegistry {
  /** Qurilma uchun faol ulanishni belgilaydi; oldingisini qaytaradi (chaqiruvchi uni yopadi). */
  activate(deviceId: string, conn: AgentConnection): AgentConnection | null;
  /** `conn` hali faol edi (true) yoki allaqachon almashtirilgan edi (false). */
  release(deviceId: string, conn: AgentConnection): boolean;
  forget(conn: AgentConnection): void;
}

export interface AgentConnectionDeps {
  verifier: Pick<DeviceSignatureVerifier, 'verifyAgentChallenge' | 'isRevoked'>;
  ingest: Pick<AgentIngestService, 'ingestEvents' | 'ingestUsage' | 'ingestLimits'>;
  presence: Pick<AgentPresenceService, 'markOnline' | 'markOffline' | 'touch' | 'touchSessions'> & Partial<Pick<AgentPresenceService, 'updateControl'>>;
  security: Pick<SecurityEvents, 'wsAuthFailed' | 'agentPresence'>;
  approvals: Pick<ApprovalsService, 'handleRequest' | 'handleCancel' | 'redeliver'>;
  dispatch: Pick<AgentDispatchService, 'register' | 'unregister'>;
  /** Chat oqimi (jonli, ack'siz): yo'q bo'lsa chat xabarlari jim tashlanadi. */
  chat?: Pick<ChatRelayService, 'onAgentItems' | 'onAgentError'>;
  /** Log ko'ruvchi (6.6): `logs.chunk` jonli, ack'siz; yo'q bo'lsa jim tashlanadi. Matn hech qayerda log qilinmaydi. */
  logs?: Pick<LogsRelayService, 'onAgentChunk'>;
  /** Loyiha snapshot'lari (2.1): yo'q bo'lsa `agent.project_snapshot` `invalid_payload` nack oladi. */
  projects?: Pick<ProjectSnapshotService, 'ingest'>;
  /** Remote buyruqlar (2.3): yo'q bo'lsa `command.ack|result` `invalid_payload` nack oladi. */
  commands?: Pick<CommandsService, 'handleAck' | 'handleResult'>;
  /** Markaz imzo kalitining public qismi `auth.ok` da e'lon qilinadi (agentd pin qiladi). */
  signer?: Pick<CommandSignerService, 'publicKey'> & Partial<Pick<CommandSignerService, 'rotationsFor'>>;
  /** Qurilma kalitini aylantirish (5.1): yo'q bo'lsa `key.rotate` rad etiladi (`conflict`). */
  keys?: Pick<DeviceKeysService, 'rotate'>;
  /** Markaz kaliti aylantirish e'loni yetkazilganda audit (5.1). */
  audit?: Pick<AuditService, 'record'>;
  /** Sessiyalararo xabar (2.10): jonli so'rov/javob (ack'siz). Yo'q bo'lsa `mailbox.request` jim tashlanadi (agentd vaqt tugashi bilan xato beradi). */
  mailbox?: Pick<MessagingService, 'handleMailbox'>;
  /** Server salomatligi (3.8): jonli (ack'siz); yo'q bo'lsa `agent.health` jim tashlanadi. */
  health?: Pick<MachineHealthService, 'ingest'>;
  /** Sozlamalar sinxronlash (3.7): `config.chunk` va heartbeat `config` hisoboti (jonli, ack'siz). */
  configSync?: Pick<ConfigSyncService, 'onChunk' | 'onHeartbeat'>;
  registry: ConnectionRegistry;
  options: AgentChannelOptions;
}

type State = 'awaiting_auth' | 'ready' | 'closing' | 'closed';

const PAUSE_AT = 64;
const RESUME_AT = 16;
const FORCE_TERMINATE_MS = 2_000;

const AUTH_ERROR_BY_REASON: Record<string, AuthErrorCode> = {
  stale_timestamp: 'stale_timestamp',
  device_revoked: 'device_revoked',
};

const toBuffer = (data: RawData): Buffer =>
  Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);

/**
 * Bitta agentd WS ulanishi: challenge-response auth, so'ng ack/nack bilan ingest.
 *
 * Kafolatlar:
 *  - autentifikatsiyadan oldin FAQAT `auth.response` qabul qilinadi (boshqasi: close 4003);
 *  - nonce ulanishga bog'langan va birinchi `auth.response` da sarflanadi (muvaffaqiyatsiz bo'lsa ham);
 *  - xabarlar ketma-ket (navbat) qayta ishlanadi; `ack` FAQAT DB COMMIT'dan keyin;
 *  - 60 s (sozlanadi) hech narsa kelmasa ulanish yopiladi (mashina offline).
 */
export class AgentConnection {
  private readonly logger = new Logger(AgentConnection.name);
  private readonly nonce = randomBytes(32).toString('base64url');
  private state: State = 'awaiting_auth';
  private device: Device | null = null;
  private machineId: string | null = null;
  private activated = false;
  private sender: AgentSender | null = null;
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;
  private paused = false;
  private lastActivity = Date.now();
  private lastRevokeCheck = Date.now();
  private authTimer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private readonly limiter: FixedWindowLimiter;
  private resolveClosed!: () => void;
  /** Ulanish yopilib, presence tozalangach bajariladi (graceful shutdown kutadi). */
  readonly closed = new Promise<void>((resolve) => {
    this.resolveClosed = resolve;
  });

  constructor(
    private readonly socket: WebSocket,
    private readonly req: IncomingMessage,
    private readonly deps: AgentConnectionDeps,
  ) {
    this.limiter = new FixedWindowLimiter(deps.options.maxMessagesPerMinute, 60_000, 4);
  }

  get deviceId(): string | null {
    return this.device?.id ?? null;
  }

  get authenticated(): boolean {
    return this.state === 'ready';
  }

  start(): void {
    this.socket.on('message', (data, isBinary) => this.onFrame(data, isBinary));
    this.socket.on('close', () => this.onSocketClosed());
    this.socket.on('error', (err) => this.logger.warn(`socket error: ${err.message}`));

    this.authTimer = setTimeout(() => this.onAuthTimeout(), this.deps.options.authTimeoutMs);
    this.authTimer.unref();

    this.send('auth.challenge', {
      nonce: this.nonce,
      serverTime: Date.now(),
      expiresInMs: this.deps.options.authTimeoutMs,
    });
  }

  /** Tashqaridan yopish (almashtirish, shutdown). */
  close(code: number, reason: string): void {
    if (this.state === 'closing' || this.state === 'closed') return;
    this.state = 'closing';
    try {
      this.socket.close(code, reason.slice(0, 120));
    } catch {
      this.socket.terminate();
    }
    // Peer yopish kadriga javob bermasa ham tez tugatamiz.
    setTimeout(() => this.socket.terminate(), FORCE_TERMINATE_MS).unref();
  }

  // --- kadrlar -------------------------------------------------------------------------------

  private onFrame(data: RawData, isBinary: boolean): void {
    if (this.state === 'closing' || this.state === 'closed') return;
    if (isBinary) {
      this.close(AGENT_WS_CLOSE.protocolError, 'binary frames are not supported');
      return;
    }
    this.lastActivity = Date.now();
    const text = toBuffer(data).toString('utf8');

    this.pending += 1;
    if (!this.paused && this.pending >= PAUSE_AT) {
      this.paused = true;
      this.socket.pause();
    }
    this.queue = this.queue.then(() => this.handleText(text)).finally(() => {
      this.pending -= 1;
      if (this.paused && this.pending <= RESUME_AT) {
        this.paused = false;
        this.socket.resume();
      }
    });
  }

  private async handleText(text: string): Promise<void> {
    if (this.state === 'closing' || this.state === 'closed') return;
    try {
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        this.close(AGENT_WS_CLOSE.protocolError, 'invalid JSON');
        return;
      }
      const env = EnvelopeSchema.safeParse(json);
      if (!env.success) {
        this.close(AGENT_WS_CLOSE.protocolError, 'invalid envelope');
        return;
      }
      if (this.state === 'awaiting_auth') {
        if (env.data.type !== 'auth.response') {
          this.close(AGENT_WS_CLOSE.protocolError, 'authentication required');
          return;
        }
        await this.handleAuth(env.data);
        return;
      }
      await this.handleData(env.data);
    } catch (err) {
      // Kutilmagan xato: ulanishni yiqitmaymiz, lekin yashirmaymiz.
      this.logger.error(`unhandled error while handling a message: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      this.close(1011, 'internal error');
    }
  }

  // --- auth ----------------------------------------------------------------------------------

  private async handleAuth(env: Envelope): Promise<void> {
    this.clearAuthTimer(); // nonce shu yerda sarflanadi: natijadan qat'i nazar qayta ishlatilmaydi
    const parsed = AuthResponseMessageSchema.safeParse(env);
    if (!parsed.success) {
      this.rejectAuth('bad_request', 'auth.response does not match the schema');
      return;
    }
    const p = parsed.data.payload;

    let device: Device;
    try {
      device = await this.deps.verifier.verifyAgentChallenge({
        deviceId: p.deviceId,
        ts: p.ts,
        signature: p.signature,
        nonce: this.nonce,
      });
    } catch (err) {
      if (err instanceof SignatureError) {
        const code = AUTH_ERROR_BY_REASON[err.reason] ?? 'unauthorized';
        this.rejectAuth(code, code === 'unauthorized' ? 'authentication failed' : code, p.deviceId);
        return;
      }
      throw err; // DB xatosi va h.k.: handleText 1011 bilan yopadi
    }

    if (this.state !== 'awaiting_auth') return; // verify paytida ulanish yopilgan
    this.device = device;
    this.machineId = device.machineId;

    const previous = this.deps.registry.activate(device.id, this);
    this.activated = true;
    if (previous) previous.close(AGENT_WS_CLOSE.replaced, 'replaced by a newer connection');

    await this.deps.presence.markOnline(device.machineId!, {
      hostname: p.hostname,
      os: p.os,
      agentdVersion: p.agentdVersion,
      claudeVersion: p.claudeVersion ?? null,
    });
    this.deps.security.agentPresence(this.req, {
      action: 'agent.connected',
      deviceId: device.id,
      machineId: device.machineId!,
      details: { agentd_version: p.agentdVersion, claude_version: p.claudeVersion ?? null, os: p.os, replaced: previous !== null },
    });

    if (this.state !== 'awaiting_auth') return; // markOnline paytida yopilgan: onClosed tozalaydi
    this.state = 'ready';
    this.lastActivity = Date.now();
    this.startWatchdog();
    // center -> agent kanali (approval.decision/expired): faqat tasdiqlangan ulanish uchun.
    this.sender = {
      deviceId: device.id,
      send: (type, payload) => {
        if (this.state !== 'ready' || this.socket.readyState !== this.socket.OPEN) return false;
        this.send(type, payload);
        return true;
      },
    };
    const rotations = this.deps.signer?.rotationsFor?.(p.centerKeyFingerprint) ?? [];
    if (rotations.length > 0 && this.deps.audit) {
      // Eski pin'li agentga imzolangan e'lon yetkaziladi (pin TOFUsiz yangilanadi): audit, bir ulanishga bir marta.
      await this.deps.audit
        .record({
          actorKind: 'system',
          action: 'center_key.rotation_announced',
          target: device.id,
          details: { from_fingerprint: p.centerKeyFingerprint, to_fingerprint: fingerprintOfRaw(rotations[rotations.length - 1]!.newPublicKey), steps: rotations.length },
        })
        .catch((err: unknown) => this.logger.warn(`rotation announce audit failed: ${err instanceof Error ? err.message : String(err)}`));
    }
    this.send('auth.ok', {
      deviceId: device.id,
      machineId: device.machineId!,
      serverTime: Date.now(),
      heartbeatIntervalMs: this.deps.options.heartbeatIntervalMs,
      heartbeatTimeoutMs: this.deps.options.heartbeatTimeoutMs,
      limits: {
        maxMessageBytes: AGENT_LIMITS.maxMessageBytes,
        maxEventsPerBatch: AGENT_LIMITS.maxEventsPerBatch,
        maxUsageRecordsPerBatch: AGENT_LIMITS.maxUsageRecordsPerBatch,
        maxMessagesPerMinute: this.deps.options.maxMessagesPerMinute,
      },
      ...this.centerPublicKeyField(),
      ...(rotations.length > 0 ? { centerKeyRotations: rotations } : {}),
      ...(device.rotationRequired ? { rotationRequired: true } : {}),
    });
    // `auth.ok` dan KEYIN: chat relay shu paytda oqimlarni qayta boshlaydi (agentd `ready` bo'lgan bo'lishi shart)
    this.deps.dispatch.register(device.machineId!, this.sender);
    // Offline paytida berilgan, lekin yetkazilmagan qarorlar (deadline o'tmagan): auth.ok'dan KEYIN yuboriladi.
    this.deps.approvals.redeliver(device.machineId!).catch((err: unknown) => {
      this.logger.warn(`approval redelivery failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  private rejectAuth(code: AuthErrorCode, message: string, claimedDeviceId?: string): void {
    this.deps.security.wsAuthFailed(this.req, { reason: code, claimedDeviceId });
    this.send('auth.error', { code, message });
    this.close(code === 'device_revoked' ? AGENT_WS_CLOSE.revoked : AGENT_WS_CLOSE.authFailed, code);
  }

  private onAuthTimeout(): void {
    if (this.state !== 'awaiting_auth') return;
    this.deps.security.wsAuthFailed(this.req, { reason: 'timeout' });
    this.send('auth.error', { code: 'timeout', message: 'auth.response was not received in time' });
    this.close(AGENT_WS_CLOSE.authTimeout, 'authentication timeout');
  }

  // --- autentifikatsiyadan keyingi xabarlar --------------------------------------------------

  private async handleData(env: Envelope): Promise<void> {
    const device = this.device!;
    const machineId = this.machineId!;
    const now = Date.now();

    if (now - this.lastRevokeCheck >= this.deps.options.revokeCheckIntervalMs) {
      this.lastRevokeCheck = now;
      if (await this.deps.verifier.isRevoked(device.id)) {
        this.close(AGENT_WS_CLOSE.revoked, 'device revoked');
        return;
      }
    }

    const hits = this.limiter.hit('conn', now);
    if (hits > this.deps.options.maxMessagesPerMinute) {
      if (hits > this.deps.options.maxMessagesPerMinute * 3) {
        this.close(AGENT_WS_CLOSE.rateLimited, 'rate limit exceeded');
        return;
      }
      this.nack(env.id, 'rate_limited', 'too many messages', true, this.limiter.retryAfterSeconds('conn', now) * 1000);
      return;
    }

    const parsed = AgentToCenterMessageSchema.safeParse(env);
    if (!parsed.success) {
      const known = (AGENT_MESSAGE_TYPES as readonly string[]).includes(env.type);
      this.nack(env.id, known ? 'invalid_payload' : 'unknown_type', known ? `invalid ${env.type} payload` : `unknown type ${env.type.slice(0, 64)}`, false);
      return;
    }
    const msg = parsed.data;

    if (msg.type === 'agent.heartbeat') {
      // Heartbeat ack qilinmaydi. Xatosi yutilmaydi (log), lekin ulanishni yiqitmaydi.
      try {
        await this.deps.presence.touch(machineId);
        const ids = msg.payload.activeSessions?.map((s) => s.claudeSessionId) ?? [];
        await this.deps.presence.touchSessions(machineId, ids, msg.payload.activeSessions);
        if (msg.payload.control) await this.deps.presence.updateControl?.(machineId, msg.payload.control);
        if (msg.payload.config) await this.deps.configSync?.onHeartbeat(machineId, msg.payload.config);
      } catch (err) {
        this.logger.warn(`heartbeat bookkeeping failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    if (msg.type === 'chat.items' || msg.type === 'chat.error') {
      // Jonli oqim: ack/nack yo'q, DB yo'q; xabar tarkibi hech qayerda log qilinmaydi
      if (msg.type === 'chat.items') this.deps.chat?.onAgentItems(machineId, msg.payload);
      else this.deps.chat?.onAgentError(machineId, msg.payload);
      return;
    }

    if (msg.type === 'logs.chunk') {
      // Jonli log oqimi (6.6): ack/nack yo'q, DB yo'q; xotiradagi chegaralangan buferga
      this.deps.logs?.onAgentChunk(machineId, msg.payload);
      return;
    }

    if (msg.type === 'key.rotate') {
      // Qurilma kalitini aylantirish (5.1): jonli so'rov/javob (ack'siz). Xato sababi agentga qaytadi, sir (kalit/imzo) hech qayerga yozilmaydi.
      let outcome: KeyRotateOutcome = { ok: false, code: 'conflict' };
      try {
        if (this.deps.keys) outcome = await this.deps.keys.rotate(device.id, msg.payload, 'ws');
      } catch (err) {
        this.logger.error(`key rotation failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.send('key.rotate.result', { requestId: env.id, ...outcome });
      return;
    }

    if (msg.type === 'mailbox.request') {
      // Jonli so'rov/javob: xabar matni log/ack'da YO'Q; xato bo'lsa ham agentga javob (osilib qolmasin).
      if (this.deps.mailbox) this.send('mailbox.reply', await this.deps.mailbox.handleMailbox(machineId, device.id, msg.payload));
      return;
    }

    if (msg.type === 'config.chunk') {
      // Katta mazmun bo'lagi (capture natijasi): xotirada yig'iladi, ack/nack yo'q
      this.deps.configSync?.onChunk(machineId, msg.payload);
      return;
    }

    if (msg.type === 'agent.health') {
      // Jonli o'lchov: ack/nack yo'q (eskirgan o'lchov qayta yuborilmaydi). Xato log qilinadi, ulanishni yiqitmaydi.
      try {
        await this.deps.health?.ingest(machineId, msg.payload);
      } catch (err) {
        this.logger.warn(`health ingest failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    try {
      if (msg.type === 'agent.events') await this.deps.ingest.ingestEvents(machineId, msg.payload.events);
      else if (msg.type === 'agent.usage') await this.deps.ingest.ingestUsage(machineId, msg.payload.records);
      else if (msg.type === 'agent.limits') await this.deps.ingest.ingestLimits(machineId, msg.payload);
      else if (msg.type === 'agent.project_snapshot') {
        if (!this.deps.projects) throw new CommandRejectedError('project snapshots are not enabled');
        await this.deps.projects.ingest(machineId, msg.payload);
      }
      else if (msg.type === 'approval.request') await this.deps.approvals.handleRequest(machineId, msg.payload);
      else if (msg.type === 'command.ack' || msg.type === 'command.result') {
        if (!this.deps.commands) throw new CommandRejectedError('remote commands are not enabled');
        if (msg.type === 'command.ack') await this.deps.commands.handleAck(machineId, msg.payload);
        else await this.deps.commands.handleResult(machineId, msg.payload);
      } else await this.deps.approvals.handleCancel(machineId, msg.payload);
    } catch (err) {
      if (err instanceof ApprovalRejectedError || err instanceof CommandRejectedError) {
        this.nack(env.id, 'invalid_payload', err.message.slice(0, 200), false);
        return;
      }
      if (err instanceof ApprovalOverloadError) {
        this.nack(env.id, 'rate_limited', err.message.slice(0, 200), true, err.retryAfterMs);
        return;
      }
      this.logger.error(`ingest ${msg.type} failed: ${err instanceof Error ? err.message : String(err)}`);
      this.nack(env.id, 'internal', 'temporary failure, retry later', true, 1000);
      return;
    }
    this.send('ack', { ids: [env.id] }); // DB COMMIT'dan keyin
  }

  /** Markaz agentdan kalitni aylantirishni so'raydi (5.1). Tasdiqlanmagan ulanishga yuborilmaydi (u `auth.ok.rotationRequired`ni oladi). */
  requestRotation(): void {
    if (this.state === 'ready') this.send('key.rotation_required', {});
  }

  // --- yordamchilar --------------------------------------------------------------------------

  private nack(id: string, code: NackCode, message: string, retriable: boolean, retryAfterMs?: number): void {
    this.send('nack', { id, code, message, retriable, ...(retryAfterMs ? { retryAfterMs } : {}) });
  }

  private send(type: string, payload: unknown): void {
    if (this.socket.readyState !== this.socket.OPEN) return;
    this.socket.send(JSON.stringify(createEnvelope(type, payload)));
  }

  private startWatchdog(): void {
    const every = Math.max(50, Math.min(5_000, Math.floor(this.deps.options.heartbeatTimeoutMs / 4)));
    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastActivity > this.deps.options.heartbeatTimeoutMs) {
        this.close(AGENT_WS_CLOSE.heartbeatTimeout, 'heartbeat timeout');
      }
    }, every);
    this.watchdog.unref();
  }

  private clearAuthTimer(): void {
    if (this.authTimer) clearTimeout(this.authTimer);
    this.authTimer = null;
  }

  private onSocketClosed(): void {
    this.state = 'closed';
    this.clearAuthTimer();
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    // Navbatga qo'yiladi: davom etayotgan handleAuth/ingest tugagach (presence poygasi yo'q).
    this.queue = this.queue.then(() => this.cleanup()).catch((err: unknown) => {
      this.logger.error(`disconnect cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
    }).finally(() => this.resolveClosed());
  }

  private async cleanup(): Promise<void> {
    this.deps.registry.forget(this);
    if (this.sender && this.device?.machineId) this.deps.dispatch.unregister(this.device.machineId, this.sender);
    if (!this.activated || !this.device) return;
    const wasCurrent = this.deps.registry.release(this.device.id, this);
    if (!wasCurrent) return; // almashtirilgan: mashina yangi ulanish bilan online
    await this.deps.presence.markOffline(this.machineId!);
    this.deps.security.agentPresence(null, {
      action: 'agent.disconnected',
      deviceId: this.device.id,
      machineId: this.machineId!,
    });
  }

  /**
   * `auth.ok.centerPublicKey`. Imzolovchi hali hech javob bermagan bo'lsa (kesh yo'q) kalit yuborilmaydi: agent yangi pin
   * qilmaydi va buyruqlarni rad etadi (fail-safe), ulanishning o'zi buzilmaydi.
   */
  private centerPublicKeyField(): { centerPublicKey?: string } {
    if (!this.deps.signer) return {};
    try {
      return { centerPublicKey: this.deps.signer.publicKey };
    } catch (err) {
      this.logger.warn(`auth.ok without centerPublicKey: ${err instanceof Error ? err.message : String(err)}`);
      return {};
    }
  }
}
