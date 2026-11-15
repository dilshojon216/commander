import { Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { LOG_LIMITS } from '@commander/contracts';
import type { LogEndReason, LogStreamState, LogsChunkPayload, LogsReadResponse } from '@commander/contracts';
import { redactText } from '../common/redact-text.js';
import { AgentDispatchService } from '../realtime/agent-dispatch.service.js';
import { LogBuffer } from './logs-buffer.js';

/**
 * Log oqimi RELAY'i (6.6). MAXFIYLIK: log matni markazda faqat XOTIRADA (chegaralangan bufer), DB'ga/logga/auditga YOZILMAYDI.
 * agentd `logs.chunk` yuboradi -> bufer; klient `GET /v1/logs/:id?after=` bilan cursor orqali o'qiydi (orqa bosim: klient sekin
 * bo'lsa eski qatorlar tashlanadi va `dropped` bildiriladi, markaz xotirasi o'smaydi).
 *
 * Hayot sikli: klient `readerIdleMs` o'qimasa yoki mashina offline bo'lsa oqim to'xtatiladi (agentga `logs.stop`);
 * tugagan oqim buferi `finishedTtlMs` dan keyin o'chadi.
 */

interface Stream {
  commandId: string;
  machineId: string;
  buf: LogBuffer;
  state: LogStreamState;
  reason: LogEndReason | null;
  error: { code: string; message: string } | null;
  truncated: boolean;
  createdAt: number;
  /** 6.5 deploy chiqishi: o'quvchi bo'lmasa ham to'xtatilmaydi (deploy ishlayveradi; chiqish buferga yig'iladi). */
  persistent: boolean;
  lastReadAt: number;
  finishedAt: number | null;
}

@Injectable()
export class LogsRelayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LogsRelayService.name);
  private readonly streams = new Map<string, Stream>();
  private unsubscribePresence: (() => void) | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(private readonly dispatch: AgentDispatchService) {}

  onModuleInit(): void {
    this.unsubscribePresence = this.dispatch.onPresence((machineId, online) => {
      if (!online) this.onOffline(machineId);
    });
    this.sweepTimer = setInterval(() => this.sweep(), 5_000);
    this.sweepTimer.unref();
  }

  onModuleDestroy(): void {
    this.unsubscribePresence?.();
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  /** Test/diagnostika: faol oqimlar soni (matnsiz). */
  get count(): number {
    return this.streams.size;
  }

  /** Yangi oqimga joy bormi (bo'sh o'rin yoki siqib chiqariladigan tugagan oqim). */
  canAccept(): boolean {
    if (this.streams.size < LOG_LIMITS.centerMaxStreams) return true;
    for (const s of this.streams.values()) if (s.finishedAt !== null) return true;
    return false;
  }

  /** Buyruq yaratilgach chaqiriladi (idempotent). `false` = markaz band (juda ko'p oqim). */
  register(commandId: string, machineId: string, now: number = Date.now(), persistent = false): boolean {
    const ex = this.streams.get(commandId);
    if (ex) {
      if (persistent) ex.persistent = true;
      return true;
    }
    if (!this.makeRoom(now)) return false;
    const s = this.fresh(commandId, machineId, now);
    s.persistent = persistent;
    this.streams.set(commandId, s);
    return true;
  }

  private fresh(commandId: string, machineId: string, now: number): Stream {
    return { commandId, machineId, buf: new LogBuffer(), state: 'starting', reason: null, error: null, truncated: false, createdAt: now, persistent: false, lastReadAt: now, finishedAt: null };
  }

  /** Joy yo'q bo'lsa eng eski TUGAGAN oqimni siqib chiqaradi; yo'q bo'lsa `false`. */
  private makeRoom(now: number): boolean {
    if (this.streams.size < LOG_LIMITS.centerMaxStreams) return true;
    let oldest: Stream | null = null;
    for (const s of this.streams.values()) if (s.finishedAt !== null && (!oldest || s.finishedAt < (oldest.finishedAt ?? now))) oldest = s;
    if (!oldest) return false;
    this.streams.delete(oldest.commandId);
    return true;
  }

  // --- agent -> center -------------------------------------------------------------------------

  onAgentChunk(machineId: string, p: LogsChunkPayload, now: number = Date.now()): void {
    let s = this.streams.get(p.commandId);
    if (!s) {
      // buyruq yaratilishi bilan chunk poyga qilishi mumkin: oqim sekin yaratiladi (chegara ichida)
      if (!this.makeRoom(now)) return;
      s = this.fresh(p.commandId, machineId, now);
      this.streams.set(p.commandId, s);
    }
    if (s.machineId !== machineId) return; // begona/eskirgan oqim: jim tashlanadi
    if (s.finishedAt !== null) return;
    if (s.state === 'starting') s.state = 'live';
    if (p.dropped) s.buf.noteAgentDrop(p.dropped);
    if (p.truncated) s.truncated = true;
    // Xavfsizlik to'ri: agentd allaqachon redakt qilgan; markaz qayta redakt qiladi (idempotent)
    if (p.lines.length > 0) s.buf.append(p.lines.map((l) => redactText(l)));
    if (p.done) {
      s.state = p.error || p.reason === 'error' ? 'error' : 'done';
      s.reason = p.reason ?? 'ended';
      s.error = p.error ? { code: p.error.code, message: redactText(p.error.message).slice(0, 300) } : null;
      s.finishedAt = now;
    }
  }

  // --- klient -> center ------------------------------------------------------------------------

  /** Oqim bormi (`undefined` = markazda yo'q: hech boshlanmagan yoki TTL o'tgan). */
  read(commandId: string, after: number, now: number = Date.now()): LogsReadResponse | undefined {
    const s = this.streams.get(commandId);
    if (!s) return undefined;
    s.lastReadAt = now;
    const r = s.buf.read(after);
    return { commandId, state: s.state, lines: r.lines, nextSeq: r.nextSeq, dropped: r.dropped, truncated: s.truncated, reason: s.reason, error: s.error };
  }

  machineOf(commandId: string): string | undefined {
    return this.streams.get(commandId)?.machineId;
  }

  /** Klient yopdi (yoki idle): agentga `logs.stop`; oqim "stopped" bilan tugaydi (bufer TTL gacha qoladi). */
  stop(commandId: string, reason: LogEndReason = 'stopped', now: number = Date.now()): boolean {
    const s = this.streams.get(commandId);
    if (!s) return false;
    if (s.finishedAt === null) {
      this.dispatch.send(s.machineId, 'logs.stop', { commandId });
      s.state = 'done';
      s.reason = reason;
      s.finishedAt = now;
    }
    return true;
  }

  // --- ichki -----------------------------------------------------------------------------------

  private onOffline(machineId: string, now: number = Date.now()): void {
    for (const s of this.streams.values()) {
      if (s.machineId !== machineId || s.finishedAt !== null) continue;
      s.state = 'error';
      s.reason = 'ended';
      s.error = { code: 'machine_offline', message: 'The machine went offline' };
      s.finishedAt = now;
    }
  }

  /** Idle o'quvchi va muddati o'tgan tugagan oqimlar. */
  sweep(now: number = Date.now()): void {
    for (const [id, s] of this.streams) {
      if (s.finishedAt === null) {
        // hech kim o'qimayotgan (yoki hech qachon o'qimagan) oqim: to'xtatiladi
        // deploy chiqishi: o'quvchisiz ham davom etadi, lekin mutlaq chegara (3 soat) bor
        const idleLimit = s.persistent ? 3 * 60 * 60_000 : LOG_LIMITS.readerIdleMs;
        if (now - (s.persistent ? s.createdAt : s.lastReadAt) > idleLimit) {
          this.logger.log(`log stream ${id.slice(0, 8)} stopped: no reader`);
          this.stop(id, 'stopped', now);
        }
      } else if (now - s.finishedAt > LOG_LIMITS.finishedTtlMs) {
        this.streams.delete(id);
      }
    }
  }
}
