import type { KeyObject } from 'node:crypto';
import { loadavg } from 'node:os';
import WebSocket from 'ws';
import {
  AGENT_LIMITS,
  CenterToAgentMessageSchema,
  createEnvelope,
} from '@commander/contracts';
import type { CenterKeyRotation, KeyRotatePayload, KeyRotateResultPayload } from '@commander/contracts';
import type { ActiveSession, AgentControlState, ConfigChunkPayload, ConfigStateReport, AgentEvent, AgentLimitsPayload, ProjectSnapshotPayload, UsageRecord } from '@commander/contracts';
import { signAgentAuth } from './identity.js';
import { errMsg, type Logger } from './logger.js';
import type { ApprovalManager } from './approval-manager.js';
import type { CommandManager } from './command-manager.js';
import type { ChatStreamManager } from './chat-stream.js';
import type { LogsTail } from './logs-tail.js';
import type { MailboxClient } from './mailbox-client.js';
import type { Outbox, OutboxType } from './outbox.js';
import { backoffDelay, decideReconnect } from './reconnect-policy.js';

export type ClientState = 'idle' | 'connecting' | 'authenticating' | 'ready' | 'backoff' | 'halted' | 'stopped';

export interface WsClientOptions {
  url: string;
  deviceId: string;
  privateKey: KeyObject;
  outbox: Outbox;
  log: Logger;
  agentdVersion: string;
  hostname: string;
  os: string;
  claudeVersion?: () => string | undefined;
  /** Heartbeat uchun joriy tirik sessiyalar (`claude agents --json`); `undefined` = noma'lum, yuborilmaydi. */
  activeSessions?: () => ActiveSession[] | undefined;
  now?: () => number;
  random?: () => number;
  /** Testlar uchun: backoff'ni tezlashtirish. */
  backoff?: { baseMs?: number; maxMs?: number };
  /** Barqaror ulanish shuncha ms davom etsa backoff hisoblagichi nolga tushadi. */
  stableAfterMs?: number;
  pingIntervalMs?: number;
  /** Remote permission (1.7): approval.* xabarlari shu orqali. */
  approvals?: ApprovalManager;
  /** Chat oqimlari: `chat.stream.*` xabarlari shu orqali. */
  chat?: ChatStreamManager;
  /** Log ko'ruvchi (6.6): `logs.stop` shu orqali; ulanish uzilsa oqimlar to'xtatiladi. */
  logs?: LogsTail;
  /** Remote buyruqlar (2.3): `command.dispatch` shu orqali; ack/nack ham avval shunga beriladi. */
  commands?: CommandManager;
  /** Sessiyalararo xabar (2.10): `mailbox.reply` shu orqali. */
  mailbox?: MailboxClient;
  /** Sozlamalar sinxronlash (3.7): `config.chunk` qabul qilish va heartbeat'ga drift hisoboti. */
  config?: { onChunk(c: ConfigChunkPayload): void; heartbeatReport(first: boolean): ConfigStateReport | undefined };
  /** Heartbeat'ga lokal siyosat holati. */
  control?: () => AgentControlState | undefined;
  /** `auth.ok.centerPublicKey` (yoki `undefined`): chaqiruvchi pin qiladi/solishtiradi. */
  onCenterKey?: (publicKey: string | undefined) => void;
  /** Markaz kaliti aylantirilgan (5.1): `auth.ok.centerKeyRotations` (eski kalit imzosi); `onCenterKey`dan OLDIN chaqiriladi. */
  onCenterKeyRotations?: (rotations: CenterKeyRotation[]) => void;
  /** Agentning pin qilgan markaz kaliti fingerprint'i: `auth.response`da yuboriladi (center faqat shunga e'lon beradi). */
  centerKeyFingerprint?: () => string | undefined;
  /** Markaz qurilma kalitini aylantirishni talab qilmoqda (5.1): `auth.ok.rotationRequired` yoki `key.rotation_required`. */
  onRotationRequired?: () => void;
  /**
   * Zaxira (aylantirishdan keyin diskda qolgan) kalit (5.1): `key.rotate` markazda qo'llangan-u, lokal almashtirish yetib
   * bormagan bo'lsa (qulash/uzilish) eski kalit `unauthorized` oladi, keyingi urinish zaxira kalit bilan bo'ladi.
   */
  fallbackKey?: () => KeyObject | undefined;
  /** Zaxira kalit bilan auth muvaffaqiyatli: chaqiruvchi uni asosiy qiladi (fayl almashtirish). */
  onFallbackKeyAccepted?: (key: KeyObject) => void;
  /** Asosiy kalit bilan auth muvaffaqiyatli: chaqiruvchi eskirgan zaxira faylni o'chiradi. */
  onPrimaryKeyConfirmed?: () => void;
}

