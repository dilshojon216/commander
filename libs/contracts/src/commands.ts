import { z } from 'zod';
import { EpochMsSchema, envelopeMessage } from './envelope.js';
import {
  AppendResultSchema,
  AppendTasksPayloadSchema,
  ReadMdPayloadSchema,
  ReadMdResultSchema,
  RefreshPayloadSchema,
  SummarizePayloadSchema,
} from './project-ops.js';
import type { SummarizeInput } from './project-ops.js';
import { RemoteControlResultSchema } from './remote-control.js';
import { ConfigApplyPayloadSchema, ConfigCapturePayloadSchema, ConfigRollbackPayloadSchema } from './config-sync.js';
import type { ConfigApplyPayload, ConfigChunkPayload } from './config-sync.js';
import { CiStatusPayloadSchema, DiffPayloadSchema, OpenPrPayloadSchema } from './git-ops.js';
import { AskPayloadSchema } from './intelligence.js';
import { LogsTailPayloadSchema } from './logs.js';
import { DEPLOY_COMMAND_TYPES, DeployExecPayloadSchema, DeployInspectPayloadSchema } from './deploy.js';
import { CHECKPOINT_COMMAND_TYPES, CheckpointListPayloadSchema, CheckpointPayloadSchema, CheckpointRestorePayloadSchema } from './checkpoints.js';
import type { LogSource } from './logs.js';
import { ScanPayloadSchema } from './scan.js';

/**
 * Remote boshqaruv kontrakti (tasks 2.3-2.7, 2.12). Ikki tomon:
 *  - klientlar <-> center (REST): `POST /v1/commands`, `GET /v1/commands/:id`, `GET /v1/sessions/:id/commands`,
 *    `POST /v1/commands/:id/cancel`; holat o'zgarishi `/ws/client` kanali `commands` (`command.updated`);
 *  - center <-> agentd (`/ws/agent`): `command.dispatch` (imzolangan), `command.ack`, `command.result`.
 *
 * Xavfsizlik qoidalari (CLAUDE.md #1-#4):
 *  - har masofaviy amal `commands` jadvaliga va `audit_log`ga DISPATCHDAN OLDIN yoziladi;
 *  - `command.dispatch` markazning Ed25519 kaliti bilan imzolanadi; agentd imzoni (pin qilingan kalit), muddatni,
 *    `nonce` bir martaligini va LOKAL siyosatni (`~/.commander/policy.json`) tekshiradi; siyosat markazdan o'zgarmaydi;
 *  - `bypassPermissions` (va `dontAsk`) masofadan HECH QACHON: Zod enum'ida yo'q, agentd ham alohida rad etadi;
 *  - prompt matni DB'da redakt qilingan nusxada saqlanadi; haqiqiy matn faqat xotira orqali agentga boradi.
 */

export const SESSION_COMMAND_TYPES = ['session.start', 'session.prompt', 'session.stop', 'session.set_mode', 'session.remote_control', 'session.resume', 'session.close'] as const;
/** Loyiha ish maydoni buyruqlari (2.15): sessiyaga bog'liq emas, `projectId` bilan. */
export const PROJECT_COMMAND_TYPES = ['project.refresh', 'project.read_md', 'project.append_tasks', 'project.summarize', 'project.diff', 'project.open_pr', 'project.ci_status', 'project.scan'] as const;
/** Sozlamalar sinxronlash buyruqlari (3.7): mashinaga bog'liq (loyiha/sessiyasiz). */
export const CONFIG_COMMAND_TYPES = ['config.capture', 'config.apply', 'config.rollback'] as const;
export type ConfigCommandType = (typeof CONFIG_COMMAND_TYPES)[number];
export const isConfigCommandType = (t: string): t is ConfigCommandType => (CONFIG_COMMAND_TYPES as readonly string[]).includes(t);
/** Log ko'ruvchi (6.6): faqat o'qiydigan, imzolangan buyruq; chiqish `logs.chunk` orqali jonli (DB'ga yozilmaydi). */
export const LOGS_COMMAND_TYPES = ['logs.tail'] as const;
export const isLogsCommandType = (t: string): t is (typeof LOGS_COMMAND_TYPES)[number] => (LOGS_COMMAND_TYPES as readonly string[]).includes(t);
/** Commander'dan savol (6.2): mashinaga bog'liq, faqat o'qish (haiku, vositasiz); loyihasiz/sessiyasiz. */
export const ASSISTANT_COMMAND_TYPES = ['assistant.ask'] as const;
export const isAssistantCommandType = (t: string): t is (typeof ASSISTANT_COMMAND_TYPES)[number] => (ASSISTANT_COMMAND_TYPES as readonly string[]).includes(t);
export const COMMAND_TYPES = [...SESSION_COMMAND_TYPES, ...PROJECT_COMMAND_TYPES, ...CONFIG_COMMAND_TYPES, ...ASSISTANT_COMMAND_TYPES, ...LOGS_COMMAND_TYPES, ...DEPLOY_COMMAND_TYPES, ...CHECKPOINT_COMMAND_TYPES] as const;
export const CommandTypeSchema = z.enum(COMMAND_TYPES);
export type CommandType = z.infer<typeof CommandTypeSchema>;
export type ProjectCommandType = (typeof PROJECT_COMMAND_TYPES)[number];
export const isProjectCommandType = (t: string): t is ProjectCommandType => (PROJECT_COMMAND_TYPES as readonly string[]).includes(t);

