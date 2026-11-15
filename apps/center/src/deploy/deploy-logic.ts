import { DeploySummarySchema, describeTargetPlan } from '@commander/contracts';
import type { CommandDto, DeployInspectResult, DeployRunDto, DeployTarget } from '@commander/contracts';

/** Agent/markaz xato kodi -> HTTP holati (deploy va checkpoint REST'lari). Sof. */
export function repoHttpStatus(code: string | null): number {
  switch (code) {
    case 'lockdown':
    case 'policy_disabled':
    case 'action_not_allowed':
    case 'cwd_not_allowed':
    case 'center_key_unpinned':
    case 'running_as_root':
    case 'shell_not_allowed':
      return 403;
    case 'machine_offline':
    case 'agent_outdated':
    case 'not_a_git_repo':
    case 'dirty_worktree':
    case 'commit_changed':
    case 'recipe_changed':
    case 'deploy_busy':
    case 'machine_mismatch':
    case 'branch_changed':
    case 'head_diverged':
    case 'no_commits':
      return 409;
    case 'target_not_found':
    case 'recipe_missing':
    case 'checkpoint_not_found':
    case 'project_not_found':
      return 404;
    case 'recipe_invalid':
    case 'invalid_payload':
      return 422;
    case 'agent_timeout':
    case 'dispatch_expired':
      return 504;
    default:
      return 502;
  }
}

/** Egasi tasdiqlaydigan reja: maqsad bo'yicha har qadam buyrug'i (redakt qilinmagan; saqlashda center redakt qiladi). */
export function planFor(target: DeployTarget, kind: 'run' | 'rollback', commit: string, recipeHash: string): string {
  void commit;
  void recipeHash;
  return describeTargetPlan(target, kind);
}

/** Inspect natijasidan egasiga ko'rsatiladigan ogohlantirishlar (tasdiq kartasi/`review` uchun). Sof. */
export function inspectNotes(i: DeployInspectResult, target: DeployTarget): string[] {
  const notes: string[] = [];
  if (target.usesShell) notes.push("⚠ Retsept shell qadamlaridan foydalanadi (sh -c / bash -c): mashinada allowDeployShell kerak");
  if (i.dirty) notes.push('⚠ Ishchi daraxtda commit qilinmagan o\'zgarishlar bor (deploy rad etiladi)');
  if (i.workingTreeDiffers) notes.push('⚠ Ishchi daraxtdagi retsept commit\'dagidan farq qiladi: faqat commit qilingani ishlatiladi');
  return notes;
}

interface RunRow {
  id: string;
  type: string;
  status: string;
  payload: Record<string, unknown>;
  result: { deploy?: unknown } | null;
  error_code: string | null;
  error_message: string | null;
  requested_by_device_id: string;
  created_at: Date;
  finished_at: Date | null;
}

const s = (v: unknown): string => (typeof v === 'string' ? v : '');

/** `commands` qatori -> tarix qatori. Xulosa sxema bo'yicha qayta tekshiriladi (yaroqsiz bo'lsa `null`). Sof. */
export function toRunDto(r: RunRow): DeployRunDto {
  const parsed = DeploySummarySchema.safeParse(r.result?.deploy);
  return {
    commandId: r.id,
    kind: r.type === 'deploy.rollback' ? 'rollback' : 'run',
    target: s(r.payload['target']),
    commit: s(r.payload['commit']),
    recipeHash: s(r.payload['recipeHash']),
    status: r.status,
    errorCode: r.error_code,
    errorMessage: r.error_message,
    summary: parsed.success ? parsed.data : null,
    requestedByDeviceId: r.requested_by_device_id,
    createdAt: r.created_at.toISOString(),
    finishedAt: r.finished_at ? r.finished_at.toISOString() : null,
  };
}

/** Buyruq muvaffaqiyatsiz tugadimi (rejected/failed/expired). */
export const isFailedStatus = (st: string): boolean => st === 'rejected' || st === 'failed' || st === 'expired';
export const isFinalStatus = (c: Pick<CommandDto, 'status'>): boolean => ['done', 'failed', 'expired', 'rejected'].includes(c.status);
