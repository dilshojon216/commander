import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DeployExecPayload, DeployInspectResult, DeploySummary, LogsChunkPayload } from '@commander/contracts';
import { DeployOps, OutputSink } from './deploy-ops.js';
import type { DeployProc } from './deploy-ops.js';
import { parseRecipe } from './deploy-recipe.js';
import type { GitRunner } from './git-info.js';
import type { Logger } from './logger.js';
import { PolicySchema } from './policy.js';
import type { Policy } from './policy.js';

const log: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => log };
const COMMIT = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

const RECIPE = `version: 1
targets:
  prod:
    machine: ubuntu-1
    cwd: .
    preflight:
      - { name: tests, run: [npm, test] }
    steps:
      - name: build
        run: [npm, run, build]
        env: { APP_COMMIT: "{{commit}}", APP_MODE: prod }
      - name: restart
        run: [systemctl-user, restart, app]
    health:
      url: http://127.0.0.1:3000/health
      retries: 3
      interval: 1
    rollback:
      - name: undo
        run: [./scripts/rollback.sh, "{{short_commit}}"]
`;

interface ProcScript {
  stdout?: string;
  stderr?: string;
  code?: number | null;
  /** hech qachon tugamaydi (kill kutadi) */
  hang?: boolean;
  error?: string;
}

