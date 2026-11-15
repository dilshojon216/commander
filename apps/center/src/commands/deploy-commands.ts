import {
  DeployInspectResultSchema,
  DeploySummarySchema,
  CheckpointListResultSchema,
  CheckpointRestoreResultSchema,
  CheckpointResultSchema,
  isCheckpointCommandType,
  isDeployCommandType,
} from '@commander/contracts';
import type { AgentControlState, CheckpointCommandBody, CommandResultData, CommandReview, DeployCommandBody } from '@commander/contracts';
import { redactAndCap } from '../common/redact-text.js';
import { reviewForPrompt, CARD_PROMPT_CHARS } from './command-review.js';
import type { CommandRejection } from './control-logic.js';

/**
 * Deploy (6.5) va checkpoint (6.9) buyruqlarining SOF yordamchilari (DB'siz): oldindan rad, ko'rib chiqish talabi, saqlanadigan
 * (redakt qilingan) payload, audit tafsilotlari va natijalarni tekshirish. `CommandsService` shularni chaqiradi.
 */

export type RepoCommandBody = DeployCommandBody | CheckpointCommandBody;
export const isRepoCommandType = (t: string): boolean => isDeployCommandType(t) || isCheckpointCommandType(t);

const STORED_CHARS = 2000;

/** Markaz tomonida oldindan rad (agentd e'lonlari + siyosat bayroqlari). `null` = davom etsin. */
export function precheckRepoCommand(type: string, c: AgentControlState): CommandRejection | null {
  if (isDeployCommandType(type)) {
    if (c.deploy !== true) return { code: 'agent_outdated', message: 'agentd does not support deploy yet (update agentd)' };
    if (type === 'deploy.inspect') return c.allowProjectRead === false ? { code: 'action_not_allowed', message: 'deploy.inspect is not allowed by the local policy (allowProjectRead)' } : null;
    if (c.allowDeploy !== true) return { code: 'action_not_allowed', message: 'Deploy is disabled in the machine\'s local policy (agentd policy allow-deploy)' };
    return null;
  }
  if (isCheckpointCommandType(type)) {
    if (c.checkpoints !== true) return { code: 'agent_outdated', message: 'agentd does not support checkpoints yet (update agentd)' };
    const write = type === 'git.checkpoint' || type === 'git.checkpoint_restore';
    if (write ? c.allowProjectWrite === false : c.allowProjectRead === false) return { code: 'action_not_allowed', message: `${type} is not allowed by the local policy` };
    return null;
  }
  return null;
}

/**
 * Deploy ijrosi uchun ko'rib chiqish: rejadagi xavfli andozalar (preview-safety) VA reja kartaga sig'masa (to'liq ko'rinmasa)
 * Telegram bir-tap tasdiqi berilmaydi: faqat dashboard'da (to'liq ko'rib, `approve` + elevation). `shell:` qadamlari alohida ogohlantiriladi.
 */
export function deployReview(plan: string, notes: readonly string[] = []): CommandReview {
  const base = reviewForPrompt(plan);
  const reasons = [...notes.map((n) => n.slice(0, 300)), ...(base?.reasons ?? [])];
  const tooLong = plan.length > CARD_PROMPT_CHARS;
  if (tooLong) reasons.push(`Deploy rejasi ${plan.length} belgi: Telegram kartasiga sig'maydi, to'liq ko'rish va tasdiq dashboard'da`);
  return { required: (base?.required ?? false) || tooLong, reasons: reasons.slice(0, 16).map((r) => r.slice(0, 300)) };
}

/** Agentga boradigan (imzolanadigan) payload. `root`/`machine` markaz DB'sidan; mijoz bermaydi. */
export function repoSecret(body: RepoCommandBody, root: string, machineSlug: string): { type: string; payload: Record<string, unknown> } {
  switch (body.type) {
    case 'deploy.inspect':
      return { type: 'deploy.inspect', payload: { root, machine: machineSlug, ...(body.commit ? { commit: body.commit } : {}) } };
    case 'deploy.run':
    case 'deploy.rollback':
      return { type: body.type, payload: { root, machine: machineSlug, target: body.target, recipeHash: body.recipeHash, commit: body.commit } };
    case 'git.checkpoint':
      return { type: 'git.checkpoint', payload: { root, label: body.label, ...(body.auto ? { auto: true } : {}) } };
    case 'git.checkpoint_list':
      return { type: 'git.checkpoint_list', payload: { root } };
    case 'git.checkpoint_restore':
      return { type: 'git.checkpoint_restore', payload: { root, ref: body.ref } };
  }
}

