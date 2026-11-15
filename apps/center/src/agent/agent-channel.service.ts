import { ProjectSnapshotService } from '../projects/project-snapshot.service.js';
import type { IncomingMessage } from 'node:http';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { BeforeApplicationShutdown, OnModuleInit } from '@nestjs/common';
import type { WebSocket } from 'ws';
import { AGENT_WS_CLOSE } from '@commander/contracts';
import { ApprovalsService } from '../approvals/approvals.service.js';
import { CommandSignerService } from '../commands/command-signer.service.js';
import { CommandsService } from '../commands/commands.service.js';
import { MessagingService } from '../messaging/messaging.service.js';
import { MachineHealthService } from '../health/machine-health.service.js';
import { ConfigSyncService } from '../config-sync/config-sync.service.js';
import { ChatRelayService } from '../chat/chat-relay.service.js';
import { LogsRelayService } from '../logs/logs-relay.service.js';
import { AgentDispatchService } from '../realtime/agent-dispatch.service.js';
import { SecurityEvents } from '../identity/common/security-events.service.js';
import { DeviceSignatureVerifier } from '../identity/devices/device-signature.verifier.js';
import { AuditService } from '../identity/audit/audit.service.js';
import { DeviceKeysService } from '../identity/devices/device-keys.service.js';
import { RealtimeBus } from '../realtime/realtime-bus.js';
import { AGENT_CHANNEL_OPTIONS } from './agent-channel.options.js';
import type { AgentChannelOptions } from './agent-channel.options.js';
import { AgentConnection } from './agent-connection.js';
import type { ConnectionRegistry } from './agent-connection.js';
import { AgentIngestService } from './agent-ingest.service.js';
import { AgentPresenceService } from './agent-presence.service.js';

/** `/ws/agent` ulanishlarini qabul qiladi, ro'yxatni yuritadi va graceful shutdown qiladi. */
@Injectable()
export class AgentChannelService implements ConnectionRegistry, OnModuleInit, BeforeApplicationShutdown {
  private readonly logger = new Logger(AgentChannelService.name);
  private readonly active = new Map<string, AgentConnection>();
  private readonly all = new Set<AgentConnection>();

  constructor(
    private readonly verifier: DeviceSignatureVerifier,
    private readonly ingest: AgentIngestService,
    private readonly presence: AgentPresenceService,
    private readonly security: SecurityEvents,
    private readonly approvals: ApprovalsService,
    private readonly dispatch: AgentDispatchService,
    private readonly chat: ChatRelayService,
    private readonly commands: CommandsService,
    private readonly projects: ProjectSnapshotService,
    private readonly signer: CommandSignerService,
    private readonly messaging: MessagingService,
    @Inject(AGENT_CHANNEL_OPTIONS) private readonly options: AgentChannelOptions,
    @Optional() private readonly health?: MachineHealthService,
    @Optional() private readonly configSync?: ConfigSyncService,
    @Optional() private readonly keys?: DeviceKeysService,
    @Optional() private readonly audit?: AuditService,
    @Optional() private readonly bus?: RealtimeBus,
    @Optional() private readonly logs?: LogsRelayService,
  ) {}

  private unsubscribe: (() => void) | null = null;

  async onModuleInit(): Promise<void> {
    // 5.1: revoke = darhol uzish (4010), "kalitni aylantiring" so'rovi, markaz kaliti qayta yuklash.
    this.unsubscribe = this.bus?.subscribe((e) => {
      if (e.type !== 'device.event') return;
      if (e.kind === 'revoked') this.closeRevoked(e.deviceId);
      else if (e.kind === 'rotation_required') this.active.get(e.deviceId)?.requestRotation();
      else void this.signer.reload().catch((err: unknown) => this.logger.error(`center signing key reload failed: ${err instanceof Error ? err.message : String(err)}`));
    }) ?? null;
    const n = await this.presence.resetAllOffline();
    if (n > 0) this.logger.log(`Startup: ${n} machine(s) marked offline until their agentd reconnects`);
  }

  accept(socket: WebSocket, req: IncomingMessage): void {
    if (this.security.isWsAuthFlooded(req)) {
      socket.close(AGENT_WS_CLOSE.rateLimited, 'too many failed authentications');
      return;
    }
    const pendingAuth = [...this.all].filter((c) => !c.authenticated).length;
    if (pendingAuth >= this.options.maxPendingAuth) {
      socket.close(1013, 'busy');
      return;
    }
    const conn = new AgentConnection(socket, req, {
      verifier: this.verifier,
      ingest: this.ingest,
      presence: this.presence,
      security: this.security,
      approvals: this.approvals,
      dispatch: this.dispatch,
      chat: this.chat,
      ...(this.logs ? { logs: this.logs } : {}),
      commands: this.commands,
      projects: this.projects,
      signer: this.signer,
      ...(this.keys ? { keys: this.keys } : {}),
      ...(this.audit ? { audit: this.audit } : {}),
      mailbox: this.messaging,
      ...(this.health ? { health: this.health } : {}),
      ...(this.configSync ? { configSync: this.configSync } : {}),
      registry: this,
      options: this.options,
    });
    this.all.add(conn);
    conn.start();
  }

  /** Qurilma revoke qilindi: shu qurilmaning hamma ulanishi (tasdiqlanmaganlari ham) 4010 bilan zudlik bilan yopiladi. */
  closeRevoked(deviceId: string): number {
    let n = 0;
    for (const c of [...this.all]) {
      if (c.deviceId === deviceId) {
        c.close(AGENT_WS_CLOSE.revoked, 'device revoked');
        n += 1;
      }
    }
    return n;
  }

  activate(deviceId: string, conn: AgentConnection): AgentConnection | null {
    const previous = this.active.get(deviceId) ?? null;
    this.active.set(deviceId, conn);
    return previous === conn ? null : previous;
  }

  release(deviceId: string, conn: AgentConnection): boolean {
    if (this.active.get(deviceId) !== conn) return false;
    this.active.delete(deviceId);
    return true;
  }

  forget(conn: AgentConnection): void {
    this.all.delete(conn);
  }

  get connectionCount(): number {
    return this.all.size;
  }

  /** DB yopilishidan oldin: ulanishlarni 1001 bilan yopadi va presence tozalanishini kutadi. */
  async beforeApplicationShutdown(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    const conns = [...this.all];
    for (const c of conns) c.close(AGENT_WS_CLOSE.goingAway, 'server shutting down');
    await Promise.race([Promise.allSettled(conns.map((c) => c.closed)), new Promise((r) => setTimeout(r, 5_000).unref())]);
  }
}