const TYPE_TO_MESSAGE = { events: 'agent.events', usage: 'agent.usage', limits: 'agent.limits', projects: 'agent.project_snapshot' } as const;
const SEND_ORDER: OutboxType[] = ['events', 'limits', 'usage', 'projects'];
/** Xabarlar orasidagi eng kichik oraliq (center: 600 xabar/daqiqa). */
const MIN_SEND_GAP_MS = 150;
const MAX_BATCH_BYTES = 200 * 1024;

interface InFlight {
  type: OutboxType;
  seqs: number[];
  attempts: number;
}

/**
 * center bilan outbound WSS: challenge-response auth, heartbeat, outbox ->`agent.*` xabarlari, ack/nack, qayta ulanish.
 * Har turdan bir vaqtda BITTA xabar uchishda (tartib saqlanadi); ack kelgach navbatdagisi. Ack kelmagan xabarlar
 * ulanish uzilsa outbox'da qoladi va qayta ulangach qayta yuboriladi (center idempotent).
 */
export class AgentWsClient {
  private ws: WebSocket | undefined;
  private state: ClientState = 'idle';
  private attempts = 0;
  private readySince = 0;
  private lastAckAt = 0;
  private heartbeatMs = 15_000;
  private serverLimits: { maxEventsPerBatch: number; maxUsageRecordsPerBatch: number; maxMessageBytes: number } = { maxEventsPerBatch: AGENT_LIMITS.maxEventsPerBatch, maxUsageRecordsPerBatch: AGENT_LIMITS.maxUsageRecordsPerBatch, maxMessageBytes: AGENT_LIMITS.maxMessageBytes };
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private pingTimer: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private pumpTimer: NodeJS.Timeout | undefined;
  private pongPending = false;
  private lastSendAt = 0;
  private pausedUntil = 0;
  private readonly inflight = new Map<string, InFlight>();
  private readonly inflightByType = new Map<OutboxType, string>();
  private readonly now: () => number;
  private readonly random: () => number;
  private signingKey: KeyObject;
  private usingFallback = false;
  private readonly pendingRotations = new Map<string, (r: KeyRotateResultPayload) => void>();

  constructor(private readonly o: WsClientOptions) {
    this.now = o.now ?? Date.now;
    this.random = o.random ?? Math.random;
    this.signingKey = o.privateKey;
  }

  /** Aylantirish muvaffaqiyatli: keyingi ulanishlar yangi kalit bilan imzolanadi (5.1). */
  setSigningKey(key: KeyObject): void {
    this.signingKey = key;
    this.usingFallback = false;
  }

  /**
   * `key.rotate` yuboradi va `key.rotate.result` ni kutadi (jonli, ack'siz). Ulanish tayyor bo'lmasa yoki muddat (15 s)
   * tugasa rad etadi: markaz natijani qo'llagan bo'lishi MUMKIN, shuning uchun chaqiruvchi zaxira kalitni saqlaydi.
   */
  rotateKey(payload: KeyRotatePayload, timeoutMs = 15_000): Promise<KeyRotateResultPayload> {
    return new Promise((resolve, reject) => {
      if (this.state !== 'ready') return reject(new Error('center bilan ulanish tayyor emas'));
      const id = this.send('key.rotate', payload);
      if (!id) return reject(new Error('key.rotate yuborib bo\'lmadi'));
      const timer = setTimeout(() => {
        this.pendingRotations.delete(id);
        reject(new Error('key.rotate.result kelmadi (timeout)'));
      }, timeoutMs);
      timer.unref();
      this.pendingRotations.set(id, (r) => {
        clearTimeout(timer);
        this.pendingRotations.delete(id);
        resolve(r);
      });
    });
  }

  start(): void {
    if (this.state !== 'idle' && this.state !== 'stopped') return;
    this.connect();
  }