/** DB'ga yoziladigan (redakt qilingan) payload: tasdiq kartasi/tarix uchun. */
export function repoStoredPayload(body: RepoCommandBody, cwd: string | null, review?: CommandReview): Record<string, unknown> {
  switch (body.type) {
    case 'deploy.inspect':
      return { projectId: body.projectId, cwd, ...(body.commit ? { commit: body.commit } : {}) };
    case 'deploy.run':
    case 'deploy.rollback': {
      const plan = body.plan ?? '';
      const head = `${body.type === 'deploy.run' ? 'deploy' : 'rollback'} ${body.target} @ ${body.commit.slice(0, 8)} (recipe ${body.recipeHash.slice(0, 8)})`;
      return {
        projectId: body.projectId,
        cwd,
        target: body.target,
        commit: body.commit,
        recipeHash: body.recipeHash,
        promptLength: plan.length,
        promptRedacted: redactAndCap(`${head}\n${plan}`, STORED_CHARS),
        ...(review ? { review } : {}),
      };
    }
    case 'git.checkpoint':
      return { projectId: body.projectId, cwd, label: body.label, ...(body.auto ? { auto: true } : {}), promptLength: body.label.length, promptRedacted: redactAndCap(`checkpoint: ${body.label}${body.auto ? ' (avto)' : ''}`, 300) };
    case 'git.checkpoint_list':
      return { projectId: body.projectId, cwd };
    case 'git.checkpoint_restore':
      return {
        projectId: body.projectId,
        cwd,
        ref: body.ref,
        promptLength: body.ref.length,
        promptRedacted: `Checkpoint'dan qaytarish: ${body.ref.split('/').pop() ?? body.ref}\nIshchi daraxt va indeks checkpoint holatiga qaytariladi; hozirgi holat avval avtomatik saqlanadi (pre-restore).`,
      };
  }
}

/** `command.created` audit tafsilotlari (matn/reja YO'Q: faqat identifikatorlar). */
export function repoAuditDetails(body: RepoCommandBody): Record<string, unknown> {
  switch (body.type) {
    case 'deploy.inspect':
      return { commit: body.commit ?? null };
    case 'deploy.run':
    case 'deploy.rollback':
      return { target: body.target, commit: body.commit, recipe_hash: body.recipeHash, plan_length: body.plan?.length ?? 0 };
    case 'git.checkpoint':
      return { label: body.label.slice(0, 80), auto: body.auto === true };
    case 'git.checkpoint_list':
      return {};
    case 'git.checkpoint_restore':
      return { ref: body.ref };
  }
}

export interface RepoResultOutcome {
  /** `commands.result` ga yoziladigan SANITIZED qiymat. */
  result?: CommandResultData;
  /** Xotirada saqlanadigan to'liq natija (REST so'rovi olib ketadi). */
  transient?: unknown;
  error?: { code: string; message: string };
}

const invalid = (message: string): RepoResultOutcome => ({ error: { code: 'invalid_result', message } });

/**
 * Agent natijasini tekshiradi (`handleResult` ichida, HAR holat uchun). DB'ga hech qachon xom `unknown` tushmaydi:
 *  - `deploy.inspect`: sxema bo'yicha tekshiriladi, xotirada; DB'da faqat `detail`;
 *  - `deploy.run|rollback`: xulosa (nomlar/holatlar) sxema bo'yicha tekshiriladi va `commands.result.deploy`ga yoziladi (muvaffaqiyatsiz bo'lsa ham);
 *  - `git.checkpoint*`: sxema bo'yicha tekshiriladi, xotirada; DB'da faqat `detail`.
 */
export function sanitizeRepoResult(type: string, state: 'done' | 'failed' | 'rejected', data: CommandResultData | undefined): RepoResultOutcome {
  const detail = typeof data?.detail === 'string' ? redactAndCap(data.detail, 200) : undefined;
  if (type === 'deploy.run' || type === 'deploy.rollback') {
    const parsed = DeploySummarySchema.safeParse(data?.deploy);
    if (parsed.success) return { result: { ...(detail ? { detail } : {}), deploy: parsed.data } };
    return state === 'done' ? invalid('The agent returned an invalid deploy summary') : { result: detail ? { detail } : {} };
  }
  if (state !== 'done') return { result: detail ? { detail } : {} };
  if (type === 'deploy.inspect') {
    const parsed = DeployInspectResultSchema.safeParse(data?.deploy);
    if (!parsed.success) return invalid('The agent returned an invalid deploy inspection');
    return { result: { detail: `${parsed.data.valid ? 'valid' : 'invalid'} recipe @ ${parsed.data.commit.slice(0, 8)}` }, transient: parsed.data };
  }
  if (type === 'git.checkpoint') {
    const parsed = CheckpointResultSchema.safeParse(data?.checkpoint);
    return parsed.success ? { result: detail ? { detail } : {}, transient: parsed.data } : invalid('The agent returned an invalid checkpoint');
  }
  if (type === 'git.checkpoint_list') {
    const parsed = CheckpointListResultSchema.safeParse(data?.checkpoint);
    return parsed.success ? { result: { detail: `${parsed.data.items.length} checkpoints` }, transient: parsed.data } : invalid('The agent returned an invalid checkpoint list');
  }
  if (type === 'git.checkpoint_restore') {
    const parsed = CheckpointRestoreResultSchema.safeParse(data?.checkpoint);
    return parsed.success ? { result: detail ? { detail } : {}, transient: parsed.data } : invalid('The agent returned an invalid restore result');
  }
  return {};
}

