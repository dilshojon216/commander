import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CHAT_LIMITS } from '@commander/contracts';
import type {
  ChatErrorCode,
  ChatErrorFromAgentPayload,
  ChatItem,
  ChatItemsFromAgentPayload,
  ChatOpenPayload,
  ChatState,
} from '@commander/contracts';
import { redactText } from '../common/redact-text.js';
import { AuditService } from '../identity/audit/audit.service.js';
import type { AuditActorKind } from '../identity/audit/audit.service.js';
import { FixedWindowLimiter } from '../identity/common/rate-limiter.js';
import { AgentDispatchService } from '../realtime/agent-dispatch.service.js';

/**
 * Chat oqimi RELAY'i (PLAN "Qarorlar (2.x chat)"). MAXFIYLIK: matn markazda SAQLANMAYDI va LOGGA YOZILMAYDI.
 * Elementlar agentd -> center -> klient xotirasidan faqat o'tadi (ring-buffer/kesh ham yo'q); yangi klient
 * qo'shilsa agentd'dan qayta backfill so'raladi (resync).
 *
 * Bitta sessiya = bitta agent oqimi, bir nechta klient (ref-count): oxirgi klient ketgach `chat.stream.stop`.
 */

/** Klient ulanishi (WS) ko'rinishi: relay uni faqat shu interfeys orqali biladi. */
export interface ChatClientPort {
  readonly deviceId: string | null;
  readonly actorKind: string | null;
  pushChat(type: 'chat.items' | 'chat.state', payload: unknown): void;
}

export type OpenOutcome = 'ok' | 'rate_limited';

interface Sub {
  /** Backfill (replace ... done) hali kelmagan: faqat backfill xabarlari uzatiladi. */
  awaitingBackfill: boolean;
  /** Backfill'ning BOSHI (`replace`) shu klientga yetdi (o'rtasidan qo'shilgan klient to'liq bo'lmagan backfill olmasin). */
  synced: boolean;
}

interface Stream {
  sessionId: string;
  machineId: string;
  claudeSessionId: string;
  transcriptPath: string | null;
  /** Agentga yuborilgan joriy oqim id (offline/xato bo'lsa null). */
  streamId: string | null;
  state: ChatState;
  /** Agent `replace` xabaridan `done` gacha. */
  backfilling: boolean;
  tail: number;
  clients: Map<ChatClientPort, Sub>;
  startTimer: NodeJS.Timeout | null;
}

interface PendingPage {
  port: ChatClientPort;
  stream: Stream;
  expires: number;
}

const OPEN_RATE_PER_MINUTE = 30;
const AUDIT_DEDUPE_MS = 60_000;
const PAGE_TTL_MS = 30_000;

const STATE_BY_ERROR: Record<ChatErrorCode, ChatState> = {
  not_found: 'unavailable',
  forbidden_path: 'error',
  busy: 'error',
  read_failed: 'error',
  internal: 'error',
};

