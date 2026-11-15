import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PolicySchema, decidePolicy, loadPolicy, runPolicyCli } from './policy.js';

let dir: string;
let root: string;
let outside: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'cmdr-policy-dp-'));
  root = path.join(dir, 'allowed');
  outside = path.join(dir, 'outside');
  mkdirSync(path.join(root, 'proj'), { recursive: true });
  mkdirSync(outside);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const enabled = (extra: Record<string, unknown> = {}) => PolicySchema.parse({ remote: { enabled: true, allowedRoots: [root], ...extra } });
const proj = (): string => path.join(root, 'proj');

describe('policy: deploy (6.5) va checkpoint (6.9)', () => {
  it('DEFAULT: allowDeploy va allowDeployShell O\'CHIQ', () => {
    const p = enabled();
    expect(p.remote.allowDeploy).toBe(false);
    expect(p.remote.allowDeployShell).toBe(false);
    expect(PolicySchema.parse({}).remote.allowDeploy).toBe(false);
  });

  it('deploy.run/rollback: allowDeploy kerak; inspect faqat allowProjectRead; ildiz ichida bo\'lishi shart', () => {
    for (const type of ['deploy.run', 'deploy.rollback'] as const) {
      expect(decidePolicy({ type, policy: enabled(), runningAsRoot: false, cwd: proj() })).toMatchObject({ ok: false, code: 'action_not_allowed' });
      expect(decidePolicy({ type, policy: enabled({ allowDeploy: true }), runningAsRoot: false, cwd: proj() })).toMatchObject({ ok: true });
      expect(decidePolicy({ type, policy: enabled({ allowDeploy: true }), runningAsRoot: false, cwd: outside })).toMatchObject({ ok: false, code: 'cwd_not_allowed' });
    }
    expect(decidePolicy({ type: 'deploy.inspect', policy: enabled(), runningAsRoot: false, cwd: proj() })).toMatchObject({ ok: true });
    expect(decidePolicy({ type: 'deploy.inspect', policy: enabled({ allowProjectRead: false }), runningAsRoot: false, cwd: proj() })).toMatchObject({ ok: false, code: 'action_not_allowed' });
    expect(decidePolicy({ type: 'deploy.inspect', policy: enabled(), runningAsRoot: false, cwd: outside })).toMatchObject({ ok: false, code: 'cwd_not_allowed' });
  });

  it('checkpoint: create/restore allowProjectWrite, list allowProjectRead; ildiz tashqarisi va maxfiy papka rad', () => {
    expect(decidePolicy({ type: 'git.checkpoint', policy: enabled(), runningAsRoot: false, cwd: proj() })).toMatchObject({ ok: true });
    expect(decidePolicy({ type: 'git.checkpoint', policy: enabled({ allowProjectWrite: false }), runningAsRoot: false, cwd: proj() })).toMatchObject({ ok: false, code: 'action_not_allowed' });
    expect(decidePolicy({ type: 'git.checkpoint_restore', policy: enabled({ allowProjectWrite: false }), runningAsRoot: false, cwd: proj() })).toMatchObject({ ok: false, code: 'action_not_allowed' });
    expect(decidePolicy({ type: 'git.checkpoint_list', policy: enabled({ allowProjectWrite: false }), runningAsRoot: false, cwd: proj() })).toMatchObject({ ok: true });
    expect(decidePolicy({ type: 'git.checkpoint_list', policy: enabled(), runningAsRoot: false, cwd: outside })).toMatchObject({ ok: false, code: 'cwd_not_allowed' });
    expect(decidePolicy({ type: 'git.checkpoint', policy: enabled(), runningAsRoot: false, cwd: proj(), sensitive: [proj()] })).toMatchObject({ ok: false, code: 'cwd_not_allowed' });
  });

  it('root bilan ishlayotgan agentd va o\'chiq siyosat: deploy ham rad (running_as_root / policy_disabled)', () => {
    expect(decidePolicy({ type: 'deploy.run', policy: enabled({ allowDeploy: true }), runningAsRoot: true, cwd: proj() })).toMatchObject({ ok: false, code: 'running_as_root' });
    expect(decidePolicy({ type: 'deploy.run', policy: PolicySchema.parse({ remote: { allowDeploy: true, allowedRoots: [root] } }), runningAsRoot: false, cwd: proj() })).toMatchObject({ ok: false, code: 'policy_disabled' });
  });

  it('CLI: allow-deploy / allow-deploy-shell / deny-deploy (deny shell ham o\'chiradi) / deny-deploy-shell; show chiqaradi', () => {
    const paths = { home: dir, policyFile: path.join(dir, 'policy.json') };
    const out: string[] = [];
    const err: string[] = [];
    const run = (...a: string[]): number => runPolicyCli(paths as never, a, (s) => out.push(s), (s) => err.push(s));
    expect(run('enable')).toBe(0);
    expect(run('allow-deploy')).toBe(0);
    expect(loadPolicy(paths as never).policy.remote).toMatchObject({ allowDeploy: true, allowDeployShell: false });
    expect(run('allow-deploy-shell')).toBe(0);
    expect(loadPolicy(paths as never).policy.remote).toMatchObject({ allowDeploy: true, allowDeployShell: true });
    expect(run('deny-deploy-shell')).toBe(0);
    expect(loadPolicy(paths as never).policy.remote.allowDeployShell).toBe(false);
    expect(run('allow-deploy-shell')).toBe(0);
    expect(run('deny-deploy')).toBe(0);
    expect(loadPolicy(paths as never).policy.remote).toMatchObject({ allowDeploy: false, allowDeployShell: false });
    out.length = 0;
    expect(run('show')).toBe(0);
    expect(out.join('')).toContain('remote.allowDeploy:');
    expect(err).toEqual([]);
  });
});
