import { ProjectsModule } from './projects/projects.module.js';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AgentModule } from './agent/agent.module.js';
import { ApiModule } from './api/api.module.js';
import { CommandsModule } from './commands/commands.module.js';
import { ApprovalsModule } from './approvals/approvals.module.js';
import { validateEnv } from './config/env.validation.js';
import { typeOrmOptions } from './database/database.config.js';
import { EventsModule } from './events/events.module.js';
import { HealthModule } from './health/health.module.js';
import { MachineHealthModule } from './health/machine-health.module.js';
import { HealthAlertsModule } from './health-alerts/health-alerts.module.js';
import { ConfigSyncModule } from './config-sync/config-sync.module.js';
import { ConfigAlertsModule } from './config-sync/config-alerts.module.js';
import { IdentityModule } from './identity/identity.module.js';
import { MessagingModule } from './messaging/messaging.module.js';
import { IntelligenceModule } from './intelligence/intelligence.module.js';
import { LimitsModule } from './limits/limits.module.js';
import { QueueModule } from './queue/queue.module.js';
import { OrchestrationModule } from './orchestration/orchestration.module.js';
import { TemplatesModule } from './templates/templates.module.js';
import { CoreModule } from './realtime/core.module.js';
import { RealtimeModule } from './realtime/realtime.module.js';
import { TelegramModule } from './telegram/telegram.module.js';
import { WatchdogModule } from './watchdog/watchdog.module.js';
import { CenterHealthModule } from './center-health/center-health.module.js';
import { ReportsModule } from './reports/reports.module.js';
import { RetentionModule } from './retention/retention.module.js';
import { BillingModule } from './billing/billing.module.js';
import { LogsModule } from './logs/logs.module.js';
import { DeployModule } from './deploy/deploy.module.js';
import { InvestigationsModule } from './investigations/investigations.module.js';
import { ScansModule } from './scans/scans.module.js';
import { BudgetsModule } from './budgets/budgets.module.js';
import { SettingsModule } from './settings/settings.module.js';
import { BudgetAlertsModule } from './budgets/budget-alerts.module.js';
import { PaceModule } from './limits/pace.module.js';
import { PaceAlertsModule } from './limits/pace-alerts.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => typeOrmOptions(config.getOrThrow<string>('DATABASE_URL'), true),
    }),
    CoreModule,
    IdentityModule,
    EventsModule,
    ApprovalsModule,
    CommandsModule,
    LimitsModule,
    QueueModule,
    OrchestrationModule,
    TemplatesModule,
    ApiModule,
    ProjectsModule,
    MessagingModule,
    IntelligenceModule,
    AgentModule,
    RealtimeModule,
    TelegramModule,
    WatchdogModule,
    ReportsModule,
    HealthModule,
    MachineHealthModule,
    HealthAlertsModule,
    ConfigSyncModule,
    ConfigAlertsModule,
    RetentionModule,
    CenterHealthModule,
    BillingModule,
    LogsModule,
    DeployModule,
    InvestigationsModule,
    ScansModule,
    BudgetsModule,
    BudgetAlertsModule,
    PaceModule,
    PaceAlertsModule,
    SettingsModule,
  ],
})
export class AppModule {}