/**
 * Holat mashinasi: awaiting_confirmation -> pending -> sent -> acked -> running -> done|failed,
 * istalgan nofinal holatdan expired|failed|rejected. Yakuniy: done, failed, expired, rejected.
 */
export const COMMAND_STATES = ['awaiting_confirmation', 'pending', 'sent', 'acked', 'running', 'done', 'failed', 'expired', 'rejected'] as const;
export const CommandStateSchema = z.enum(COMMAND_STATES);
export type CommandState = z.infer<typeof CommandStateSchema>;
export const COMMAND_TERMINAL_STATES: readonly CommandState[] = ['done', 'failed', 'expired', 'rejected'];
export const isTerminalCommandState = (s: CommandState): boolean => COMMAND_TERMINAL_STATES.includes(s);

/** Masofadan ruxsat etilgan ruxsat rejimlari. `bypassPermissions` va `dontAsk` ATAYLAB yo'q. `default` = CLI `manual`. */
export const REMOTE_PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto'] as const;
export const RemotePermissionModeSchema = z.enum(REMOTE_PERMISSION_MODES);
export type RemotePermissionMode = z.infer<typeof RemotePermissionModeSchema>;
/** Shu rejimlarga o'tish/ochish uchun Telegram step-up (ikkinchi tasdiq) majburiy. */
export const STEP_UP_PERMISSION_MODES: readonly RemotePermissionMode[] = ['acceptEdits', 'auto'];

export const COMMAND_LIMITS = {
  /** `session.prompt.text` va `session.start.prompt` (belgi). */
  promptMaxChars: 16_000,
  cwdMaxChars: 4096,
  modelMaxChars: 64,
  nameMaxChars: 60,
  /** `command.dispatch` yaroqlilik muddati (ms): center `sent` holatida shuncha kutadi. */
  dispatchTtlMs: 60_000,
  /** Step-up tasdiq muddati (ms). */
  stepUpTtlMs: 120_000,
  /** Agent `acked`dan keyin natija bermasa center shuncha ms dan keyin `failed(agent_timeout)` qiladi. */
  runTimeoutMs: {
    'session.start': 90_000,
    'session.prompt': 120_000,
    'session.stop': 60_000,
    'session.set_mode': 60_000,
    'session.remote_control': 45_000,
    'session.resume': 75_000,
    'session.close': 45_000,
    'project.refresh': 60_000,
    'project.read_md': 30_000,
    'project.append_tasks': 30_000,
    'project.summarize': 150_000,
    'assistant.ask': 120_000,
    'config.capture': 40_000,
    'config.apply': 60_000,
    'config.rollback': 40_000,
    'project.diff': 45_000,
    'project.open_pr': 120_000,
    'project.ci_status': 60_000,
    'logs.tail': 60_000,
    'deploy.inspect': 45_000,
    'deploy.run': 2 * 60 * 60_000 + 10 * 60_000,
    'deploy.rollback': 2 * 60 * 60_000 + 10 * 60_000,
    'git.checkpoint': 60_000,
    'git.checkpoint_list': 45_000,
    'git.checkpoint_restore': 90_000,
    'project.scan': 300_000,
  } as Record<string, number>,
  /** Bitta mashinada bir vaqtda nofinal buyruqlar. */
  maxOpenPerMachine: 10,
} as const;

/** Model: faqat alias/ID belgilari (CLI argumentiga to'g'ridan-to'g'ri boradi, shuning uchun qat'iy ro'yxat). */
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
/** Sessiya nomi (`-n`): xavfsiz belgilar. */
export const SESSION_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,59}$/;

