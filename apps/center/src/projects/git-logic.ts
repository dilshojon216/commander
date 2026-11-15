import type { DiffResponse } from '@commander/contracts';

/**
 * Sessiya diff'i bazasi (sof): `SessionStart`da saqlangan HEAD (aniq) > shu paytga eng yaqin snapshot HEAD'i (taxminiy) >
 * HEAD (ishchi daraxt o'zgarishlari, taxminan "hozirgi sessiya"ning ulushi emas).
 */
export function resolveSessionBase(i: { startHeadSha: string | null; snapshotHeadSha: string | null }): { base: string; source: DiffResponse['baseSource'] } {
  if (i.startHeadSha) return { base: i.startHeadSha, source: 'session_start' };
  if (i.snapshotHeadSha) return { base: i.snapshotHeadSha, source: 'snapshot' };
  return { base: 'HEAD', source: 'head' };
}

/** CI so'rovi kaliti (5 daqiqalik chelak): takroriy poll bir xil buyruqni yaratmasin (Idempotency-Key). */
export function ciPollKey(projectId: string, branch: string, now: number, windowMs: number): string {
  const bucket = Math.floor(now / windowMs);
  return `ci-${projectId.slice(0, 8)}-${bucket}-${branch.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 60)}`;
}

/** `Idempotency-Key` sxemasiga mos (8-128 belgi) ekanini kafolatlaydi. */
export const isValidKey = (k: string): boolean => /^[A-Za-z0-9_.:-]{8,128}$/.test(k);

/** Git buyruqi xato kodi -> HTTP holati (diff REST'i sinxron kutadi). */
export function gitHttpStatus(code: string | null): number {
  switch (code) {
    case 'lockdown':
    case 'policy_disabled':
    case 'action_not_allowed':
    case 'cwd_not_allowed':
    case 'center_key_unpinned':
    case 'running_as_root':
      return 403;
    case 'machine_offline':
    case 'agent_outdated':
    case 'not_a_git_repo':
    case 'gh_unavailable':
    case 'gh_unauthenticated':
    case 'no_remote':
    case 'dirty_worktree':
    case 'on_default_branch':
    case 'nothing_to_pr':
      return 409;
    case 'base_invalid':
      return 422;
    case 'agent_timeout':
    case 'dispatch_expired':
      return 504;
    default:
      return 502;
  }
}
