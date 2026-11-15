import { Injectable, Module } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { INTELLIGENCE_OPS, RecordDecisionCallSchema, SessionSummaryPayloadSchema } from '@commander/contracts';
import type { MailboxCall } from '@commander/contracts';
import { ApiModule } from '../api/api.module.js';
import { CommandsModule } from '../commands/commands.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { LimitsModule } from '../limits/limits.module.js';
import { MessagingModule } from '../messaging/messaging.module.js';
import { MessagingError, MessagingService } from '../messaging/messaging.service.js';
import { CoreModule } from '../realtime/core.module.js';
import { TelegramAccessModule } from '../telegram/telegram.module.js';
import { AskService } from './ask.service.js';
import { DecisionsService } from './decisions.service.js';
import { IntelligenceController } from './intelligence.controller.js';
import { IntelligenceTelegram } from './intelligence-telegram.js';
import { SummariesService } from './summaries.service.js';

/**
 * Mailbox RPC (agent -> center) ulanishi: `summary_check`, `session_summary` (6.1), `record_decision` (6.3) va `deliver` javobiga
 * qarorlar bloki (yangi sessiyaning birinchi prompti). Modul sikli yo'q: `MessagingService` kengaytma reestri orqali.
 */
@Injectable()
export class IntelligenceMailbox implements OnModuleInit, OnModuleDestroy {
  private unsubscribers: Array<() => void> = [];

  constructor(
    private readonly messaging: MessagingService,
    private readonly summaries: SummariesService,
    private readonly decisions: DecisionsService,
  ) {}

  onModuleInit(): void {
    this.unsubscribers.push(
      this.messaging.registerCallExtension({
        ops: new Set<string>(INTELLIGENCE_OPS),
        handle: (machineId, deviceId, claudeSessionId, call) => this.handle(machineId, deviceId, claudeSessionId, call),
      }),
      this.messaging.registerDeliverExtra((machineId, claudeSessionId) => this.decisions.injectionFor(machineId, claudeSessionId)),
    );
  }

  onModuleDestroy(): void {
    for (const u of this.unsubscribers) u();
    this.unsubscribers = [];
  }

  async handle(machineId: string, deviceId: string, claudeSessionId: string, call: MailboxCall): Promise<unknown> {
    switch (call.op) {
      case 'summary_check':
        return this.summaries.check(machineId, claudeSessionId);
      case 'session_summary':
        return this.summaries.ingest(machineId, deviceId, claudeSessionId, SessionSummaryPayloadSchema.parse(call.summary));
      case 'record_decision': {
        const { op: _op, ...rest } = call;
        void _op;
        return this.decisions.record(machineId, deviceId, claudeSessionId, RecordDecisionCallSchema.parse(rest));
      }
      default:
        throw new MessagingError('invalid_request', `Noma'lum operatsiya: ${call.op}`);
    }
  }
}

/** 6.1-6.3: sessiya xulosalari + qidiruv, Commander'dan savol, qarorlar jurnali. */
@Module({
  imports: [IdentityModule, CoreModule, CommandsModule, MessagingModule, ApiModule, LimitsModule, TelegramAccessModule],
  controllers: [IntelligenceController],
  providers: [SummariesService, DecisionsService, AskService, IntelligenceMailbox, IntelligenceTelegram],
  exports: [SummariesService, DecisionsService, AskService],
})
export class IntelligenceModule {}