/** Xato kodlari (center va agentd umumiy). `error.code` shulardan biri. */
export const COMMAND_ERROR_CODES = [
  // center
  'machine_offline',
  'policy_disabled',
  'interactive_session',
  'session_ended',
  'step_up_unavailable',
  'step_up_expired',
  'step_up_cancelled',
  'command_in_flight',
  'dispatch_expired',
  'agent_timeout',
  'lockdown',
  'center_restarted',
  'agent_error',
  'agent_outdated',
  'idempotency_conflict',
  // agentd (imzo/siyosat)
  'bad_signature',
  'expired',
  'replay',
  'wrong_target',
  'center_key_unpinned',
  'center_key_mismatch',
  'invalid_payload',
  'action_not_allowed',
  'cwd_not_allowed',
  'cwd_invalid',
  'mode_forbidden',
  'mode_not_allowed',
  'too_many_sessions',
  'running_as_root',
  // agentd (runner)
  'session_not_found',
  'session_busy',
  'set_mode_unsupported',
  'shim_unsupported',
  'claude_failed',
  'resume_forked',
  // 6.14: tugagan terminal sessiyani tmux ichida davom ettirish
  'session_still_running',
  'resume_unsupported',
  // 6.14: tmux sessiyani masofadan yopish
  'close_failed',
  'correlation_timeout',
  'stop_failed',
  'not_owned',
  'internal',
  // agentd (loyiha ish maydoni, 2.15)
  'project_not_found',
  'path_invalid',
  'file_too_large',
  'file_not_found',
  'tasks_md_changed',
  'tasks_md_missing',
  'tasks_md_invalid',
  'nothing_to_add',
  'summarize_failed',
  'ask_failed',
  'invalid_result',
  // Remote Control (3.10)
  'remote_control_failed',
  'remote_control_unsupported',
  'remote_control_unverified',
  // agentd (sozlamalar sinxronlash, 3.7)
  'config_not_allowed',
  'config_plan_changed',
  'config_bundle_missing',
  'config_bundle_invalid',
  'config_backup_not_found',
  'config_too_large',
  'config_write_failed',
  // agentd (log ko'ruvchi, 6.6)
  'logs_source_unavailable',
  'logs_not_found',
  'logs_not_allowed',
  'logs_busy',
  'logs_failed',
  // agentd (xavfsizlik tekshiruvi, 6.10)
  'scan_failed',
  // center (kunlik byudjet, 6.11)
  'budget_exceeded',
  // center (haftalik limit tezligi, 6.12)
  'weekly_pace_exceeded',
  // agentd (git/PR, 3.5)
  'not_a_git_repo',
  'git_failed',
  'base_invalid',
  'gh_unavailable',
  'gh_unauthenticated',
  'no_remote',
  'dirty_worktree',
  'on_default_branch',
  'nothing_to_pr',
  'push_failed',
  'pr_failed',
  // agentd (deploy, 6.5)
  'recipe_missing',
  'recipe_invalid',
  'recipe_changed',
  'commit_changed',
  'target_not_found',
  'machine_mismatch',
  'shell_not_allowed',
  'deploy_busy',
  'preflight_failed',
  'deploy_failed',
  'health_check_failed',
  // agentd (checkpoint, 6.9)
  'checkpoint_failed',
  'checkpoint_not_found',
  'branch_changed',
  'head_diverged',
  'no_commits',
] as const;
export const CommandErrorCodeSchema = z.enum(COMMAND_ERROR_CODES);
export type CommandErrorCode = z.infer<typeof CommandErrorCodeSchema>;

// --- agent-facing payload'lar (imzolanadigan qism) ---------------------------------------------

const PromptTextSchema = z.string().min(1).max(COMMAND_LIMITS.promptMaxChars);

export const StartPayloadSchema = z.object({
  cwd: z.string().min(1).max(COMMAND_LIMITS.cwdMaxChars),
  prompt: PromptTextSchema,
  model: z.string().regex(MODEL_RE).optional(),
  permissionMode: RemotePermissionModeSchema,
  name: z.string().regex(SESSION_NAME_RE).optional(),
  /** 3.10: sessiyani `--remote-control` bilan ochish (nom sifatida `name` ishlatiladi). Siyosatda `allowPrompt` shart. */
  remoteControl: z.boolean().optional(),
});
export type StartPayload = z.infer<typeof StartPayloadSchema>;

const ClaudeSessionIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);

export const PromptPayloadSchema = z.object({ claudeSessionId: ClaudeSessionIdSchema, text: PromptTextSchema });
export type PromptPayload = z.infer<typeof PromptPayloadSchema>;
export const StopPayloadSchema = z.object({ claudeSessionId: ClaudeSessionIdSchema });
export type StopPayload = z.infer<typeof StopPayloadSchema>;
export const SetModePayloadSchema = z.object({ claudeSessionId: ClaudeSessionIdSchema, permissionMode: RemotePermissionModeSchema });
export type SetModePayload = z.infer<typeof SetModePayloadSchema>;
/** 3.10: tmux sessiyada Remote Control'ni yoqish/o'chirish (`name` faqat yoqishda). */
export const RemoteControlPayloadSchema = z.object({ claudeSessionId: ClaudeSessionIdSchema, enable: z.boolean(), name: z.string().regex(SESSION_NAME_RE).optional() });
export type RemoteControlPayload = z.infer<typeof RemoteControlPayloadSchema>;
/**
 * 6.14: tugagan terminal sessiyani `claude --resume <id>` bilan YANGI tmux sessiya ichida davom ettirish (xuddi shu suhbat, nusxa emas).
 * `cwd` markaz DB'sidagi sessiya cwd'si; agentd uni lokal siyosat (`allowedRoots`) bilan qayta tekshiradi.
 */
export const ResumePayloadSchema = z.object({ claudeSessionId: ClaudeSessionIdSchema, cwd: z.string().min(1).max(COMMAND_LIMITS.cwdMaxChars) });
export type ResumePayload = z.infer<typeof ResumePayloadSchema>;
/** 6.14: tmux sessiyani YOPISH (Escape + `/exit`; agentd o'zi ochgan tmux sessiya tirik qolsa o'chiriladi). Foydalanuvchi prompti emas. */
export const ClosePayloadSchema = z.object({ claudeSessionId: ClaudeSessionIdSchema });
export type ClosePayload = z.infer<typeof ClosePayloadSchema>;
/** tmux sessiya nomi (`cmdr-<id boshi>[-xxx]`): `tmux attach -t <nom>` ga to'g'ridan-to'g'ri boradi, shuning uchun qat'iy. */
export const TMUX_SESSION_NAME_RE = /^cmdr-[A-Za-z0-9]{1,16}(-[0-9a-f]{3})?$/;

// --- imzo -------------------------------------------------------------------------------------

