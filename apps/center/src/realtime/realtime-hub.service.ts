import type { IncomingMessage } from 'node:http';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { BeforeApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { WebSocket } from 'ws';
import { CLIENT_WS_CLOSE } from '@commander/contracts';
import type { ClientChannel } from '@commander/contracts';
import { ChatRelayService } from '../chat/chat-relay.service.js';
import { MachinesService } from '../api/machines.service.js';
import { SessionsV1Service } from '../api/sessions-v1.service.js';
import { CommandsService } from '../commands/commands.service.js';
import { ApprovalsService } from '../approvals/approvals.service.js';
import { LockdownService } from '../identity/lockdown/lockdown.service.js';
import { ClientWsAuthService } from '../identity/tokens/client-ws-auth.service.js';
import { MessagingService } from '../messaging/messaging.service.js';
import { MachineHealthService } from '../health/machine-health.service.js';
import { QueueService } from '../queue/queue.service.js';
import { OrchestrationService } from '../orchestration/orchestration.service.js';
import { ProjectsReadService } from '../projects/projects-read.service.js';
import { LimitsService } from '../limits/limits.service.js';
import { nextMidnight } from '../limits/pace-logic.js';
import { nextResetInstant } from '../limits/limits-logic.js';
import { ClientConnection } from './client-connection.js';
import { CLIENT_HUB_OPTIONS } from './client-hub.options.js';
import type { ClientHubOptions } from './client-hub.options.js';
import { RealtimeBus } from './realtime-bus.js';
import type { DomainEvent } from './realtime-bus.js';
import { UsageTickAccumulator } from './usage-tick.js';

/** `machine.health` push'lari orasidagi eng kichik oraliq (mashina bo'yicha). */
const HEALTH_PUSH_MIN_MS = 5_000;

/**
 * `/ws/client` fan-out (1.6). Domen hodisalari (`RealtimeBus`) -> to'liq DTO -> obunachilarga push.
 *  - sessions/machines/approvals: o'zgargan obyektning joriy holati (DB'dan o'qiladi, faqat obunachi bo'lsa);
 *  - usage: delta'lar `usageTickMs` oralig'ida jamlanadi (leading+trailing throttle);
 *  - limits: qayta hisoblanadi (bir vaqtda bitta hisob, o'rtadagi hodisalar birlashtiriladi) va reset vaqtiga taymer;
 *  - revoke/expired va lockdown: har `sweepMs` da tekshiriladi (revoke -> 4010, lockdown o'zgarishi -> `lockdown.updated`).
 */
@Injectable()
export class RealtimeHubService implements OnModuleInit, BeforeApplicationShutdown {
  private readonly logger = new Logger(RealtimeHubService.name);
  private readonly conns = new Set<ClientConnection>();
  private unsubscribe: (() => void) | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private resetTimer: NodeJS.Timeout | null = null;
  private lastTickAt = 0;
  private lastPingAt = Date.now();
  private lastLockdown: { enabled: boolean; since: string | null } | null = null;
  private limitsRunning = false;
  private limitsDirty = false;
  private readonly usage = new UsageTickAccumulator();
  private readonly healthLast = new Map<string, number>();
  private readonly healthTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly bus: RealtimeBus,
    private readonly auth: ClientWsAuthService,
    private readonly lockdown: LockdownService,
    private readonly sessions: SessionsV1Service,
    private readonly machines: MachinesService,
    private readonly approvals: ApprovalsService,
    private readonly limits: LimitsService,
    private readonly chat: ChatRelayService,
    private readonly commands: CommandsService,
    private readonly projects: ProjectsReadService,
    private readonly messaging: MessagingService,
    @Inject(CLIENT_HUB_OPTIONS) private readonly options: ClientHubOptions,
    /** Server salomatligi (3.8): yo'q bo'lsa `health` kanaliga push ketmaydi. */
    @Optional() private readonly health?: MachineHealthService,
    /** Vazifalar navbati (3.1): yo'q bo'lsa `queue` kanaliga push ketmaydi. */
    @Optional() private readonly queue?: QueueService,
    /** Orkestratsiya (3.9): yo'q bo'lsa `orchestrations` kanaliga push ketmaydi. */
    @Optional() private readonly orchestration?: OrchestrationService,
  ) {}

  onModuleInit(): void {
    this.unsubscribe = this.bus.subscribe((e) => this.onDomainEvent(e));
    this.sweepTimer = setInterval(() => void this.sweep().catch((err: unknown) => this.logger.error(`sweep failed: ${err instanceof Error ? err.message : String(err)}`)), this.options.sweepMs);
    this.sweepTimer.unref();
    // Dastlabki limit snapshot'i (reset taymerini o'rnatish uchun); xato log qilinadi.
    void this.refreshLimits(false).catch((err: unknown) => this.logger.warn(`initial limits refresh failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  accept(socket: WebSocket, req: IncomingMessage): void {
    const conn = new ClientConnection(socket, req, {
      auth: this.auth,
      lockdown: () => this.lockdownState(),
      onReady: (c) => void this.conns.add(c),
      onClosed: (c) => {
        this.conns.delete(c);
        this.chat.releaseAll(c); // chat oqimlari: ref-count kamayadi, oxirgi klient ketsa agentd to'xtatiladi
      },
      chat: this.chat,
      authTimeoutMs: this.options.authTimeoutMs,
    });
    // Auth'dan oldin ham kuzatamiz (shutdown hamma ulanishni yopsin); ready bo'lmaganlarga push ketmaydi.
    this.conns.add(conn);
    conn.start();
  }

  get connectionCount(): number {
    return this.conns.size;
  }

  beforeApplicationShutdown(): void {
    this.unsubscribe?.();
    for (const t of [this.sweepTimer, this.tickTimer, this.resetTimer, ...this.healthTimers.values()]) if (t) clearTimeout(t);
    this.healthTimers.clear();
    this.sweepTimer = this.tickTimer = this.resetTimer = null;
    for (const c of [...this.conns]) c.close(CLIENT_WS_CLOSE.goingAway, 'server shutting down');
  }

  // --- domen hodisalari ------------------------------------------------------------------------

  private onDomainEvent(e: DomainEvent): Promise<void> | void {
    switch (e.type) {
      case 'sessions.changed':
        return this.pushSessions(e.refs);
      case 'machine.changed':
        return this.pushMachine(e.machineId);
      case 'usage.recorded':
        if (this.hasSubscribers('usage')) {
          this.usage.add(e.rows, Date.now());
          this.scheduleTick();
        }
        return;
      case 'limits.changed':
        return this.refreshLimits(true);
      case 'approval.created':
        return this.pushApproval('approval.created', e.approvalId);
      case 'approval.resolved':
        return this.pushApproval('approval.resolved', e.approvalId);
      case 'command.changed':
        return this.pushCommand(e.commandId);
      case 'project.changed':
        return this.pushProject(e.projectId);
      case 'message.changed':
        return this.pushMessage(e.messageId, e.created);
      case 'queue.changed':
        return this.pushQueue(e.queueId);
      case 'orchestration.changed':
        return this.pushOrchestration(e.orchestrationId);
      case 'health.changed':
        return this.pushHealth(e.machineId);
      case 'device.event':
        if (e.kind === 'revoked') this.closeDevice(e.deviceId);
        return;
      case 'alert.changed':
        if (this.hasSubscribers('alerts')) this.broadcast('alerts', e.created ? 'alert.created' : 'alert.updated', { alert: e.alert });
        return;
    }
  }

  /** Token revoke qilindi (CLI, o'zini revoke, pairing qurilmasi): shu qurilmaning hamma `/ws/client` ulanishi 4010 bilan darhol yopiladi (5.1). */
  closeDevice(deviceId: string): number {
    let n = 0;
    for (const c of [...this.conns]) {
      if (c.deviceId === deviceId) {
        c.close(CLIENT_WS_CLOSE.revoked, 'token revoked');
        n += 1;
      }
    }
    return n;
  }

  private hasSubscribers(channel: ClientChannel): boolean {
    for (const c of this.conns) if (c.ready && c.channels.has(channel)) return true;
    return false;
  }

  private broadcast(channel: ClientChannel, type: string, payload: unknown): void {
    for (const c of this.conns) if (c.ready && c.channels.has(channel)) c.push(type, payload);
  }

  private async pushSessions(refs: Parameters<SessionsV1Service['findByRefs']>[0]): Promise<void> {
    if (!this.hasSubscribers('sessions')) return;
    for (const session of await this.sessions.findByRefs(refs)) this.broadcast('sessions', 'session.updated', { session });
  }

  private async pushMachine(machineId: string): Promise<void> {
    if (!this.hasSubscribers('machines')) return;
    const machine = await this.machines.findById(machineId);
    if (machine) this.broadcast('machines', 'machine.updated', { machine });
  }

  private async pushApproval(type: 'approval.created' | 'approval.resolved', id: string): Promise<void> {
    if (!this.hasSubscribers('approvals')) return;
    this.broadcast('approvals', type, { approval: await this.approvals.getDto(id) });
  }

  private async pushOrchestration(id: string): Promise<void> {
    if (!this.orchestration || !this.hasSubscribers('orchestrations')) return;
    this.broadcast('orchestrations', 'orchestration.updated', { orchestration: await this.orchestration.getDto(id) });
  }

  private async pushQueue(id: string): Promise<void> {
    if (!this.queue || !this.hasSubscribers('queue')) return;
    this.broadcast('queue', 'queue.updated', { item: await this.queue.getDto(id) });
  }

  private async pushCommand(id: string): Promise<void> {
    if (!this.hasSubscribers('commands')) return;
    this.broadcast('commands', 'command.updated', { command: await this.commands.getDto(id) });
  }

  private async pushProject(projectId: string): Promise<void> {
    if (!this.hasSubscribers('projects')) return;
    const payload = await this.projects.updatedPayload(projectId);
    if (payload) this.broadcast('projects', 'project.updated', payload);
  }

  /** `machine.health`: mashina bo'yicha kamida `HEALTH_PUSH_MIN_MS` oraliq (leading + trailing throttle). */
  private pushHealth(machineId: string): void {
    if (!this.health || !this.hasSubscribers('health')) return;
    const wait = (this.healthLast.get(machineId) ?? 0) + HEALTH_PUSH_MIN_MS - Date.now();
    const run = (): void => {
      this.healthLast.set(machineId, Date.now());
      void this.sendHealth(machineId).catch((err: unknown) => this.logger.error(`health push failed: ${err instanceof Error ? err.message : String(err)}`));
    };
    if (wait <= 0) return run();
    if (this.healthTimers.has(machineId)) return; // trailing allaqachon rejalangan: oxirgi holat yuboriladi
    const t = setTimeout(() => {
      this.healthTimers.delete(machineId);
      run();
    }, wait);
    t.unref();
    this.healthTimers.set(machineId, t);
  }

  private async sendHealth(machineId: string): Promise<void> {
    const m = await this.machines.findById(machineId);
    if (!m || !this.health) return;
    const { status, latest } = await this.health.statusOf(machineId, m.online);
    if (latest) this.broadcast('health', 'machine.health', { machineId, status, snapshot: latest.snapshot, receivedAt: latest.receivedAt.toISOString() });
  }

  private async pushMessage(id: string, created: boolean): Promise<void> {
    if (!this.hasSubscribers('messages')) return;
    const message = await this.messaging.getMessageDto(id);
    if (message) this.broadcast('messages', created ? 'message.created' : 'message.updated', { message });
  }

  // --- usage.tick ------------------------------------------------------------------------------

  private scheduleTick(): void {
    if (this.tickTimer) return;
    const delay = Math.max(0, this.lastTickAt + this.options.usageTickMs - Date.now());
    this.tickTimer = setTimeout(() => {
      this.tickTimer = null;
      this.lastTickAt = Date.now();
      const payload = this.usage.flush(this.lastTickAt);
      if (payload) this.broadcast('usage', 'usage.tick', payload);
    }, delay);
    this.tickTimer.unref();
  }

  // --- limits ----------------------------------------------------------------------------------

  /** Bir vaqtda bitta hisob; hisob davomida kelgan hodisalar bitta qayta hisobga birlashadi. */
  private async refreshLimits(push: boolean): Promise<void> {
    if (this.limitsRunning) {
      this.limitsDirty = true;
      return;
    }
    this.limitsRunning = true;
    try {
      do {
        this.limitsDirty = false;
        const now = new Date();
        const limits = await this.limits.current(now);
        if (push && this.hasSubscribers('limits')) this.broadcast('limits', 'limits.updated', { limits });
        // 6.12: haftalik tezlikda kun chegarasi (Toshkent yarim kechasi) ham qayta hisob uchun sabab
        const reset = nextResetInstant([limits.fiveHour, limits.sevenDay], now);
        const midnight = limits.pace ? nextMidnight(now) : null;
        this.armResetTimer(reset && midnight ? (reset.getTime() <= midnight.getTime() ? reset : midnight) : (reset ?? midnight), now);
      } while (this.limitsDirty);
    } finally {
      this.limitsRunning = false;
    }
  }

  /** Eng yaqin reset vaqtida (`resetsAt`) hisobni qayta ishga tushiradi: klientlar "yangilandi (taxmin)" holatini oladi. */
  private armResetTimer(at: Date | null, now: Date): void {
    if (this.resetTimer) clearTimeout(this.resetTimer);
    this.resetTimer = null;
    if (!at) return;
    const delay = Math.min(at.getTime() - now.getTime() + 1_000, 24 * 3_600_000);
    this.resetTimer = setTimeout(() => void this.refreshLimits(true).catch((err: unknown) => this.logger.error(`limits reset refresh failed: ${err instanceof Error ? err.message : String(err)}`)), delay);
    this.resetTimer.unref();
  }

  // --- davriy tekshiruv: revoke, lockdown, ping --------------------------------------------------

  private async lockdownState(): Promise<{ enabled: boolean; since: string | null }> {
    const s = await this.lockdown.state();
    this.lastLockdown ??= s;
    return s;
  }

  /** Test uchun ochiq: bitta sweep. */
  async sweep(): Promise<void> {
    const ready = [...this.conns].filter((c) => c.ready && c.deviceId);
    if (ready.length > 0) {
      const ids = [...new Set(ready.map((c) => c.deviceId as string))];
      const revoked: Array<{ id: string }> = await this.dataSource.query(
        `SELECT id FROM devices WHERE id = ANY($1::uuid[]) AND (revoked_at IS NOT NULL OR (expires_at IS NOT NULL AND expires_at <= now()))`,
        [ids],
      );
      const bad = new Set(revoked.map((r) => r.id));
      for (const c of ready) if (c.deviceId && bad.has(c.deviceId)) c.close(CLIENT_WS_CLOSE.revoked, 'token revoked or expired');
    }

    const ld = await this.lockdown.state();
    if (this.lastLockdown && (ld.enabled !== this.lastLockdown.enabled)) {
      for (const c of this.conns) if (c.ready) c.push('lockdown.updated', ld);
    }
    this.lastLockdown = ld;

    const now = Date.now();
    if (now - this.lastPingAt >= 20_000) {
      this.lastPingAt = now;
      for (const c of [...this.conns]) {
        if (!c.ready) continue;
        if (!c.alive) {
          c.socket.terminate();
          continue;
        }
        c.alive = false;
        try {
          c.socket.ping();
        } catch {
          c.socket.terminate();
        }
      }
    }
  }
}

