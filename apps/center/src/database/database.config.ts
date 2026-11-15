import { Approval } from './entities/approval.entity.js';
import { ApprovalRule } from './entities/approval-rule.entity.js';
import { PromptTemplate } from './entities/prompt-template.entity.js';
import { AuditLog } from './entities/audit-log.entity.js';
import { Command } from './entities/command.entity.js';
import { EnrollmentCode } from './entities/enrollment-code.entity.js';
import { ClientPairingCode } from './entities/client-pairing-code.entity.js';
import { Device } from './entities/device.entity.js';
import { LimitSample } from './entities/limit-sample.entity.js';
import { Machine } from './entities/machine.entity.js';
import { MachineMergeCandidate } from './entities/machine-merge-candidate.entity.js';
import { Project } from './entities/project.entity.js';
import { ProjectSnapshot } from './entities/project-snapshot.entity.js';
import { ProjectTask } from './entities/project-task.entity.js';
import { ProjectPart } from './entities/project-part.entity.js';
import { SessionTaskSpan } from './entities/session-task-span.entity.js';
import { Session } from './entities/session.entity.js';
import { SessionEvent } from './entities/session-event.entity.js';
import { DailySummary } from './entities/daily-summary.entity.js';
import { TaskBoard } from './entities/task-board.entity.js';
import { TaskEvent } from './entities/task-event.entity.js';
import { MessagingGroup, ProjectLink, SessionMessage, SessionRole } from './entities/messaging.entity.js';
import { Setting } from './entities/setting.entity.js';
import { TokenUsage } from './entities/token-usage.entity.js';
import { UsedNonce } from './entities/used-nonce.entity.js';
import { InitSchema1731400000000 } from './migrations/1731400000000-InitSchema.js';
import { EnableTimescale1731400100000 } from './migrations/1731400100000-EnableTimescale.js';
import { RenameV0Sessions1731400200000 } from './migrations/1731400200000-RenameV0Sessions.js';
import { MachinesDevices1731400300000 } from './migrations/1731400300000-MachinesDevices.js';
import { SessionsV21731400400000 } from './migrations/1731400400000-SessionsV2.js';
import { MoveV0Data1731400500000 } from './migrations/1731400500000-MoveV0Data.js';
import { UsageAndLimits1731400600000 } from './migrations/1731400600000-UsageAndLimits.js';
import { CommandsAudit1731400700000 } from './migrations/1731400700000-CommandsAudit.js';
import { ProjectUsageStats1731400800000 } from './migrations/1731400800000-ProjectUsageStats.js';
import { Identity1731400900000 } from './migrations/1731400900000-Identity.js';
import { AgentChannel1731401000000 } from './migrations/1731401000000-AgentChannel.js';
import { Approvals1731401100000 } from './migrations/1731401100000-Approvals.js';
import { SessionPermissionMode1731401200000 } from './migrations/1731401200000-SessionPermissionMode.js';
import { RemoteCommands1731401300000 } from './migrations/1731401300000-RemoteCommands.js';
import { ProjectTasks1731401400000 } from './migrations/1731401400000-ProjectTasks.js';
import { ProjectWork1731401500000 } from './migrations/1731401500000-ProjectWork.js';
import { Messaging1731401600000 } from './migrations/1731401600000-Messaging.js';
import { ApprovalRules1731401800000 } from './migrations/1731401800000-ApprovalRules.js';
import { TaskQueue1731402000000 } from './migrations/1731402000000-TaskQueue.js';
import { WatchdogReports1731402100000 } from './migrations/1731402100000-WatchdogReports.js';
import { MachineHealth1731402200000 } from './migrations/1731402200000-MachineHealth.js';
import { ConfigSync1731403200000 } from './migrations/1731403200000-ConfigSync.js';
import { PromptTemplates1731403060000 } from './migrations/1731403060000-PromptTemplates.js';
import { RemoteControl1731403070000 } from './migrations/1731403070000-RemoteControl.js';
import { GitIntegration1731403100000 } from './migrations/1731403100000-GitIntegration.js';
import { Orchestration1731403300000 } from './migrations/1731403300000-Orchestration.js';
import { ClientPairing1731403400000 } from './migrations/1731403400000-ClientPairing.js';
import { KeyRotation1731404000000 } from './migrations/1731404000000-KeyRotation.js';
import { RetentionCompression1731404010000 } from './migrations/1731404010000-RetentionCompression.js';
import { CenterIncidents1731404020000 } from './migrations/1731404020000-CenterIncidents.js';
import { OrchestrationScope1731405000000 } from './migrations/1731405000000-OrchestrationScope.js';
import { Intelligence1731407060000 } from './migrations/1731407060000-Intelligence.js';
import { LogsInvestigations1731407100000 } from './migrations/1731407100000-LogsInvestigations.js';
import { Billing1731407200000 } from './migrations/1731407200000-Billing.js';
import { DeployCheckpoints1731408050000 } from './migrations/1731408050000-DeployCheckpoints.js';
import { ScansBudgets1731408100000 } from './migrations/1731408100000-ScansBudgets.js';
import { WeeklyPace1731408200000 } from './migrations/1731408200000-WeeklyPace.js';
import { AskQuestions1731408300000 } from './migrations/1731408300000-AskQuestions.js';
import { MergeSubfolderProjects1731408400000 } from './migrations/1731408400000-MergeSubfolderProjects.js';
import { SessionResume1731408500000 } from './migrations/1731408500000-SessionResume.js';
import { BackfillSessionModel1731408600000 } from './migrations/1731408600000-BackfillSessionModel.js';
import { ProjectParts1731408700000 } from './migrations/1731408700000-ProjectParts.js';
import { ProjectArchive1731408800000 } from './migrations/1731408800000-ProjectArchive.js';
import { DailySummaryPart1731409000000 } from './migrations/1731409000000-DailySummaryPart.js';

