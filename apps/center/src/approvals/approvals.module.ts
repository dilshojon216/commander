import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { CoreModule } from '../realtime/core.module.js';
import { APPROVALS_OPTIONS, DEFAULT_APPROVALS_OPTIONS } from './approvals.options.js';
import { ApprovalRulesController } from './approval-rules.controller.js';
import { ApprovalRulesService } from './approval-rules.service.js';
import { ApprovalsController } from './approvals.controller.js';
import { ApprovalsService } from './approvals.service.js';

/** 1.7: remote permission navbati (center tomoni). Agent kanali `AgentModule` orqali shu servisni chaqiradi. */
@Module({
  imports: [IdentityModule, CoreModule],
  controllers: [ApprovalsController, ApprovalRulesController],
  providers: [{ provide: APPROVALS_OPTIONS, useValue: DEFAULT_APPROVALS_OPTIONS }, ApprovalsService, ApprovalRulesService],
  exports: [ApprovalsService, ApprovalRulesService],
})
export class ApprovalsModule {}