export const COMMAND_SIG_VERSION = 'COMMANDER-CMD-V1';
/** base64url, 32 bayt tasodifiy (43 belgi). */
export const CommandNonceSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const CommandSigSchema = z.string().regex(/^[A-Za-z0-9_-]{86}$/);
/** Center Ed25519 public key: xom 32 bayt, base64url (43 belgi). */
export const CenterPublicKeySchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** Deterministik JSON (kalitlar saralangan, `undefined` tashlanadi): imzo xeshi ikki tomonda bir xil bo'lishi uchun. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export interface CommandSigParts {
  /** Maqsad agentd qurilmasi (kichik harf): boshqa mashinaga qayta yuborishdan himoya. */
  deviceId: string;
  commandId: string;
  type: CommandType;
  nonce: string;
  /** epoch ms */
  expiresAt: number;
  /** `sha256(canonicalJson(payload))`, kichik harfli hex (64). */
  payloadSha256: string;
}

/**
 * Imzolanadigan kanonik satr (UTF-8, `\n` bilan, oxirida `\n` YO'Q):
 *
 *   COMMANDER-CMD-V1
 *   <deviceId>
 *   <commandId>
 *   <type>
 *   <nonce>
 *   <expiresAt>
 *   <payloadSha256>
 */
export function buildCommandSigString(p: CommandSigParts): string {
  return [COMMAND_SIG_VERSION, p.deviceId.toLowerCase(), p.commandId.toLowerCase(), p.type, p.nonce, String(p.expiresAt), p.payloadSha256.toLowerCase()].join('\n');
}

// --- agent protokoli xabarlari -----------------------------------------------------------------

const dispatchBase = {
  commandId: z.uuid(),
  nonce: CommandNonceSchema,
  expiresAt: EpochMsSchema,
  sig: CommandSigSchema,
};

/** center -> agent. `payload` agentd'da qayta tekshiriladi (imzo xeshi `canonicalJson(payload)` ustida). */
export const CommandDispatchPayloadSchema = z.discriminatedUnion('type', [
  z.object({ ...dispatchBase, type: z.literal('project.refresh'), payload: RefreshPayloadSchema }),
  z.object({ ...dispatchBase, type: z.literal('project.read_md'), payload: ReadMdPayloadSchema }),
  z.object({ ...dispatchBase, type: z.literal('project.append_tasks'), payload: AppendTasksPayloadSchema }),
  z.object({ ...dispatchBase, type: z.literal('project.summarize'), payload: SummarizePayloadSchema }),
  z.object({ ...dispatchBase, type: z.literal('assistant.ask'), payload: AskPayloadSchema }),
  z.object({ ...dispatchBase, type: z.literal('config.capture'), payload: ConfigCapturePayloadSchema }),
  z.object({ ...dispatchBase, type: z.literal('config.apply'), payload: ConfigApplyPayloadSchema }),
  z.object({ ...dispatchBase, type: z.literal('config.rollback'), payload: ConfigRollbackPayloadSchema }),
  z.object({ ...dispatchBase, type: z.literal('project.diff'), payload: DiffPayloadSchema }),
  z.object({ ...dispatchBase, type: z.literal('project.open_pr'), payload: OpenPrPayloadSchema }),
  z.object({ ...dispatchBase, type: z.literal('project.ci_status'), payload: CiStatusPayloadSchema }),
  z.object({ ...dispatchBase, type: z.literal('logs.tail'), payload: LogsTailPayloadSchema }),
  z.object({ ...dispatchBase, type: z.literal('deploy.inspect'), payload: DeployInspectPayloadSchema }),
  z.object({ ...dispatchBase, type: z.literal('deploy.run'), payload: DeployExecPayloadSchema }),
  z.object({ ...dispatchBase, type: z.literal('deploy.rollback'), payload: DeployExecPayloadSchema }),
  z.object({ ...dispatchBase, type: z.literal('git.checkpoint'), payload: CheckpointPayloadSchema }),
  z.object({ ...dispatchBase, type: z.literal('git.checkpoint_list'), payload: CheckpointListPayloadSchema }),
  z.object({ ...dispatchBase, type: z.literal('git.checkpoint_restore'), payload: CheckpointRestorePayloadSchema }),
  z.object({ ...dispatchBase, type: z.literal('project.scan'), payload: ScanPayloadSchema }),
  z.object({ ...dispatchBase, type: z.literal('session.start'), payload: StartPayloadSchema }),
  z.object({ ...dispatchBase, type: z.literal('session.prompt'), payload: PromptPayloadSchema }),
  z.object({ ...dispatchBase, type: z.literal('session.stop'), payload: StopPayloadSchema }),
  z.object({ ...dispatchBase, type: z.literal('session.set_mode'), payload: SetModePayloadSchema }),
  z.object({ ...dispatchBase, type: z.literal('session.remote_control'), payload: RemoteControlPayloadSchema }),
  z.object({ ...dispatchBase, type: z.literal('session.resume'), payload: ResumePayloadSchema }),
  z.object({ ...dispatchBase, type: z.literal('session.close'), payload: ClosePayloadSchema }),
]);
export type CommandDispatchPayload = z.infer<typeof CommandDispatchPayloadSchema>;
export const CommandDispatchMessageSchema = envelopeMessage('command.dispatch', CommandDispatchPayloadSchema);
export type CommandDispatchMessage = z.infer<typeof CommandDispatchMessageSchema>;