@Injectable()
export class ChatRelayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChatRelayService.name);
  private readonly streams = new Map<string, Stream>(); // sessionId -> stream
  private readonly byStreamId = new Map<string, Stream>();
  private readonly byPort = new Map<ChatClientPort, Set<string>>();
  private readonly pages = new Map<string, PendingPage>();
  private readonly openLimiter = new FixedWindowLimiter(OPEN_RATE_PER_MINUTE, 60_000, 1000);
  private readonly auditSeen = new Map<string, number>();
  private unsubscribePresence: (() => void) | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly dispatch: AgentDispatchService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.unsubscribePresence = this.dispatch.onPresence((machineId, online) => this.onPresence(machineId, online));
    this.sweepTimer = setInterval(() => this.sweep(), 10_000);
    this.sweepTimer.unref();
  }

  onModuleDestroy(): void {
    this.unsubscribePresence?.();
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const s of this.streams.values()) if (s.startTimer) clearTimeout(s.startTimer);
  }

  /** Test/diagnostika: faol oqimlar soni (matnsiz). */
  get streamCount(): number {
    return this.streams.size;
  }

  clientCount(sessionId: string): number {
    return this.streams.get(sessionId)?.clients.size ?? 0;
  }

  // --- klient -> center ------------------------------------------------------------------------

  async open(port: ChatClientPort, p: ChatOpenPayload): Promise<OpenOutcome> {
    const limiterKey = port.deviceId ?? 'anon';
    if (this.openLimiter.hit(limiterKey) > OPEN_RATE_PER_MINUTE) return 'rate_limited';

    const subs = this.byPort.get(port) ?? new Set<string>();
    const existing = this.streams.get(p.sessionId);

    // Eski sahifa so'rovi: mavjud, jonli oqim bo'lsa
    if (p.before !== undefined && existing && subs.has(p.sessionId)) {
      this.requestPage(port, existing, p.before, p.limit ?? CHAT_LIMITS.defaultTail);
      return 'ok';
    }

    if (!subs.has(p.sessionId) && subs.size >= CHAT_LIMITS.maxOpenPerClient) {
      this.pushState(port, p.sessionId, 'error', 'busy');
      return 'ok';
    }

    const stream = existing ?? (await this.createStream(p));
    if (!stream) {
      this.pushState(port, p.sessionId, 'unavailable', 'not_found');
      return 'ok';
    }
    // createStream await paytida klient allaqachon yopilgan/qo'shilgan bo'lishi mumkin
    const current = this.streams.get(p.sessionId);
    if (current && current !== stream) {
      return this.open(port, p);
    }

    stream.tail = Math.max(stream.tail, p.limit ?? CHAT_LIMITS.defaultTail);
    stream.clients.set(port, { awaitingBackfill: true, synced: false });
    subs.add(p.sessionId);
    this.byPort.set(port, subs);
    this.streams.set(stream.sessionId, stream);
    this.auditOpened(port, stream);

    if (!this.dispatch.isOnline(stream.machineId)) {
      this.setState(stream, 'offline', [port]);
      return 'ok';
    }
    if (stream.streamId === null) {
      // yangi yoki xatodan keyin qayta urinish
      this.pushState(port, stream.sessionId, 'connecting');
      stream.state = 'connecting';
      this.startOnAgent(stream);
    } else if (stream.state === 'live' && !stream.backfilling) {
      // mavjud jonli oqim: shu klient uchun yangi backfill (resync)
      this.pushState(port, stream.sessionId, 'connecting');
      this.startOnAgent(stream, true);
    } else {
      // backfill yo'lda: boshidan ulangan bo'lsa to'liq oladi; o'rtasidan ulangan bo'lsa `done` da resync qilinadi
      this.pushState(port, stream.sessionId, 'connecting');
    }
    return 'ok';
  }

  close(port: ChatClientPort, sessionId: string): void {
    const subs = this.byPort.get(port);
    subs?.delete(sessionId);
    if (subs && subs.size === 0) this.byPort.delete(port);
    const stream = this.streams.get(sessionId);
    if (!stream) return;
    stream.clients.delete(port);
    for (const [pageId, pg] of this.pages) if (pg.port === port) this.pages.delete(pageId);
    if (stream.clients.size === 0) this.destroyStream(stream);
  }

  /** Klient ulanishi yopilganda: hamma obunalar tozalanadi (ref-count kamayadi). */
  releaseAll(port: ChatClientPort): void {
    const subs = this.byPort.get(port);
    if (!subs) return;
    for (const sessionId of [...subs]) this.close(port, sessionId);
    this.byPort.delete(port);
  }

  // --- agent -> center -------------------------------------------------------------------------

  onAgentItems(machineId: string, p: ChatItemsFromAgentPayload): void {
    const stream = this.byStreamId.get(p.streamId);
    if (!stream || stream.machineId !== machineId) return; // begona/eskirgan oqim: jim tashlanadi

    const items = p.items.map(sanitizeItem);

    if (p.pageId) {
      const pg = this.pages.get(p.pageId);
      if (!pg || pg.stream !== stream) return;
      if (p.done) this.pages.delete(p.pageId);
      pg.port.pushChat('chat.items', { sessionId: stream.sessionId, items, older: true, ...(p.cursor !== undefined ? { cursor: p.cursor } : {}) });
      return;
    }

    if (stream.startTimer) {
      clearTimeout(stream.startTimer);
      stream.startTimer = null;
    }
    if (p.replace) {
      stream.backfilling = true;
      for (const sub of stream.clients.values()) if (sub.awaitingBackfill) sub.synced = true;
    }

    const recipients: ChatClientPort[] = [];
    for (const [port, sub] of stream.clients) {
      if (stream.backfilling ? sub.awaitingBackfill && sub.synced : !sub.awaitingBackfill) recipients.push(port);
    }
    const payload = {
      sessionId: stream.sessionId,
      items,
      ...(p.replace ? { replace: true } : {}),
      ...(p.cursor !== undefined ? { cursor: p.cursor } : {}),
    };
    for (const port of recipients) port.pushChat('chat.items', payload);

    if (p.done && stream.backfilling) {
      stream.backfilling = false;
      stream.state = 'live';
      for (const port of recipients) {
        const sub = stream.clients.get(port);
        if (sub) sub.awaitingBackfill = false;
        this.pushState(port, stream.sessionId, 'live');
      }
      // backfill o'rtasida qo'shilgan klientlar uchun yangi backfill
      if ([...stream.clients.values()].some((sub) => sub.awaitingBackfill)) this.startOnAgent(stream, true);
    }
  }

  onAgentError(machineId: string, p: ChatErrorFromAgentPayload): void {
    const stream = this.byStreamId.get(p.streamId);
    if (!stream || stream.machineId !== machineId) return;
    if (p.pageId) {
      const pg = this.pages.get(p.pageId);
      this.pages.delete(p.pageId);
      // Sahifa xatosi oqimni buzmaydi: klient `code` ni ko'rib qayta urinadi
      if (pg) this.pushState(pg.port, stream.sessionId, 'live', p.code);
      return;
    }
    this.byStreamId.delete(p.streamId);
    stream.streamId = null;
    stream.backfilling = false;
    if (stream.startTimer) clearTimeout(stream.startTimer);
    stream.startTimer = null;
    this.setState(stream, STATE_BY_ERROR[p.code], undefined, p.code);
  }

  // --- mashina ulanishi ------------------------------------------------------------------------

  private onPresence(machineId: string, online: boolean): void {
    for (const stream of this.streams.values()) {
      if (stream.machineId !== machineId) continue;
      if (!online) {
        if (stream.streamId) this.byStreamId.delete(stream.streamId);
        stream.streamId = null;
        stream.backfilling = false;
        if (stream.startTimer) clearTimeout(stream.startTimer);
        stream.startTimer = null;
        for (const [id, pg] of this.pages) if (pg.stream === stream) this.pages.delete(id);
        this.setState(stream, 'offline');
      } else if (stream.clients.size > 0) {
        // agentd qayta ulandi: oqimlar yo'qolgan, qayta boshlaymiz (hamma klient backfill kutadi)
        for (const sub of stream.clients.values()) {
          sub.awaitingBackfill = true;
          sub.synced = false;
        }
        this.setState(stream, 'connecting');
        this.startOnAgent(stream);
      }
    }
  }

  // --- ichki -----------------------------------------------------------------------------------

  private async createStream(p: ChatOpenPayload): Promise<Stream | null> {
    const rows: Array<{ machine_id: string; claude_session_id: string; transcript_path: string | null }> = await this.dataSource.query(
      `SELECT machine_id, claude_session_id, transcript_path FROM sessions WHERE id = $1`,
      [p.sessionId],
    );
    const row = rows[0];
    if (!row) return null;
    const concurrent = this.streams.get(p.sessionId);
    if (concurrent) return concurrent;
    return {
      sessionId: p.sessionId,
      machineId: row.machine_id,
      claudeSessionId: row.claude_session_id,
      transcriptPath: row.transcript_path,
      streamId: null,
      state: 'connecting',
      backfilling: false,
      tail: p.limit ?? CHAT_LIMITS.defaultTail,
      clients: new Map(),
      startTimer: null,
    };
  }

  /** `resync=true`: mavjud `streamId` bilan qayta `start` (agent backfill'ni qayta yuboradi). */
  private startOnAgent(stream: Stream, resync = false): void {
    if (!resync || stream.streamId === null) {
      if (stream.streamId) this.byStreamId.delete(stream.streamId);
      stream.streamId = randomUUID();
      this.byStreamId.set(stream.streamId, stream);
    }
    const sent = this.dispatch.send(stream.machineId, 'chat.stream.start', {
      streamId: stream.streamId,
      claudeSessionId: stream.claudeSessionId,
      ...(stream.transcriptPath ? { transcriptPath: stream.transcriptPath } : {}),
      tail: stream.tail,
    });
    if (!sent) {
      this.byStreamId.delete(stream.streamId);
      stream.streamId = null;
      this.setState(stream, 'offline');
      return;
    }
    if (stream.startTimer) clearTimeout(stream.startTimer);
    stream.startTimer = setTimeout(() => {
      stream.startTimer = null;
      if (stream.state === 'live' && !stream.backfilling) return;
      if (stream.streamId) {
        this.dispatch.send(stream.machineId, 'chat.stream.stop', { streamId: stream.streamId });
        this.byStreamId.delete(stream.streamId);
        stream.streamId = null;
      }
      stream.backfilling = false;
      this.setState(stream, 'error', undefined, 'read_failed');
    }, CHAT_LIMITS.startTimeoutMs);
    stream.startTimer.unref();
  }

  private requestPage(port: ChatClientPort, stream: Stream, before: string, limit: number): void {
    if (!stream.streamId || stream.state !== 'live') return;
    const pageId = randomUUID();
    this.pages.set(pageId, { port, stream, expires: Date.now() + PAGE_TTL_MS });
    const sent = this.dispatch.send(stream.machineId, 'chat.stream.page', { streamId: stream.streamId, pageId, before, limit });
    if (!sent) {
      this.pages.delete(pageId);
      this.setState(stream, 'offline');
    }
  }

  private destroyStream(stream: Stream): void {
    if (stream.startTimer) clearTimeout(stream.startTimer);
    stream.startTimer = null;
    if (stream.streamId) {
      this.dispatch.send(stream.machineId, 'chat.stream.stop', { streamId: stream.streamId });
      this.byStreamId.delete(stream.streamId);
    }
    stream.streamId = null;
    this.streams.delete(stream.sessionId);
    for (const [id, pg] of this.pages) if (pg.stream === stream) this.pages.delete(id);
  }

  private setState(stream: Stream, state: ChatState, only?: ChatClientPort[], code?: ChatErrorCode): void {
    stream.state = state;
    for (const port of only ?? stream.clients.keys()) this.pushState(port, stream.sessionId, state, code);
  }

  private pushState(port: ChatClientPort, sessionId: string, state: ChatState, code?: ChatErrorCode): void {
    port.pushChat('chat.state', { sessionId, state, ...(code ? { code } : {}) });
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, pg] of this.pages) if (pg.expires <= now) this.pages.delete(id);
    for (const [k, t] of this.auditSeen) if (now - t > AUDIT_DEDUPE_MS) this.auditSeen.delete(k);
  }

  /** `chat.opened`: kim va qaysi sessiya (mazmunsiz). Bir qurilma+sessiya uchun 60 s ichida bitta qator. */
  private auditOpened(port: ChatClientPort, stream: Stream): void {
    const key = `${port.deviceId ?? 'anon'}|${stream.sessionId}`;
    const now = Date.now();
    const seen = this.auditSeen.get(key);
    if (seen !== undefined && now - seen < AUDIT_DEDUPE_MS) return;
    this.auditSeen.set(key, now);
    this.audit
      .record({
        actorDeviceId: port.deviceId,
        actorKind: (port.actorKind ?? 'web') as AuditActorKind,
        action: 'chat.opened',
        target: stream.sessionId,
        details: { machine_id: stream.machineId },
      })
      .catch((err: unknown) => this.logger.error(`audit chat.opened failed: ${err instanceof Error ? err.message : String(err)}`));
  }
}

/** Xavfsizlik to'ri: agentd allaqachon redakt qilgan; markaz qayta redakt qiladi (idempotent). */
export function sanitizeItem(item: ChatItem): ChatItem {
  switch (item.kind) {
    case 'user':
    case 'assistant':
    case 'thinking':
    case 'notice':
    case 'tool_result':
      return { ...item, text: redactText(item.text) };
    case 'tool_use':
      return { ...item, summary: redactText(item.summary) };
    default:
      return item;
  }
}