describe('DeployOps (soxta git/jarayon/http)', () => {
  let root = '';
  const sent: LogsChunkPayload[] = [];
  const spawned: Array<{ bin: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }> = [];
  let killed = 0;
  let scripts: Array<(args: string[]) => ProcScript | undefined> = [];
  let httpSeq: Array<number | null> = [];
  const sleeps: number[] = [];

  const gitState = { head: COMMIT, dirty: false, recipe: RECIPE as string | null };
  const git: GitRunner = async (_cwd, args) => {
    const a = [...args];
    if (a[0] === 'rev-parse') {
      const spec = a[a.length - 1]!;
      if (spec === 'HEAD^{commit}') return `${gitState.head}\n`;
      const m = /^([0-9a-f]+)\^\{commit\}$/.exec(spec);
      if (m && (m[1] === COMMIT || m[1] === OTHER || m[1] === gitState.head)) return `${m[1]!.padEnd(40, m[1]![0]!)}\n`;
      throw new Error('bad rev');
    }
    if (a[0] === 'status') return gitState.dirty ? '1 .M N... x\0' : '';
    if (a[0] === 'cat-file' && a[1] === '-s') {
      if (gitState.recipe === null) throw new Error('missing');
      return `${Buffer.byteLength(gitState.recipe)}\n`;
    }
    if (a[0] === 'cat-file' && a[1] === 'blob') {
      if (gitState.recipe === null) throw new Error('missing');
      return gitState.recipe;
    }
    throw new Error(`unexpected git ${a.join(' ')}`);
  };

  const policy = (over: Partial<Policy['remote']> = {}): Policy => PolicySchema.parse({ remote: { enabled: true, allowedRoots: [root], allowDeploy: true, ...over } });
  const mk = (over: Partial<Policy['remote']> = {}, extra: { flushMs?: number } = {}): DeployOps =>
    new DeployOps({
      log,
      send: (p) => {
        sent.push(p);
        return true;
      },
      policy: () => policy(over).remote && policy(over),
      git,
      resolveBin: (name) => `/usr/bin/${name}`,
      env: { PATH: '/usr/bin', HOME: '/home/u', COMMANDER_TOKEN: 'secret-token', AGENTD_X: '1', KEEP_ME: 'yes' },
      sleep: async (ms) => void sleeps.push(ms),
      httpGet: async () => (httpSeq.length > 0 ? (httpSeq.shift() as number | null) : null),
      flushMs: extra.flushMs ?? 5,
      spawn: (bin, args, o): DeployProc => {
        spawned.push({ bin, args, cwd: o.cwd, env: o.env });
        const script = scripts.map((f) => f(args)).find((x) => x !== undefined) ?? { code: 0 };
        let outCb: (c: Buffer) => void = () => undefined;
        let errCb: (c: Buffer) => void = () => undefined;
        let exitCb: (c: number | null, e?: string) => void = () => undefined;
        queueMicrotask(() =>
          setTimeout(() => {
            if (script.stdout) outCb(Buffer.from(script.stdout));
            if (script.stderr) errCb(Buffer.from(script.stderr));
            if (script.error) return exitCb(null, script.error);
            if (!script.hang) exitCb(script.code ?? 0);
          }, 0),
        );
        return {
          onStdout: (cb) => void (outCb = cb),
          onStderr: (cb) => void (errCb = cb),
          onExit: (cb) => void (exitCb = cb),
          kill: () => {
            killed++;
            setTimeout(() => exitCb(null), 0);
          },
        };
      },
    });

  const payload = (over: Partial<DeployExecPayload> = {}): DeployExecPayload => ({ root, machine: 'ubuntu-1', target: 'prod', recipeHash: parseRecipe(RECIPE).recipeHash!, commit: COMMIT, ...over });
  const lines = (): string[] => sent.flatMap((c) => c.lines);
  const deploy = (r: { result?: { deploy?: unknown } }): DeploySummary => r.result!.deploy as DeploySummary;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'cmdr-deploy-')));
    sent.length = 0;
    spawned.length = 0;
    sleeps.length = 0;
    killed = 0;
    scripts = [];
    httpSeq = [200];
    Object.assign(gitState, { head: COMMIT, dirty: false, recipe: RECIPE });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  describe('inspect', () => {
    it('retsept pin qilingan commit\'dan: normallashtirilgan + xesh + machineMatches + siyosat bayroqlari', async () => {
      const r = await mk().inspect({ root, machine: 'ubuntu-1' }, root);
      expect(r.ok).toBe(true);
      const i = (r.result as { deploy: DeployInspectResult }).deploy;
      expect(i).toMatchObject({ commit: COMMIT, recipePresent: true, valid: true, dirty: false, usesShell: false, machineMatches: { prod: true }, allowDeploy: true, allowDeployShell: false });
      expect(i.recipeHash).toBe(parseRecipe(RECIPE).recipeHash);
      expect(i.recipe?.targets[0]?.steps.map((s) => s.name)).toEqual(['build', 'restart']);
      const other = await mk().inspect({ root, machine: 'other' }, root);
      expect((other.result as { deploy: DeployInspectResult }).deploy.machineMatches).toEqual({ prod: false });
    });

    it('retsept yo\'q / yaroqsiz / dirty / aniq commit', async () => {
      gitState.recipe = null;
      const miss = (await mk().inspect({ root, machine: 'm' }, root)).result as { deploy: DeployInspectResult };
      expect(miss.deploy).toMatchObject({ recipePresent: false, valid: false, recipe: null, recipeHash: null });
      expect(miss.deploy.issues[0]).toMatch(/not found/);
      gitState.recipe = 'version: 1\ntargets:\n  prod:\n    machine: m\n    steps: "x"\n';
      gitState.dirty = true;
      const bad = (await mk().inspect({ root, machine: 'm' }, root)).result as { deploy: DeployInspectResult };
      expect(bad.deploy).toMatchObject({ recipePresent: true, valid: false, dirty: true });
      expect(bad.deploy.issues.length).toBeGreaterThan(0);
      const pinned = await mk().inspect({ root, machine: 'm', commit: OTHER }, root);
      expect((pinned.result as { deploy: DeployInspectResult }).deploy.commit).toBe(OTHER);
      expect(await mk().inspect({ root, machine: 'm', commit: 'zzz' as string }, root)).toMatchObject({ ok: false });
    });
  });

  describe('execute: pin / TOCTOU / siyosat', () => {
    it('HEAD ko\'chgan -> commit_changed (hech narsa ishga tushmaydi)', async () => {
      gitState.head = OTHER;
      expect(await mk().execute('c1', 'run', payload(), root)).toMatchObject({ ok: false, code: 'commit_changed' });
      expect(spawned).toHaveLength(0);
    });

    it('xesh o\'zgargan (retsept yangilangan) -> recipe_changed', async () => {
      gitState.recipe = RECIPE.replace('npm, run, build', 'npm, run, build-evil');
      expect(await mk().execute('c1', 'run', payload(), root)).toMatchObject({ ok: false, code: 'recipe_changed' });
      expect(spawned).toHaveLength(0);
    });

    it('iflos daraxt, retsept yo\'q, yaroqsiz retsept, maqsad yo\'q, mashina mos emas', async () => {
      gitState.dirty = true;
      expect(await mk().execute('c1', 'run', payload(), root)).toMatchObject({ ok: false, code: 'dirty_worktree' });
      gitState.dirty = false;
      gitState.recipe = null;
      expect(await mk().execute('c1', 'run', payload(), root)).toMatchObject({ ok: false, code: 'recipe_missing' });
      gitState.recipe = 'nope: [';
      expect(await mk().execute('c1', 'run', payload(), root)).toMatchObject({ ok: false, code: 'recipe_invalid' });
      gitState.recipe = RECIPE;
      expect(await mk().execute('c1', 'run', payload({ target: 'staging' }), root)).toMatchObject({ ok: false, code: 'target_not_found' });
      expect(await mk().execute('c1', 'run', payload({ machine: 'ubuntu-2' }), root)).toMatchObject({ ok: false, code: 'machine_mismatch' });
      expect(spawned).toHaveLength(0);
    });

    it('allowDeploy o\'chiq -> action_not_allowed; shell qadam + allowDeployShell o\'chiq -> shell_not_allowed', async () => {
      expect(await mk({ allowDeploy: false }).execute('c1', 'run', payload(), root)).toMatchObject({ ok: false, code: 'action_not_allowed' });
      const shellRecipe = RECIPE.replace('run: [npm, run, build]', 'shell: "npm ci && npm run build"');
      gitState.recipe = shellRecipe;
      const p = payload({ recipeHash: parseRecipe(shellRecipe).recipeHash! });
      expect(await mk().execute('c1', 'run', p, root)).toMatchObject({ ok: false, code: 'shell_not_allowed' });
      expect(spawned).toHaveLength(0);
      const ok = await mk({ allowDeployShell: true }).execute('c1', 'run', p, root);
      expect(ok.ok).toBe(true);
      expect(spawned.some((s) => s.bin === '/bin/sh' && s.args[0] === '-c' && s.args[1] === 'npm ci && npm run build')).toBe(true);
    });

    it('target cwd siyosat ildizidan tashqarida (mutlaq) -> cwd_not_allowed; ichida -> ok', async () => {
      const outside = realpathSync(mkdtempSync(join(tmpdir(), 'cmdr-outside-')));
      try {
        const r1 = RECIPE.replace('cwd: .', `cwd: ${outside}`);
        gitState.recipe = r1;
        expect(await mk().execute('c1', 'run', payload({ recipeHash: parseRecipe(r1).recipeHash! }), root)).toMatchObject({ ok: false, code: 'cwd_not_allowed' });
        const r2 = RECIPE.replace('cwd: .', `cwd: ${root}`);
        gitState.recipe = r2;
        expect((await mk().execute('c1', 'run', payload({ recipeHash: parseRecipe(r2).recipeHash! }), root)).ok).toBe(true);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it('bir vaqtda bir maqsad: ikkinchi chaqiruv deploy_busy', async () => {
      scripts = [(a) => (a[0] === 'run' && a[1] === 'build' ? { code: 0 } : undefined)];
      const ops = mk();
      const first = ops.execute('c1', 'run', payload(), root);
      const second = await ops.execute('c2', 'run', payload(), root);
      expect(second).toMatchObject({ ok: false, code: 'deploy_busy' });
      expect((await first).ok).toBe(true);
    });
  });

  describe('execute: bajarish', () => {
    it('muvaffaqiyat: preflight -> steps -> health (qayta urinish); argv, cwd, env, o\'rinbosar; chiqish redakt + done chunk', async () => {
      httpSeq = [null, 503, 200];
      scripts = [(a) => (a[0] === 'run' && a[1] === 'build' ? { stdout: 'building...\nAPI_TOKEN=sk-ant-abcdefghijklmnop\nok\n', stderr: 'warn line\n' } : undefined)];
      const r = await mk().execute('c1', 'run', payload(), root);
      expect(r.ok).toBe(true);
      const s = deploy(r);
      expect(s).toMatchObject({ kind: 'run', target: 'prod', commit: COMMIT, outcome: 'success', failedPhase: null, rollbackDefined: true });
      expect(s.steps.map((x) => `${x.phase}:${x.name}:${x.status}`)).toEqual(['preflight:tests:ok', 'steps:build:ok', 'steps:restart:ok', 'health:health check:ok']);
      expect(s.health).toEqual({ ok: true, attempts: 3, lastStatus: 200 });
      expect(sleeps).toEqual([1000, 1000]);
      // argv massivi (shell yo'q), cwd, env
      expect(spawned.map((x) => [x.bin, ...x.args].join(' '))).toEqual(['/usr/bin/npm test', '/usr/bin/npm run build', '/usr/bin/systemctl-user restart app']);
      expect(spawned.every((x) => x.cwd === root)).toBe(true);
      const build = spawned[1]!;
      expect(build.env['APP_COMMIT']).toBe(COMMIT);
      expect(build.env['APP_MODE']).toBe('prod');
      expect(build.env['KEEP_ME']).toBe('yes');
      expect(build.env['COMMANDER_TOKEN']).toBeUndefined(); // agentd sirlari bolalarga o'tmaydi
      expect(build.env['AGENTD_X']).toBeUndefined();
      expect(build.env['COMMANDER_DEPLOY_TARGET']).toBe('prod');
      // chiqish
      const out = lines();
      expect(out.some((l) => l.startsWith('== deploy prod @ aaaaaaaa'))).toBe(true);
      expect(out).toContain('building...');
      expect(out.join('\n')).not.toContain('sk-ant-abcdefghijklmnop');
      expect(out.join('\n')).toContain('[REDACTED]');
      const last = sent[sent.length - 1]!;
      expect(last).toMatchObject({ done: true, reason: 'complete' });
      expect(sent.map((c) => c.seq)).toEqual([...sent.keys()]); // tartib raqamlar
    });

    it('preflight muvaffaqiyatsiz -> steps ishga tushmaydi, rollback yo\'q (preflight_failed)', async () => {
      scripts = [(a) => (a[0] === 'test' ? { code: 1 } : undefined)];
      const r = await mk().execute('c1', 'run', payload(), root);
      expect(r).toMatchObject({ ok: false, code: 'preflight_failed' });
      const s = deploy(r);
      expect(s).toMatchObject({ outcome: 'failed', failedPhase: 'preflight', failedStep: 'tests' });
      expect(spawned).toHaveLength(1);
      expect(sent[sent.length - 1]).toMatchObject({ done: true, reason: 'error' });
    });

    it('qadam muvaffaqiyatsiz -> qolganlari skipped, avtomatik rollback, rollback health -> rolled_back', async () => {
      httpSeq = [200];
      const fs = await import('node:fs');
      fs.mkdirSync(join(root, 'scripts'));
      fs.writeFileSync(join(root, 'scripts/rollback.sh'), '#!/bin/sh\n');
      scripts = [(a) => (a[0] === 'run' && a[1] === 'build' ? { code: 2, stderr: 'boom\n' } : undefined)];
      const r = await mk().execute('c1', 'run', payload(), root);
      expect(r).toMatchObject({ ok: false, code: 'deploy_failed' });
      const s = deploy(r);
      expect(s).toMatchObject({ outcome: 'rolled_back', failedPhase: 'steps', failedStep: 'build' });
      expect(s.steps.map((x) => `${x.phase}:${x.name}:${x.status}`)).toEqual([
        'preflight:tests:ok',
        'steps:build:failed',
        'steps:restart:skipped',
        'rollback:undo:ok',
        'rollback_health:health check:ok',
      ]);
      expect(spawned.map((x) => [x.bin, ...x.args].join(' '))).toEqual(['/usr/bin/npm test', '/usr/bin/npm run build', `${join(root, 'scripts/rollback.sh')} aaaaaaaa`]);
    });

    it('health muvaffaqiyatsiz -> rollback; rollback ham muvaffaqiyatsiz -> rollback_failed', async () => {
      httpSeq = []; // hamma urinish: javob yo'q
      scripts = [(a) => (a[0] === 'aaaaaaaa' ? { code: 1 } : undefined)];
      // rollback skripti nisbiy yo'l: resolveBin ishlatilmaydi, fayl yo'q -> topilmadi
      const r = await mk().execute('c1', 'run', payload(), root);
      expect(r).toMatchObject({ ok: false, code: 'health_check_failed' });
      const s = deploy(r);
      expect(s.failedPhase).toBe('health');
      expect(s.outcome).toBe('rollback_failed'); // ./scripts/rollback.sh mavjud emas (cwd ichida topilmadi)
      expect(s.health).toMatchObject({ ok: false, attempts: 4, lastStatus: null });
    });

    it('rollback skripti mavjud bo\'lsa rolled_back; skript cwd ichida bo\'lishi shart', async () => {
      const { mkdirSync, writeFileSync, chmodSync } = await import('node:fs');
      mkdirSync(join(root, 'scripts'));
      writeFileSync(join(root, 'scripts/rollback.sh'), '#!/bin/sh\nexit 0\n');
      chmodSync(join(root, 'scripts/rollback.sh'), 0o755);
      httpSeq = [null, null, null, null, 200]; // deploy health muvaffaqiyatsiz, rollback health ok
      const r = await mk().execute('c1', 'run', payload(), root);
      const s = deploy(r);
      expect(s).toMatchObject({ outcome: 'rolled_back', failedPhase: 'health' });
      expect(spawned[spawned.length - 1]).toMatchObject({ bin: join(root, 'scripts/rollback.sh'), args: ['aaaaaaaa'] });
    });

    it('qadam muddati: timeout holati, jarayon o\'ldiriladi (kill), keyingi qadamlar skipped', async () => {
      const fast = RECIPE.replace('run: [npm, run, build]', 'run: [npm, run, build]\n        timeout: 1').replace(/    rollback:[\s\S]*$/, '');
      gitState.recipe = fast;
      scripts = [(a) => (a[0] === 'run' && a[1] === 'build' ? { hang: true } : undefined)];
      const r = await mk().execute('c1', 'run', payload({ recipeHash: parseRecipe(fast).recipeHash! }), root);
      expect(r).toMatchObject({ ok: false, code: 'deploy_failed' });
      const s = deploy(r);
      expect(s).toMatchObject({ outcome: 'failed', failedStep: 'build' });
      expect(s.steps.find((x) => x.name === 'build')?.status).toBe('timeout');
      expect(s.steps.find((x) => x.name === 'restart')?.status).toBe('skipped');
      expect(killed).toBe(1);
      expect(lines().some((l) => l.includes('timed out'))).toBe(true);
    }, 10_000);

    it('ishga tushmagan buyruq (ENOENT) va topilmagan buyruq: step failed', async () => {
      scripts = [(a) => (a[0] === 'test' ? { error: 'ENOENT' } : undefined)];
      const r = await mk().execute('c1', 'run', payload(), root);
      expect(deploy(r)).toMatchObject({ outcome: 'failed', failedStep: 'tests' });
      expect(lines().some((l) => l.includes('could not start: ENOENT'))).toBe(true);
      const ops = new DeployOps({ log, send: () => true, policy: () => policy(), git, resolveBin: () => undefined, spawn: () => { throw new Error('must not spawn'); } });
      const r2 = await ops.execute('c9', 'run', payload(), root);
      expect(deploy(r2).steps[0]).toMatchObject({ status: 'failed', exitCode: 127 });
    });

    it('rollback buyrug\'i: faqat rollback qadamlari + health; rollback yo\'q maqsadda rad', async () => {
      httpSeq = [200];
      const mkdirs = await import('node:fs');
      mkdirs.mkdirSync(join(root, 'scripts'));
      mkdirs.writeFileSync(join(root, 'scripts/rollback.sh'), '#!/bin/sh\n');
      const r = await mk().execute('c1', 'rollback', payload(), root);
      expect(r.ok).toBe(true);
      const s = deploy(r);
      expect(s).toMatchObject({ kind: 'rollback', outcome: 'rolled_back' });
      expect(s.steps.map((x) => x.phase)).toEqual(['rollback', 'rollback_health']);
      expect(spawned).toHaveLength(1);
      const noRb = RECIPE.replace(/    rollback:[\s\S]*$/, '');
      gitState.recipe = noRb;
      expect(await mk().execute('c2', 'rollback', payload({ recipeHash: parseRecipe(noRb).recipeHash! }), root)).toMatchObject({ ok: false, code: 'recipe_invalid' });
    });

    it('health: buyruq turi (exit 0 = sog\'lom) va placeholder bilan URL', async () => {
      const r1 = RECIPE.replace(/    health:\n      url: .*\n/, '    health:\n      run: [check-app, "--commit={{short_commit}}"]\n');
      gitState.recipe = r1;
      scripts = [(a) => (a[0] === 'check-app' || a[0]?.startsWith('--commit') ? { code: 0 } : undefined)];
      const r = await mk().execute('c1', 'run', payload({ recipeHash: parseRecipe(r1).recipeHash! }), root);
      expect(r.ok).toBe(true);
      expect(spawned[spawned.length - 1]!.args).toEqual(['--commit=aaaaaaaa']);
    });
  });

  describe('OutputSink', () => {
    it('8 MB chegarasi: keyingi qatorlar tashlanadi, truncated, done chunk; orqa bosimda dropped bildiriladi', () => {
      const chunks: LogsChunkPayload[] = [];
      const accept = true;
      const sink = new OutputSink('11111111-1111-4111-8111-111111111111', (p) => {
        if (!accept) return false;
        chunks.push(p);
        return true;
      }, 1000);
      const big = 'x'.repeat(1000);
      for (let i = 0; i < 9000; i++) sink.push([big]);
      sink.flush();
      expect(sink.truncated).toBe(true);
      const total = chunks.flatMap((c) => c.lines).join('\n').length;
      expect(total).toBeLessThan(8.3 * 1024 * 1024);
      expect(chunks.flatMap((c) => c.lines).some((l) => l.includes('output truncated'))).toBe(true);
      // orqa bosim
      const c2: LogsChunkPayload[] = [];
      let ok2 = false;
      const s2 = new OutputSink('11111111-1111-4111-8111-111111111111', (p) => {
        if (!ok2) return false;
        c2.push(p);
        return true;
      }, 1000);
      s2.push(['a', 'b']);
      s2.flush(); // rad etildi -> dropped=2
      ok2 = true;
      s2.push(['c']);
      s2.end('complete');
      expect(c2[0]).toMatchObject({ lines: ['c'], dropped: 2 });
      expect(c2[c2.length - 1]).toMatchObject({ done: true, reason: 'complete' });
      s2.end('error'); // takroriy end: no-op
      expect(c2.filter((c) => c.done)).toHaveLength(1);
    });
  });
});