/** Agent buyruqni qabul qildi (imzo, muddat, nonce, siyosat o'tdi) va bajarishni boshlaydi. */
export const CommandAckPayloadSchema = z.object({ commandId: z.uuid() });
export type CommandAckPayload = z.infer<typeof CommandAckPayloadSchema>;
export const CommandAckMessageSchema = envelopeMessage('command.ack', CommandAckPayloadSchema);

export const CommandResultDataSchema = z.object({
  /** `session.start`: yangi sessiyaning Claude session id'si (`claude agents --json` bilan bog'langan). */
  claudeSessionId: z.string().min(1).max(255).optional(),
  /** 6.14: `session.resume` natijasi: yangi tmux sessiya nomi (`tmux attach -t <nom>`). */
  tmuxSession: z.string().regex(TMUX_SESSION_NAME_RE).optional(),
  /** `claude` qisqa id (`claude stop/attach` uchun). */
  shortId: z.string().min(1).max(32).optional(),
  /** Qisqa izoh (<= 200): masalan "stop+resume". */
  detail: z.string().max(200).optional(),
  /** `project.read_md`: redakt qilingan md (markazda faqat xotirada; DB'ga yozilmaydi). */
  md: ReadMdResultSchema.optional(),
  /** `project.append_tasks` natijasi. */
  append: AppendResultSchema.optional(),
  /** `project.summarize` natijasi (markaz `daily_summaries`ga yozadi; `commands.result`ga matn tushmaydi). */
  /** Ataylab bo'sh sxema: yaroqsiz natija WS darajasida nack bo'lib buyruq osilib qolmasin; markaz `SummarizeResultSchema` bilan tekshiradi. */
  summary: z.unknown().optional(),
  /** 3.10: `session.remote_control` (va RC bilan `session.start`) natijasi: pane'dan o'qilgan holat. */
  remoteControl: RemoteControlResultSchema.optional(),
  /** `config.*` natijasi (3.7): ataylab bo'sh sxema; markaz `ConfigResultSchema` bilan tekshiradi va xotirada saqlaydi (DB'ga yozilmaydi). */
  config: z.unknown().optional(),
  /** 3.5: `project.diff` (markazda xotirada), `project.open_pr`, `project.ci_status` natijalari. Ataylab bo'sh sxema: markaz `git-ops` sxemalari bilan tekshiradi. */
  diff: z.unknown().optional(),
  pr: z.unknown().optional(),
  ci: z.unknown().optional(),
  /** 6.2: `assistant.ask` natijasi (javob matni). Ataylab bo'sh sxema; markaz `AskResultSchema` bilan tekshiradi va faqat xotirada saqlaydi (DB'ga yozilmaydi). */
  assistant: z.unknown().optional(),
  /** 6.5: `deploy.inspect` natijasi (markazda xotirada) va `deploy.run|rollback` xulosasi (nomlar/holatlar; `commands.result` da saqlanadi). Ataylab bo'sh sxema: markaz `deploy` sxemalari bilan tekshiradi. */
  deploy: z.unknown().optional(),
  /** 6.9: `git.checkpoint*` natijalari (markaz `checkpoints` sxemalari bilan tekshiradi). */
  checkpoint: z.unknown().optional(),
  /** 6.10: `project.scan` natijasi. Ataylab bo'sh sxema; markaz `ScanResultSchema` bilan tekshiradi, redakt qiladi va `project_scans`ga yozadi (`commands.result`ga topilmalar tushmaydi). */
  scan: z.unknown().optional(),
});
export type CommandResultData = z.infer<typeof CommandResultDataSchema>;

export const CommandErrorSchema = z.object({
  /** Odatda `COMMAND_ERROR_CODES` dan; noma'lum kod ham qabul qilinadi (yangi agentd eski centerga ham yozishi mumkin). */
  code: z.string().min(1).max(64),
  message: z.string().max(500),
});
export type CommandError = z.infer<typeof CommandErrorSchema>;

/**
 * agent -> center. `rejected`: imzo/muddat/replay/siyosat rad etdi (hech narsa bajarilmadi);
 * `running`: bajarish boshlandi (ixtiyoriy oraliq); `done` | `failed`: yakun.
 */
export const COMMAND_RESULT_STATES = ['running', 'done', 'failed', 'rejected'] as const;
export const CommandResultPayloadSchema = z.object({
  commandId: z.uuid(),
  state: z.enum(COMMAND_RESULT_STATES),
  result: CommandResultDataSchema.optional(),
  error: CommandErrorSchema.optional(),
});
export type CommandResultPayload = z.infer<typeof CommandResultPayloadSchema>;
export const CommandResultMessageSchema = envelopeMessage('command.result', CommandResultPayloadSchema);