/** Barcha entity'lar va migratsiyalar (tartib bo'yicha). `synchronize` taqiqlangan. */
export const ENTITIES = [
  Machine,
  Device,
  Project,
  ProjectSnapshot,
  Session,
  SessionEvent,
  TokenUsage,
  LimitSample,
  Command,
  AuditLog,
  EnrollmentCode,
  ClientPairingCode,
  UsedNonce,
  Setting,
  MachineMergeCandidate,
  Approval,
  ProjectTask,
  ProjectPart,
  SessionTaskSpan,
  TaskBoard,
  TaskEvent,
  DailySummary,
  MessagingGroup,
  ProjectLink,
  SessionRole,
  SessionMessage,
  ApprovalRule,
  PromptTemplate,
];

export const MIGRATIONS = [
  InitSchema1731400000000,
  EnableTimescale1731400100000,
  RenameV0Sessions1731400200000,
  MachinesDevices1731400300000,
  SessionsV21731400400000,
  MoveV0Data1731400500000,
  UsageAndLimits1731400600000,
  CommandsAudit1731400700000,
  ProjectUsageStats1731400800000,
  Identity1731400900000,
  AgentChannel1731401000000,
  Approvals1731401100000,
  SessionPermissionMode1731401200000,
  RemoteCommands1731401300000,
  ProjectTasks1731401400000,
  ProjectWork1731401500000,
  Messaging1731401600000,
  ApprovalRules1731401800000,
  TaskQueue1731402000000,
  WatchdogReports1731402100000,
  MachineHealth1731402200000,
  PromptTemplates1731403060000,
  RemoteControl1731403070000,
  GitIntegration1731403100000,
  ConfigSync1731403200000,
  Orchestration1731403300000,
  ClientPairing1731403400000,
  KeyRotation1731404000000,
  RetentionCompression1731404010000,
  CenterIncidents1731404020000,
  OrchestrationScope1731405000000,
  Intelligence1731407060000,
  LogsInvestigations1731407100000,
  Billing1731407200000,
  DeployCheckpoints1731408050000,
  ScansBudgets1731408100000,
  WeeklyPace1731408200000,
  AskQuestions1731408300000,
  MergeSubfolderProjects1731408400000,
  SessionResume1731408500000,
  BackfillSessionModel1731408600000,
  ProjectParts1731408700000,
  ProjectArchive1731408800000,
  DailySummaryPart1731409000000,
];

/** Ilova va CLI uchun umumiy TypeORM sozlamasi. CLI migratsiya ishga tushirmaydi (buni ilova qiladi). */
export function typeOrmOptions(url: string, migrationsRun: boolean) {
  return {
    type: 'postgres' as const,
    url,
    entities: ENTITIES,
    migrations: MIGRATIONS,
    migrationsRun,
    synchronize: false,
  };
}