  async stop(): Promise<void> {
    this.state = 'stopped';
    this.clearTimers();
    const ws = this.ws;
    this.ws = undefined;
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          ws.terminate();
          resolve();
        }, 1000);
        ws.once('close', () => {
          clearTimeout(t);
          resolve();
        });
        ws.close(1000, 'agentd stopping');
      });
    }
  }

  /** `ApprovalManager` uchun transport (approval.request / approval.cancel yuborish). */
  isReady(): boolean {
    return this.state === 'ready';
  }

  /** `ChatStreamManager` uchun transport: ack/outbox YO'Q (jonli oqim, uzilsa yo'qoladi). */
  sendChat(type: 'chat.items' | 'chat.error', payload: unknown): boolean {
    if (this.state !== 'ready') return false;
    const ws = this.ws;
    if (!ws || ws.bufferedAmount > 4 * 1024 * 1024) return false; // sekin aloqa: xotira o'smasin
    return this.send(type, payload) !== undefined;
  }

  /** `LogsTail` uchun transport (6.6): jonli, ack/outbox YO'Q; `false` = band (ws buferi to'ldi: orqa bosim) yoki uzilgan. */
  sendLogs(payload: unknown): boolean {
    if (this.state !== 'ready') return false;
    const ws = this.ws;
    if (!ws || ws.bufferedAmount > 1024 * 1024) return false;
    return this.send('logs.chunk', payload) !== undefined;
  }

  /** `CommandManager` uchun transport: ack/natija jurnalda saqlanadi, shu sabab outbox shart emas. */
  sendCommand(type: 'command.ack' | 'command.result', payload: unknown): string | undefined {
    if (this.state !== 'ready') return undefined;
    return this.send(type, payload);
  }

  /** `MailboxClient` uchun transport: jonli (ack/outbox yo'q). */
  sendMailbox(type: 'mailbox.request', payload: unknown): boolean {
    if (this.state !== 'ready') return false;
    const ws = this.ws;
    if (!ws || ws.bufferedAmount > 4 * 1024 * 1024) return false;
    return this.send(type, payload) !== undefined;
  }

  /** `HealthReporter` uchun transport (3.8): jonli, ack/outbox yo'q (eski o'lchovning foydasi yo'q). */
  sendHealth(payload: unknown): boolean {
    if (this.state !== 'ready') return false;
    const ws = this.ws;
    if (!ws || ws.bufferedAmount > 4 * 1024 * 1024) return false;
    return this.send('agent.health', payload) !== undefined;
  }

  /** `ConfigSync` uchun transport (3.7): jonli bo'lak; `false` = band/uzilgan (chaqiruvchi kutib qayta urinadi). */
  sendConfigChunk(payload: unknown): boolean {
    if (this.state !== 'ready') return false;
    const ws = this.ws;
    if (!ws || ws.bufferedAmount > 2 * 1024 * 1024) return false;
    return this.send('config.chunk', payload) !== undefined;
  }

  sendApproval(type: 'approval.request' | 'approval.cancel', payload: unknown): string | undefined {
    if (this.state !== 'ready') return undefined;
    return this.send(type, payload);
  }

  /** outbox'ga yangi element tushganda chaqiriladi. */
  notifyEnqueued(): void {
    this.pump();
  }

  status(): Record<string, unknown> {
    return {
      state: this.state,
      connectedSince: this.state === 'ready' ? this.readySince : null,
      lastAckAt: this.lastAckAt || null,
      reconnectAttempts: this.attempts,
      inFlight: this.inflight.size,
      outbox: this.o.outbox.counts(),
    };
  }

  getState(): ClientState {
    return this.state;
  }

  // --- ulanish ---

  private connect(): void {
    if (this.state === 'stopped' || this.state === 'halted') return;
    this.state = 'connecting';
    const ws = new WebSocket(this.o.url, { handshakeTimeout: 15_000, maxPayload: 1024 * 1024 });
    this.ws = ws;
    ws.on('open', () => {
      if (this.ws !== ws) return;
      this.state = 'authenticating';
    });
    ws.on('message', (data, isBinary) => {
      if (this.ws !== ws) return;
      // Har qanday xabar ulanish tirikligini bildiradi
      this.pongPending = false;
      if (isBinary) return;
      this.onMessage(data.toString('utf8'));
    });
    ws.on('pong', () => {
      this.pongPending = false;
    });
    ws.on('error', (err) => {
      this.o.log.warn("WS xatosi", { error: errMsg(err) });
    });
    ws.on('close', (code, reason) => this.onClose(ws, code, reason.toString('utf8')));
  }

  private onClose(ws: WebSocket, code: number, reason: string): void {
    if (this.ws !== ws) return;
    this.ws = undefined;
    this.clearTimers();
    this.inflight.clear();
    this.inflightByType.clear();
    this.o.approvals?.onClosed();
    this.o.commands?.onClosed();
    this.o.chat?.stopAll(); // jonli oqimlar: markaz qayta ulangach o'zi qayta so'raydi
    this.o.logs?.stopAll(); // log oqimlari: markaz buferi ham yo'qoladi, qayta ulanganda klient qayta so'raydi
    if (this.state === 'stopped') return;

    if (this.state === 'ready' && this.now() - this.readySince >= (this.o.stableAfterMs ?? 30_000)) this.attempts = 0;
    const decision = decideReconnect(code);
    if (decision.action === 'stop') {
      this.state = 'halted';
      this.o.log.error("center qayta ulanishni taqiqladi: ulanish to'xtatildi", { code, reason: decision.reason });
      return;
    }
    let delay: number;
    if (decision.action === 'immediate') {
      delay = 200 + Math.round(this.random() * 300);
    } else {
      delay = Math.max(decision.minDelayMs, backoffDelay(this.attempts, { ...this.o.backoff, random: this.random }));
      this.attempts++;
    }
    this.state = 'backoff';
    this.o.log.warn('center bilan ulanish uzildi, qayta uriniladi', { code, reason: reason.slice(0, 80), retryInMs: delay, attempt: this.attempts });
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private clearTimers(): void {
    for (const t of [this.heartbeatTimer, this.pingTimer, this.reconnectTimer, this.pumpTimer]) if (t) clearTimeout(t);
    this.heartbeatTimer = this.pingTimer = this.reconnectTimer = this.pumpTimer = undefined;
  }

  // --- xabarlar ---

  private send(type: string, payload: unknown, id?: string): string | undefined {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return undefined;
    const env = createEnvelope(type, payload, this.now(), id);
    ws.send(JSON.stringify(env));
    this.lastSendAt = this.now();
    return env.id;
  }

  private onMessage(text: string): void {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      this.o.log.warn("center'dan yaroqsiz JSON keldi");
      return;
    }
    const parsed = CenterToAgentMessageSchema.safeParse(json);
    if (!parsed.success) {
      this.o.log.warn("center'dan noma'lum xabar keldi", { type: typeof json === 'object' && json !== null && 'type' in json ? String((json as { type: unknown }).type).slice(0, 64) : undefined });
      return;
    }
    const msg = parsed.data;
    switch (msg.type) {
      case 'auth.challenge': {
        const ts = this.now();
        const fallback = this.usingFallback ? this.o.fallbackKey?.() : undefined;
        const signature = signAgentAuth(fallback ?? this.signingKey, { nonce: msg.payload.nonce, ts, deviceId: this.o.deviceId });
        const claudeVersion = this.o.claudeVersion?.();
        const pinFp = this.o.centerKeyFingerprint?.();
        this.send('auth.response', {
          deviceId: this.o.deviceId,
          ts,
          signature,
          agentdVersion: this.o.agentdVersion,
          ...(claudeVersion ? { claudeVersion } : {}),
          hostname: this.o.hostname,
          os: this.o.os,
          ...(pinFp ? { centerKeyFingerprint: pinFp } : {}),
        });
        return;
      }
      case 'auth.ok':
        this.onAuthOk(msg.payload);
        return;
      case 'auth.error':
        this.o.log.error('center autentifikatsiyani rad etdi', { code: msg.payload.code, message: msg.payload.message });
        // 5.1: asosiy kalit rad etilsa (aylantirish markazda qo'llangan, lokal almashtirish yetib bormagan bo'lishi mumkin)
        // keyingi urinishda zaxira kalit sinab ko'riladi; u ham rad etilsa asosiyga qaytiladi.
        if (msg.payload.code === 'unauthorized') this.usingFallback = !this.usingFallback && this.o.fallbackKey?.() !== undefined;
        return;
      case 'key.rotate.result':
        this.pendingRotations.get(msg.payload.requestId)?.(msg.payload);
        return;
      case 'key.rotation_required':
        this.o.onRotationRequired?.();
        return;
      case 'ack':
        this.onAck(msg.payload.ids);
        return;
      case 'nack':
        this.onNack(msg.payload);
        return;
      case 'command.dispatch':
        this.o.commands?.onDispatch(msg.payload);
        return;
      case 'approval.decision':
        this.o.approvals?.onDecision(msg.payload);
        return;
      case 'approval.expired':
        this.o.approvals?.onExpired(msg.payload);
        return;
      case 'chat.stream.start':
        void this.o.chat?.onStart(msg.payload);
        return;
      case 'chat.stream.stop':
        this.o.chat?.onStop(msg.payload.streamId);
        return;
      case 'chat.stream.page':
        void this.o.chat?.onPage(msg.payload);
        return;
      case 'logs.stop':
        this.o.logs?.stop(msg.payload.commandId);
        return;
      case 'mailbox.reply':
        this.o.mailbox?.onReply(msg.payload);
        return;
      case 'config.chunk':
        this.o.config?.onChunk(msg.payload);
        return;
    }
  }

  private onAuthOk(p: { heartbeatIntervalMs: number; centerPublicKey?: string | undefined; centerKeyRotations?: CenterKeyRotation[] | undefined; rotationRequired?: boolean | undefined; limits: { maxEventsPerBatch: number; maxUsageRecordsPerBatch: number; maxMessageBytes: number } }): void {
    if (p.centerKeyRotations && p.centerKeyRotations.length > 0) this.o.onCenterKeyRotations?.(p.centerKeyRotations);
    this.o.onCenterKey?.(p.centerPublicKey);
    if (this.usingFallback) {
      const k = this.o.fallbackKey?.();
      this.usingFallback = false;
      if (k) {
        this.signingKey = k;
        this.o.onFallbackKeyAccepted?.(k);
      }
    } else {
      this.o.onPrimaryKeyConfirmed?.();
    }
    this.state = 'ready';
    this.readySince = this.now();
    this.heartbeatMs = p.heartbeatIntervalMs;
    this.serverLimits = { ...p.limits };
    this.o.outbox.clearRetryDelays();
    if (p.rotationRequired) this.o.onRotationRequired?.();
    this.o.log.info('center bilan autentifikatsiya muvaffaqiyatli', { heartbeatMs: this.heartbeatMs });
    this.sendHeartbeat(true);
    this.scheduleHeartbeat();
    this.startPing();
    this.pump();
    this.o.approvals?.onReady();
    this.o.commands?.onReady();
  }

  private sendHeartbeat(first = false): void {
    const sessions = this.o.activeSessions?.();
    const control = this.o.control?.();
    const config = this.o.config?.heartbeatReport(first);
    this.send('agent.heartbeat', {
      ...(sessions ? { activeSessions: sessions.slice(0, AGENT_LIMITS.maxActiveSessions) } : {}),
      load: Math.round((loadavg()[0] ?? 0) * 100) / 100,
      ...(control ? { control } : {}),
      ...(config ? { config } : {}),
    });
  }

  private scheduleHeartbeat(): void {
    this.heartbeatTimer = setTimeout(() => {
      if (this.state !== 'ready') return;
      this.sendHeartbeat();
      this.scheduleHeartbeat();
    }, this.heartbeatMs);
  }

  private startPing(): void {
    // Yangi ulanish: oldingi ulanishdan qolgan "pong kutilmoqda" belgisi uni darhol uzib qo'ymasligi kerak
    this.pongPending = false;
    const every = this.o.pingIntervalMs ?? 20_000;
    const tick = (): void => {
      const ws = this.ws;
      if (!ws || this.state !== 'ready') return;
      if (this.pongPending) {
        this.o.log.warn("pong kelmadi: ulanish uzildi deb hisoblanadi");
        ws.terminate();
        return;
      }
      this.pongPending = true;
      ws.ping();
      this.pingTimer = setTimeout(tick, every);
    };
    this.pingTimer = setTimeout(tick, every);
  }

  // --- outbox pump ---

  private pump(): void {
    if (this.state !== 'ready') return;
    const t = this.now();
    if (t < this.pausedUntil) return this.schedulePump(this.pausedUntil - t);
    let nextWake: number | null = null;

    for (const type of SEND_ORDER) {
      if (this.inflightByType.has(type)) continue;
      const gap = MIN_SEND_GAP_MS - (this.now() - this.lastSendAt);
      if (gap > 0) {
        nextWake = Math.min(nextWake ?? gap, gap);
        break;
      }
      const maxItems =
        type === 'events' ? Math.min(AGENT_LIMITS.maxEventsPerBatch, this.serverLimits.maxEventsPerBatch)
        : type === 'usage' ? Math.min(AGENT_LIMITS.maxUsageRecordsPerBatch, this.serverLimits.maxUsageRecordsPerBatch)
        : 1;
      const maxBytes = Math.min(MAX_BATCH_BYTES, Math.floor(this.serverLimits.maxMessageBytes * 0.8));
      const rows = this.o.outbox.nextBatch<AgentEvent | UsageRecord | AgentLimitsPayload | ProjectSnapshotPayload>(type, { maxItems, maxBytes });
      if (rows.length === 0) {
        const retryAt = this.o.outbox.nextRetryAt(type);
        if (retryAt !== null) nextWake = Math.min(nextWake ?? retryAt - this.now(), retryAt - this.now());
        continue;
      }
      const payload =
        type === 'events' ? { events: rows.map((r) => r.item) }
        : type === 'usage' ? { records: rows.map((r) => r.item) }
        : rows[0]!.item;
      const id = this.send(TYPE_TO_MESSAGE[type], payload);
      if (!id) return;
      this.inflight.set(id, { type, seqs: rows.map((r) => r.seq), attempts: Math.max(...rows.map((r) => r.attempts)) });
      this.inflightByType.set(type, id);
    }
    if (nextWake !== null) this.schedulePump(Math.max(1, nextWake));
  }

  private schedulePump(ms: number): void {
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = undefined;
      this.pump();
    }, ms);
  }

  private takeInflight(id: string): InFlight | undefined {
    const f = this.inflight.get(id);
    if (!f) return undefined;
    this.inflight.delete(id);
    if (this.inflightByType.get(f.type) === id) this.inflightByType.delete(f.type);
    return f;
  }

  private onAck(ids: string[]): void {
    for (const id of ids) {
      const f = this.takeInflight(id);
      if (!f) {
        if (this.o.commands?.onAck([id])) continue;
        this.o.approvals?.onAck([id]); // approval.request/cancel ack'i (yoki heartbeat: e'tiborsiz)
        continue;
      }
      this.o.outbox.ack(f.seqs);
      this.lastAckAt = this.now();
    }
    this.pump();
  }

  private onNack(p: { id?: string | undefined; code: string; message: string; retriable: boolean; retryAfterMs?: number | undefined }): void {
    const f = p.id ? this.takeInflight(p.id) : undefined;
    if (!f && (this.o.commands?.onNack(p.id) || this.o.approvals?.onNack(p))) {
      this.pump();
      return;
    }
    if (!f) {
      // Konvert o'qilmagan nack: faqat rate-limit bo'lsa umumiy pauza.
      if (p.code === 'rate_limited') this.pausedUntil = this.now() + (p.retryAfterMs ?? 5000);
      this.o.log.warn("center nack yubordi (xabarga bog'lanmagan)", { code: p.code, message: p.message });
      this.pump();
      return;
    }
    if (!p.retriable) {
      this.o.outbox.drop(f.seqs);
      this.o.log.error("center xabarni qaytarib bo'lmaydigan tarzda rad etdi: ma'lumot outbox'dan o'chirildi", {
        type: f.type,
        code: p.code,
        message: p.message,
        items: f.seqs.length,
      });
    } else {
      const wait = Math.max(p.retryAfterMs ?? 0, backoffDelay(f.attempts, { ...this.o.backoff, random: this.random }));
      this.o.outbox.retryAt(f.seqs, this.now() + wait);
      this.o.log.warn('center nack (qayta uriniladi)', { type: f.type, code: p.code, retryInMs: wait, items: f.seqs.length });
    }
    this.pump();
  }
}