/** agentd lokal siyosatining markazga e'lon qilinadigan ko'rinishi (heartbeat). Yo'llar (`allowedRoots`) YUBORILMAYDI. */
export const AgentControlStateSchema = z.object({
  enabled: z.boolean(),
  allowStart: z.boolean(),
  allowPrompt: z.boolean(),
  allowStop: z.boolean(),
  allowSetMode: z.boolean(),
  allowAutoMode: z.boolean(),
  maxConcurrentStarted: z.number().int().min(0).max(100),
  allowedRootCount: z.number().int().min(0).max(1000),
  /** agentd markaz kalitini pin qilganmi (aks holda buyruqlar rad etiladi). */
  centerKeyPinned: z.boolean(),
  /** agentd root bilan ishlayaptimi (shunda masofaviy buyruqlar rad etiladi). */
  runningAsRoot: z.boolean(),
  /** agentd loyiha ish maydoni buyruqlarini (2.15) biladi; yo'q = eski versiya (`agent_outdated`). */
  projectOps: z.boolean().optional(),
  /** agentd Remote Control buyruqlarini (3.10) biladi; yo'q = eski versiya (`agent_outdated`). */
  remoteControl: z.boolean().optional(),
  allowProjectRead: z.boolean().optional(),
  allowProjectWrite: z.boolean().optional(),
  /** 3.5: agentd git/PR buyruqlarini (`project.diff|open_pr|ci_status`) biladi; yo'q = eski versiya (`agent_outdated`). */
  gitOps: z.boolean().optional(),
  /** agentd sozlamalar sinxronlashni (3.7) biladi; yo'q = eski versiya. */
  configSync: z.boolean().optional(),
  allowConfigRead: z.boolean().optional(),
  allowConfigWrite: z.boolean().optional(),
  /** 6.6: agentd `logs.tail` ni biladi; yo'q = eski versiya (`agent_outdated`). */
  logs: z.boolean().optional(),
  /** 6.6: siyosat docker/journal loglariga ruxsat beradimi (fayl loglari: `allowedLogRootCount` > 0 yoki standart ildiz). */
  allowLogs: z.boolean().optional(),
  allowedLogRootCount: z.number().int().min(0).max(1000).optional(),
  /** 6.2: agentd `assistant.ask` (haiku, vositasiz) buyrug'ini biladi; yo'q = eski versiya (`agent_outdated`). */
  assistant: z.boolean().optional(),
  /** 6.5: agentd `deploy.*` buyruqlarini biladi; `allowDeploy`/`allowDeployShell` lokal siyosat (default o'chiq). */
  deploy: z.boolean().optional(),
  allowDeploy: z.boolean().optional(),
  allowDeployShell: z.boolean().optional(),
  /** 6.9: agentd `git.checkpoint*` buyruqlarini biladi. */
  checkpoints: z.boolean().optional(),
  /** 6.10: agentd `project.scan` (xavfsizlik/dependency tekshiruvi) ni biladi; yo'q = eski versiya (`agent_outdated`). */
  scan: z.boolean().optional(),
  /** 6.10: siyosat `project.scan` ga ruxsat beradimi (default true: faqat o'qish). */
  allowScan: z.boolean().optional(),
  /** 6.14: agentd `session.resume` (tugagan terminal sessiyani tmux'da davom ettirish) ni biladi; yo'q = eski versiya (`agent_outdated`). */
  resume: z.boolean().optional(),
  /** 6.14: agentd `session.close` ni biladi (siyosat: `allowStop`). */
  close: z.boolean().optional(),
});
export type AgentControlState = z.infer<typeof AgentControlStateSchema>;

// --- sessiya boshqariluvchanligi (SessionDto) ---------------------------------------------------

/**
 * UI prompt-box holati uchun sabab (`controllable=false` bo'lganda):
 *  - machine_offline: mashinada agentd ulanmagan;
 *  - policy_disabled: lokal siyosat masofaviy boshqaruvni yoqmagan (yoki root'da / kalit pin qilinmagan: `agent_not_ready`);
 *  - interactive: terminalda ochilgan sessiya (faqat ko'rish);
 *  - session_ended: sessiya tugagan;
 *  - prompt_not_allowed: siyosat prompt yuborishga ruxsat bermaydi;
 *  - agent_outdated: agentd bu imkoniyatni e'lon qilmagan (eski versiya).
 */
export const CONTROL_REASONS = ['machine_offline', 'policy_disabled', 'interactive', 'session_ended', 'prompt_not_allowed', 'agent_not_ready', 'agent_outdated'] as const;
export const ControlReasonSchema = z.enum(CONTROL_REASONS);
export type ControlReason = z.infer<typeof ControlReasonSchema>;

/**
 * 6.14: tugagan terminal sessiyani "Davom ettirish" mumkinmi (UI tugmasi). `available=false` bo'lsa `reason` sababni beradi
 * (UI: tugmani yashiradi yoki tushuntiradi). Oxirgi so'z agentdniki (u hali tirik jarayonni ham tekshiradi).
 */
export const RESUME_REASONS = ['not_ended', 'not_terminal', 'machine_offline', 'policy_disabled', 'agent_not_ready', 'agent_outdated', 'start_not_allowed', 'unsupported_os', 'no_cwd'] as const;
export const ResumeReasonSchema = z.enum(RESUME_REASONS);
export type ResumeReason = z.infer<typeof ResumeReasonSchema>;
export const SessionResumeSchema = z.object({ available: z.boolean(), reason: ResumeReasonSchema.nullable() });
export type SessionResume = z.infer<typeof SessionResumeSchema>;

export const SessionControlsSchema = z.object({ prompt: z.boolean(), stop: z.boolean(), setMode: z.boolean(), remoteControl: z.boolean().optional(), /** 6.14: tmux sessiyani yopish mumkin */ close: z.boolean().optional() });
export type SessionControls = z.infer<typeof SessionControlsSchema>;

