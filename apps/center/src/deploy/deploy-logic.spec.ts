import { describe, expect, it } from 'vitest';
import type { DeployInspectResult, DeployTarget } from '@commander/contracts';
import { inspectNotes, isFailedStatus, repoHttpStatus, toRunDto } from './deploy-logic.js';

const SHA = 'a'.repeat(40);
const HASH = 'b'.repeat(64);

describe('repoHttpStatus', () => {
  it('xato kodi -> HTTP', () => {
    expect(repoHttpStatus('action_not_allowed')).toBe(403);
    expect(repoHttpStatus('shell_not_allowed')).toBe(403);
    expect(repoHttpStatus('commit_changed')).toBe(409);
    expect(repoHttpStatus('recipe_changed')).toBe(409);
    expect(repoHttpStatus('deploy_busy')).toBe(409);
    expect(repoHttpStatus('recipe_missing')).toBe(404);
    expect(repoHttpStatus('checkpoint_not_found')).toBe(404);
    expect(repoHttpStatus('recipe_invalid')).toBe(422);
    expect(repoHttpStatus('agent_timeout')).toBe(504);
    expect(repoHttpStatus('weird')).toBe(502);
    expect(repoHttpStatus(null)).toBe(502);
  });
  it('isFailedStatus', () => {
    expect(['rejected', 'failed', 'expired'].every(isFailedStatus)).toBe(true);
    expect(['done', 'running', 'awaiting_confirmation'].some(isFailedStatus)).toBe(false);
  });
});

describe('toRunDto', () => {
  const row = (result: unknown) => ({ id: '11111111-1111-4222-8333-444455556666', type: 'deploy.rollback', status: 'done', payload: { target: 'prod', commit: SHA, recipeHash: HASH }, result: result as { deploy?: unknown } | null, error_code: null, error_message: null, requested_by_device_id: '22222222-1111-4222-8333-444455556666', created_at: new Date('2026-11-14T10:00:00Z'), finished_at: null });
  it('turi, maqsad, commit, xesh; xulosa sxema bo\'yicha qayta tekshiriladi (yaroqsiz = null)', () => {
    const ok = { kind: 'rollback', target: 'prod', commit: SHA, recipeHash: HASH, outcome: 'rolled_back', failedPhase: null, failedStep: null, steps: [], health: null, rollbackDefined: true, durationMs: 1, outputTruncated: false };
    expect(toRunDto(row({ deploy: ok }))).toMatchObject({ kind: 'rollback', target: 'prod', commit: SHA, recipeHash: HASH, summary: { outcome: 'rolled_back' }, finishedAt: null });
    expect(toRunDto(row({ deploy: { evil: 1 } })).summary).toBeNull();
    expect(toRunDto(row(null)).summary).toBeNull();
  });
});

describe('inspectNotes', () => {
  it('shell, iflos daraxt, ishchi daraxtdagi retsept farqi ogohlantiriladi', () => {
    const i = { dirty: true, workingTreeDiffers: true } as DeployInspectResult;
    const t = { usesShell: true } as DeployTarget;
    const n = inspectNotes(i, t).join(' ');
    expect(n).toMatch(/shell/);
    expect(n).toMatch(/commit qilinmagan/);
    expect(n).toMatch(/faqat commit/);
    expect(inspectNotes({ dirty: false, workingTreeDiffers: false } as DeployInspectResult, { usesShell: false } as DeployTarget)).toEqual([]);
  });
});
