import { describe, expect, it } from 'vitest';
import { COMMAND_TYPES, CommandDispatchPayloadSchema, canonicalJson } from './commands.js';
import { DEPLOY_COMMAND_TYPES, DeployExecPayloadSchema, DeployInspectPayloadSchema, DeploySummarySchema, RECIPE_HASH_RE, TARGET_NAME_RE, describeStep, describeTargetPlan, isDeployCommandType, isDeployExecType } from './deploy.js';
import type { DeployTarget } from './deploy.js';
import { CHECKPOINT_COMMAND_TYPES, CHECKPOINT_REF_PREFIX, checkpointSlug, checkpointStamp, isCheckpointCommandType, isCheckpointRef, CheckpointPayloadSchema, CheckpointRestorePayloadSchema } from './checkpoints.js';

const SHA = 'a'.repeat(40);
const HASH = 'b'.repeat(64);

describe('deploy contracts', () => {
  it('buyruq turlari COMMAND_TYPES ichida; ijro turlari aniq ajratilgan', () => {
    for (const t of [...DEPLOY_COMMAND_TYPES, ...CHECKPOINT_COMMAND_TYPES]) expect(COMMAND_TYPES).toContain(t);
    expect(isDeployCommandType('deploy.run')).toBe(true);
    expect(isDeployCommandType('project.diff')).toBe(false);
    expect(isDeployExecType('deploy.inspect')).toBe(false);
    expect(isDeployExecType('deploy.rollback')).toBe(true);
    expect(isCheckpointCommandType('git.checkpoint_restore')).toBe(true);
  });

  it('payload sxemalari qat\'iy: ortiqcha kalit, yaroqsiz xesh/sha/maqsad nomi rad', () => {
    const ok = { root: '/r', machine: 'ubuntu-1', target: 'prod', recipeHash: HASH, commit: SHA };
    expect(DeployExecPayloadSchema.safeParse(ok).success).toBe(true);
    expect(DeployExecPayloadSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    expect(DeployExecPayloadSchema.safeParse({ ...ok, recipeHash: 'x' }).success).toBe(false);
    expect(DeployExecPayloadSchema.safeParse({ ...ok, commit: '--upload-pack=x' }).success).toBe(false);
    expect(DeployExecPayloadSchema.safeParse({ ...ok, target: 'Prod' }).success).toBe(false);
    expect(DeployExecPayloadSchema.safeParse({ ...ok, machine: 'a b' }).success).toBe(false);
    expect(DeployInspectPayloadSchema.safeParse({ root: '/r', machine: 'm' }).success).toBe(true);
    expect(DeployInspectPayloadSchema.safeParse({ root: '/r', machine: 'm', commit: 'HEAD' }).success).toBe(false);
    expect(TARGET_NAME_RE.test('prod-1')).toBe(true);
    expect(RECIPE_HASH_RE.test(HASH)).toBe(true);
  });

  it('dispatch union: deploy/checkpoint buyruqlari payload bilan tekshiriladi', () => {
    const base = { commandId: '11111111-1111-4222-8333-444455556666', nonce: 'A'.repeat(43), expiresAt: Date.now() + 1000, sig: 'B'.repeat(86) };
    expect(CommandDispatchPayloadSchema.safeParse({ ...base, type: 'deploy.run', payload: { root: '/r', machine: 'm', target: 'prod', recipeHash: HASH, commit: SHA } }).success).toBe(true);
    expect(CommandDispatchPayloadSchema.safeParse({ ...base, type: 'deploy.run', payload: { root: '/r' } }).success).toBe(false);
    expect(CommandDispatchPayloadSchema.safeParse({ ...base, type: 'git.checkpoint_restore', payload: { root: '/r', ref: `${CHECKPOINT_REF_PREFIX}20261114T100000Z-x` } }).success).toBe(true);
    expect(CommandDispatchPayloadSchema.safeParse({ ...base, type: 'git.checkpoint_restore', payload: { root: '/r', ref: 'refs/heads/main' } }).success).toBe(false);
  });

  it('xulosa sxemasi: chiqish matni uchun joy yo\'q; sxemaga mos kelmagan to\'ldirish rad', () => {
    const ok = { kind: 'run', target: 'prod', commit: SHA, recipeHash: HASH, outcome: 'success', failedPhase: null, failedStep: null, steps: [{ phase: 'steps', name: 'build', status: 'ok', exitCode: 0, durationMs: 5 }], health: { ok: true, attempts: 1, lastStatus: 200 }, rollbackDefined: true, durationMs: 10, outputTruncated: false };
    expect(DeploySummarySchema.safeParse(ok).success).toBe(true);
    expect(DeploySummarySchema.safeParse({ ...ok, outcome: 'weird' }).success).toBe(false);
    expect(DeploySummarySchema.safeParse({ ...ok, steps: Array(121).fill(ok.steps[0]) }).success).toBe(false);
  });

  it('reja matni: har qadam argv (JSON qochirish bilan) va shell alohida; rollback rejimi', () => {
    const step = (name: string, argv: string[], shell: string | null = null) => ({ name, kind: shell ? ('shell' as const) : ('argv' as const), argv, shell, cwd: null, env: {}, timeoutSec: 60 });
    const t: DeployTarget = {
      name: 'prod',
      machine: 'm',
      cwd: '.',
      timeoutSec: 60,
      preflight: [step('tests', ['npm', 'test'])],
      steps: [step('build', ['npm', 'run', 'build', 'a b']), step('x', [], 'make && make install')],
      health: { kind: 'http', url: 'http://127.0.0.1:3000/h', argv: [], expectStatus: [200], timeoutSec: 5, retries: 2, intervalSec: 3 },
      rollback: [step('undo', ['./undo.sh'])],
      usesShell: true,
    };
    expect(describeStep(t.steps[0]!)).toBe('npm run build "a b"');
    expect(describeStep(t.steps[1]!)).toBe('sh -c "make && make install"');
    const run = describeTargetPlan(t, 'run');
    expect(run).toContain('preflight:\n  1. tests: npm test');
    expect(run).toContain('health: GET http://127.0.0.1:3000/h (x3, 3s)');
    expect(run).toContain('rollback:\n  1. undo: ./undo.sh');
    const rb = describeTargetPlan(t, 'rollback');
    expect(rb).not.toContain('steps:');
    expect(rb.indexOf('rollback:')).toBeLessThan(rb.indexOf('health:'));
  });
});

describe('checkpoint contracts', () => {
  it('ref regex: faqat refs/commander/checkpoints/<ts>-<slug>; inyeksiya/yo\'l chiqishi rad', () => {
    const good = `${CHECKPOINT_REF_PREFIX}20261114T101500Z-before-big-task`;
    expect(isCheckpointRef(good)).toBe(true);
    for (const bad of [
      'refs/heads/main',
      `${CHECKPOINT_REF_PREFIX}../heads/main`,
      `${CHECKPOINT_REF_PREFIX}20261114T101500Z-x/../../heads/main`,
      `${CHECKPOINT_REF_PREFIX}20261114T101500Z-`,
      `${CHECKPOINT_REF_PREFIX}20261114T101500Z--rf`,
      `${CHECKPOINT_REF_PREFIX}20261114T101500Z-X`,
      `${good} --force`,
      `${good}\n`,
      '-d',
      '',
    ]) expect(isCheckpointRef(bad), bad).toBe(false);
  });

  it('slug va stamp: tozalash, uzunlik, bo\'sh -> checkpoint; UTC', () => {
    expect(checkpointSlug('Before BIG task!')).toBe('before-big-task');
    expect(checkpointSlug('  ../../x  ')).toBe('x');
    expect(checkpointSlug('!!!')).toBe('checkpoint');
    expect(checkpointSlug('a'.repeat(100))).toHaveLength(48);
    expect(checkpointStamp(new Date(Date.UTC(2026, 10, 14, 9, 5, 7)))).toBe('20261114T090507Z');
    expect(isCheckpointRef(`${CHECKPOINT_REF_PREFIX}${checkpointStamp(new Date())}-${checkpointSlug('Hello World')}`)).toBe(true);
  });

  it('payload sxemalari', () => {
    expect(CheckpointPayloadSchema.safeParse({ root: '/r', label: 'before task' }).success).toBe(true);
    expect(CheckpointPayloadSchema.safeParse({ root: '/r', label: '--evil' }).success).toBe(false);
    expect(CheckpointPayloadSchema.safeParse({ root: '/r', label: 'a\nb' }).success).toBe(false);
    expect(CheckpointRestorePayloadSchema.safeParse({ root: '/r', ref: 'HEAD' }).success).toBe(false);
  });

  it('canonicalJson barqaror (imzo xeshi uchun)', () => {
    expect(canonicalJson({ b: 1, a: [1, { d: 1, c: 2 }] })).toBe('{"a":[1,{"c":2,"d":1}],"b":1}');
  });
});