// --- REST ---------------------------------------------------------------------------------------

export const CreateCommandBodySchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('session.start'),
      machineId: z.uuid(),
      cwd: z.string().min(1).max(COMMAND_LIMITS.cwdMaxChars),
      prompt: PromptTextSchema,
      model: z.string().regex(MODEL_RE).optional(),
      permissionMode: RemotePermissionModeSchema,
      name: z.string().regex(SESSION_NAME_RE).optional(),
      /** 3.10: `--remote-control` bilan ochish (step-up: `session.start` qoidasi bilan bir xil; siyosatda `allowPrompt` shart). */
      remoteControl: z.boolean().optional(),
      /** 6.9: "katta vazifa" shabloni bilan ochilmoqda: markaz sozlama yoqilgan bo'lsa avval avto-checkpoint oladi (best-effort; buyruqqa kirmaydi). */
      checkpoint: z.boolean().optional(),
    })
    .strict(),
  z.object({ type: z.literal('session.prompt'), sessionId: z.uuid(), text: PromptTextSchema }).strict(),
  z.object({ type: z.literal('session.stop'), sessionId: z.uuid() }).strict(),
  z.object({ type: z.literal('session.set_mode'), sessionId: z.uuid(), permissionMode: RemotePermissionModeSchema }).strict(),
  z.object({ type: z.literal('session.remote_control'), sessionId: z.uuid(), enable: z.boolean(), name: z.string().regex(SESSION_NAME_RE).optional() }).strict(),
  /** 6.14: "Davom ettirish": cwd va claude session id markaz DB'sidan olinadi, mijoz bermaydi. */
  z.object({ type: z.literal('session.resume'), sessionId: z.uuid() }).strict(),
  /** 6.14: "Yopish": faqat tmux ichidagi sessiya. */
  z.object({ type: z.literal('session.close'), sessionId: z.uuid() }).strict(),
]);
export type CreateCommandBody = z.infer<typeof CreateCommandBodySchema>;

/**
 * Loyiha buyruqlari (faqat `/v1/projects/:id/...` endpoint'lari yaratadi; `POST /v1/commands` ularni QABUL QILMAYDI).
 * `projectId` markazda tekshiriladi; agentga `root` (loyiha yo'li) markaz DB'sidan boradi, mijoz bermaydi.
 */
export type ProjectCommandBody =
  | { type: 'project.refresh'; projectId: string }
  | { type: 'project.read_md'; projectId: string; path: string }
  | {
      type: 'project.append_tasks';
      projectId: string;
      /** Markaz ko'rgan snapshot'dagi fayl yo'li va xom bayt xeshi (optimistik konkurentlik). */
      tasksPath: 'docs/TASKS.md' | 'TASKS.md';
      baseHash: string;
      phase: string;
      tasks: Array<{ key: string; title: string; size?: string | undefined }>;
    }
  /** `part` (6.18): faqat markaz ichida (xulosani qism kaliti bilan saqlash); agentga YUBORILMAYDI ('' / yo'q = butun loyiha). */
  | { type: 'project.summarize'; projectId: string; input: SummarizeInput; part?: string | undefined }
  | { type: 'project.diff'; projectId: string; base?: string | undefined; maxBytes?: number | undefined; statOnly?: boolean | undefined }
  | { type: 'project.open_pr'; projectId: string; title: string; body: string; base: string; head?: string | undefined; draft: boolean }
  | { type: 'project.ci_status'; projectId: string; branch?: string | undefined }
  | { type: 'project.scan'; projectId: string };

/**
 * Sozlamalar sinxronlash buyruqlari (3.7; faqat `/v1/config/...` endpoint'lari yaratadi, `POST /v1/commands` QABUL QILMAYDI).
 * `apply.chunks` = gzip bundle bo'laklari: markaz XOTIRASIDA turadi va `command.dispatch` dan oldin `config.chunk` bilan yuboriladi.
 * `preview` = Telegram step-up xabari uchun qisqa matn (markaz tuzadi; redakt qilinadi).
 */
export type ConfigCommandBody =
  | { type: 'config.capture'; machineId: string }
  | { type: 'config.apply'; machineId: string; apply: ConfigApplyPayload; chunks: ConfigChunkPayload[]; preview: string; profileId: string; /** H-06: bajariladigan kontent bayroqlari (markaz hisoblaydi) */ review?: CommandReview | undefined }
  | { type: 'config.rollback'; machineId: string; backupId: string };

/** Log ko'ruvchi buyrug'i (6.6; faqat `/v1/machines/:id/logs` va Telegram `/logs` yaratadi, `POST /v1/commands` QABUL QILMAYDI). */
export type LogsCommandBody = { type: 'logs.tail'; machineId: string; source: LogSource; name: string; lines: number; since?: string | undefined; follow?: boolean | undefined };

/** Deploy buyruqlari (6.5; faqat `/v1/projects/:id/deploy/*` yaratadi, `POST /v1/commands` QABUL QILMAYDI). `root`/`machine` markazda DB'dan. */
export type DeployCommandBody =
  | { type: 'deploy.inspect'; projectId: string; commit?: string | undefined }
  | { type: 'deploy.run' | 'deploy.rollback'; projectId: string; target: string; recipeHash: string; commit: string; /** Tasdiq kartasi matni (markaz inspect natijasidan tuzadi; agentga BORMAYDI). */ plan?: string | undefined };

/** Checkpoint buyruqlari (6.9; faqat `/v1/projects/:id/checkpoints*` yaratadi, `POST /v1/commands` QABUL QILMAYDI). */
export type CheckpointCommandBody =
  | { type: 'git.checkpoint'; projectId: string; label: string; auto?: boolean | undefined }
  | { type: 'git.checkpoint_list'; projectId: string }
  | { type: 'git.checkpoint_restore'; projectId: string; ref: string };

/** Commander'dan savol (6.2; faqat `/v1/assistant/ask` yaratadi, `POST /v1/commands` QABUL QILMAYDI). `context` markazda tuzilgan (transcript YO'Q), faqat xotirada. */
export type AssistantCommandBody = { type: 'assistant.ask'; machineId: string; question: string; context: string };

/** `Idempotency-Key` sarlavhasi: 8-128 belgi. Bir xil kalit + bir xil tana = o'sha buyruq (200); boshqa tana = 409 `idempotency_conflict`. */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
export const IdempotencyKeySchema = z.string().regex(/^[A-Za-z0-9_.:-]{8,128}$/);

const IsoDate = z.string();

/** Step-up holati (faqat tasdiq talab qilingan buyruqlarda). */
export const CommandStepUpSchema = z.object({
  required: z.boolean(),
  via: z.literal('telegram').nullable(),
  /** Tasdiq muddati (ISO); tasdiqdan keyin ham saqlanadi. */
  expiresAt: IsoDate.nullable(),
  confirmedAt: IsoDate.nullable(),
  confirmedByDeviceId: z.uuid().nullable(),
});

/**
 * Ko'rib chiqish talabi (H-04/H-06, M-16): buyruq matni/hajmi egasi tasdiqlashidan oldin to'liq ko'rishni talab qiladi
 * (xavfli andozalar, kesilgan/yashirilgan matn, bajariladigan konfiguratsiya). `required` bo'lsa Telegram faqat havola
 * beradi; tasdiq dashboard'da (`POST /v1/commands/:id/confirm`, `approve` scope).
 */
export const CommandReviewSchema = z.object({
  required: z.boolean(),
  reasons: z.array(z.string().max(300)).max(16),
});
export type CommandReview = z.infer<typeof CommandReviewSchema>;

/**
 * Bitta buyruq (REST va `command.updated`). `payload` REDAKT qilingan va kesilgan (prompt matni `promptPreview` da
 * maksimum 300 belgi); haqiqiy matn hech qachon qaytarilmaydi.
 */
export const CommandDtoSchema = z.object({
  id: z.uuid(),
  type: CommandTypeSchema,
  status: CommandStateSchema,
  machineId: z.uuid(),
  machineSlug: z.string(),
  /** Loyiha buyruqlari (2.15) uchun loyiha uuid'si; sessiya buyruqlarida `null`/yo'q. */
  projectId: z.uuid().nullable().optional(),
  /** Center sessiya uuid'si (start uchun natijadan keyin bog'lanadi). */
  sessionId: z.uuid().nullable(),
  claudeSessionId: z.string().nullable(),
  cwd: z.string().nullable(),
  permissionMode: RemotePermissionModeSchema.nullable(),
  model: z.string().nullable(),
  promptLength: z.number().int().nullable(),
  /** Redakt qilingan, <= 500 belgi. */
  promptPreview: z.string().nullable(),
  requestedByDeviceId: z.uuid(),
  stepUp: CommandStepUpSchema,
  /** H-04/H-06: tasdiqdan oldin to'liq ko'rish kerakmi (yo'q = oddiy). */
  review: CommandReviewSchema.optional(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  result: CommandResultDataSchema.nullable(),
  createdAt: IsoDate,
  sentAt: IsoDate.nullable(),
  ackedAt: IsoDate.nullable(),
  finishedAt: IsoDate.nullable(),
  /** Joriy bosqich muddati: awaiting_confirmation = tasdiq; sent = agent ack muddati. */
  expiresAt: IsoDate,
});
export type CommandDto = z.infer<typeof CommandDtoSchema>;

/** `POST /v1/commands` javobi: 201 yangi buyruq (biznes rad ham: `status` rejected/failed + `errorCode`), 200 idempotent takror. */
export const CreateCommandResponseSchema = z.object({ command: CommandDtoSchema, idempotent: z.boolean() });
export type CreateCommandResponse = z.infer<typeof CreateCommandResponseSchema>;

export const ListCommandsQuerySchema = z
  .object({
    machine: z.uuid().optional(),
    session: z.uuid().optional(),
    status: CommandStateSchema.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
export type ListCommandsQuery = z.infer<typeof ListCommandsQuerySchema>;

export const ListCommandsResponseSchema = z.object({ items: z.array(CommandDtoSchema) });
export type ListCommandsResponse = z.infer<typeof ListCommandsResponseSchema>;

/** `/ws/client` push: har holat o'zgarishida to'liq DTO. */
export const CommandUpdatedMessageSchema = envelopeMessage('command.updated', z.object({ command: CommandDtoSchema }));
export type CommandUpdatedMessage = z.infer<typeof CommandUpdatedMessageSchema>;
