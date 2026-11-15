import { spawn } from 'node:child_process';
import { lstatSync, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { DEPLOY_LIMITS, DEPLOY_RECIPE_PATH, DeployInspectResultSchema, DeploySummarySchema, LOG_LIMITS, SHA_RE } from '@commander/contracts';
import type {
  CommandErrorCode,
  DeployExecPayload,
  DeployHealth,
  DeployInspectPayload,
  DeployInspectResult,
  DeployPhase,
  DeployRecipe,
  DeployStep,
  DeployStepResult,
  DeploySummary,
  DeployTarget,
  LogsChunkPayload,
} from '@commander/contracts';
import { argvInvokesShell, parseRecipe, substitute } from './deploy-recipe.js';
import type { PlaceholderCtx } from './deploy-recipe.js';
import { GIT_STATUS_TIMEOUT_MS, readHead, runGit } from './git-info.js';
import type { GitRunner } from './git-info.js';
import { errMsg, type Logger } from './logger.js';
import { LineSplitter, LogRedactor } from './logs-source.js';
import { checkCwd, isInside, realPathOps, sensitiveDirs } from './policy.js';
import type { PathOps, Policy } from './policy.js';
import type { RunnerOutcome } from './runner.js';
import { findTrustedBin, safeExecEnv } from './trusted-bin.js';

/**
 * Deploy buyruqlari (task 6.5): `deploy.inspect`, `deploy.run`, `deploy.rollback`. Imzo, muddat, nonce va lokal siyosat
 * (`allowDeploy`, ildiz) `CommandManager`da ALLAQACHON tekshirilgan; bu yerda:
 *  - retseptni PIN QILINGAN commit'dan o'qish (`git cat-file blob <sha>:.commander/deploy.yml`: ishchi daraxt emas), xesh/commit/mashina/
 *    maqsad/shell tekshiruvi (TOCTOU: egasi tasdiqlagan (target, commit, hash) o'zgargan bo'lsa rad);
 *  - qadamlarni ketma-ket ARGV bilan (shell yo'q; `shell:` faqat siyosat `allowDeployShell` bilan) bajarish, jarayon guruhini muddatda o'ldirish;
 *  - chiqishni redakt qilib `logs.chunk` orqali jonli yuborish (DB'ga yozilmaydi, 8 MB chegarasi, orqa bosimda tashlash);
 *  - health-check (HTTP yoki buyruq; urinish/muddat/oraliq), muvaffaqiyatsizlikda avtomatik rollback (retseptda bo'lsa).
 * Faqat POSIX (Windows'da `.cmd` shim'lar argv bilan xavfsiz ishlamaydi).
 */

export interface DeployProc {
  onStdout(cb: (chunk: Buffer) => void): void;
  onStderr(cb: (chunk: Buffer) => void): void;
  /** `error` = ishga tushmadi (ENOENT va h.k.). */
  onExit(cb: (code: number | null, error?: string) => void): void;
  kill(): void;
}

export interface DeployOpsDeps {
  log: Logger;
  /** `logs.chunk` yuborish; `false` = band/uzilgan (orqa bosim). */
  send: (p: LogsChunkPayload) => boolean;
  policy: () => Policy;
  git?: GitRunner;
  spawn?: (bin: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv }) => DeployProc;
  /** HTTP GET: status kodi yoki `null` (xato/muddat). Tana o'qilmaydi. */
  httpGet?: (url: string, timeoutMs: number) => Promise<number | null>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Bare nomni ishonchli yo'lga aylantirish (testlar uchun). */
  resolveBin?: (name: string, excludeDirs: string[]) => string | undefined;
  env?: NodeJS.ProcessEnv;
  ops?: PathOps;
  sensitive?: readonly string[];
  platform?: string;
  /** Chiqish yuborish oralig'i (ms). */
  flushMs?: number;
}

const fail = (code: CommandErrorCode, message: string, deploy?: DeploySummary): RunnerOutcome => ({
  ok: false,
  code,
  message,
  ...(deploy ? { result: { deploy, detail: `${deploy.outcome}${deploy.failedStep ? `: ${deploy.failedStep}` : ''}`.slice(0, 200) } } : {}),
});

export const defaultDeploySpawn = (bin: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv }): DeployProc => {
  const child = spawn(bin, args, { cwd: o.cwd, env: o.env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true, shell: false });
  const killGroup = (sig: NodeJS.Signals): void => {
    try {
      if (child.pid !== undefined && process.platform !== 'win32') process.kill(-child.pid, sig);
      else child.kill(sig);
    } catch {
      /* allaqachon tugagan */
    }
  };
  return {
    onStdout: (cb) => void child.stdout?.on('data', cb),
    onStderr: (cb) => void child.stderr?.on('data', cb),
    onExit: (cb) => {
      let done = false;
      child.on('error', (e) => {
        if (!done) {
          done = true;
          cb(null, (e as NodeJS.ErrnoException).code ?? e.message);
        }
      });
      child.on('close', (code) => {
        if (!done) {
          done = true;
          cb(code);
        }
      });
    },
    kill: () => {
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), 5000).unref();
    },
  };
};

export const defaultHttpGet = (url: string, timeoutMs: number): Promise<number | null> =>
  new Promise((resolve) => {
    let settled = false;
    const done = (v: number | null): void => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    try {
      const u = new URL(url);
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.request(u, { method: 'GET', agent: false, timeout: timeoutMs, headers: { 'user-agent': 'commander-deploy-health/1', connection: 'close' } }, (res) => {
        done(res.statusCode ?? null);
        res.destroy(); // tana o'qilmaydi (faqat status)
      });
      req.on('timeout', () => {
        done(null);
        req.destroy();
      });
      req.on('error', () => done(null));
      req.end();
    } catch {
      done(null);
    }
  });

/** Jonli chiqish: redakt + yig'ish + `logs.chunk` (bufer/orqa bosim/hajm chegarasi). */
export class OutputSink {
  private seq = 0;
  private pending: string[] = [];
  private pendingBytes = 0;
  private dropped = 0;
  private total = 0;
  private over = false;
  private timer: NodeJS.Timeout | null = null;
  private ended = false;
  truncated = false;
  lines = 0;

  constructor(
    private readonly commandId: string,
    private readonly send: (p: LogsChunkPayload) => boolean,
    private readonly flushMs: number,
  ) {}

  push(raw: readonly string[]): void {
    if (this.ended) return;
    for (const l of raw) {
      if (this.over) {
        this.dropped++;
        continue;
      }
      const bytes = Buffer.byteLength(l, 'utf8') + 1;
      if (this.total + bytes > DEPLOY_LIMITS.outputMaxBytes) {
        this.over = true;
        this.truncated = true;
        this.pending.push('[output truncated: 8 MB limit reached; the deploy keeps running]');
        this.dropped++;
        continue;
      }
      this.total += bytes;
      this.lines++;
      this.pending.push(l);
      this.pendingBytes += bytes;
      if (this.pending.length >= LOG_LIMITS.chunkMaxLines || this.pendingBytes >= LOG_LIMITS.chunkMaxBytes - 4096) this.flush();
    }
    if (this.pending.length > 0 && !this.timer) {
      this.timer = setTimeout(() => this.flush(), this.flushMs);
      this.timer.unref();
    }
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    while (this.pending.length > 0) {
      const batch = this.pending.slice(0, LOG_LIMITS.chunkMaxLines);
      const ok = this.send({ commandId: this.commandId, seq: this.seq, lines: batch, ...(this.dropped > 0 ? { dropped: this.dropped } : {}) });
      if (!ok) {
        // orqa bosim/uzilgan: shu partiya tashlanadi (deploy to'xtamaydi), keyingi chunk `dropped` bildiradi
        this.dropped += batch.length;
      } else {
        this.dropped = 0;
        this.seq++;
      }
      this.pending.splice(0, batch.length);
    }
    this.pendingBytes = 0;
  }

  /** Oxirgi chunk (`done`). Qayta chaqirilsa no-op. */
  end(reason: 'complete' | 'error', error?: { code: string; message: string }): void {
    if (this.ended) return;
    this.flush();
    this.ended = true;
    this.send({ commandId: this.commandId, seq: this.seq, lines: [], done: true, reason, ...(error ? { error } : {}), ...(this.dropped > 0 ? { dropped: this.dropped } : {}) });
  }
}

interface RunCtx {
  commandId: string;
  recipe: DeployRecipe;
  target: DeployTarget;
  commit: string;
  hash: string;
  root: string;
  cwd: string;
  placeholders: PlaceholderCtx;
  sink: OutputSink;
  baseEnv: NodeJS.ProcessEnv;
  allowShell: boolean;
  results: DeployStepResult[];
}

const isSafeSha = (s: string): boolean => SHA_RE.test(s);

export class DeployOps {
  private readonly git: GitRunner;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly spawnProc: NonNullable<DeployOpsDeps['spawn']>;
  private readonly httpGet: NonNullable<DeployOpsDeps['httpGet']>;
  private readonly platform: string;
  private readonly active = new Set<string>();

  constructor(private readonly d: DeployOpsDeps) {
    this.git = d.git ?? runGit;
    this.now = d.now ?? Date.now;
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.spawnProc = d.spawn ?? defaultDeploySpawn;
    this.httpGet = d.httpGet ?? defaultHttpGet;
    this.platform = d.platform ?? process.platform;
  }

  // --- git: retsept pin qilingan commit'dan -------------------------------------------------------

  private async tryGit(root: string, args: string[], timeoutMs?: number): Promise<string | null> {
    try {
      return await this.git(root, args, timeoutMs ? { timeoutMs } : undefined);
    } catch {
      return null;
    }
  }

  /** `commit` (ixtiyoriy qisqa sha) -> to'liq sha yoki `null` (commit emas/yo'q). */
  private async resolveCommit(root: string, commit: string | undefined): Promise<string | null> {
    const rev = commit === undefined ? 'HEAD' : commit;
    if (commit !== undefined && !isSafeSha(commit)) return null;
    const out = await this.tryGit(root, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
    const sha = out?.trim() ?? '';
    return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
  }

  /** Retsept matni shu commit'da: `null` = fayl yo'q, `'too_large'` = katta. */
  private async readRecipeText(root: string, commit: string): Promise<string | null | 'too_large'> {
    const spec = `${commit}:${DEPLOY_RECIPE_PATH}`;
    const size = await this.tryGit(root, ['cat-file', '-s', spec]);
    if (size === null || !/^\d+$/.test(size.trim())) return null;
    if (Number(size.trim()) > DEPLOY_LIMITS.recipeMaxBytes) return 'too_large';
    return this.tryGit(root, ['cat-file', 'blob', spec], 15_000);
  }

  private async isDirty(root: string): Promise<boolean | null> {
    const st = await this.tryGit(root, ['status', '--porcelain=v2', '-z', '--untracked-files=no'], GIT_STATUS_TIMEOUT_MS);
    return st === null ? null : st.length > 0;
  }

  private workingTreeCopy(root: string): string | null {
    const file = path.join(root, DEPLOY_RECIPE_PATH);
    try {
      const st = lstatSync(file);
      if (!st.isFile() || st.size > DEPLOY_LIMITS.recipeMaxBytes) return null;
      return readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  }

  // --- deploy.inspect -------------------------------------------------------------------------

  async inspect(p: DeployInspectPayload, root: string): Promise<RunnerOutcome> {
    try {
      const commit = await this.resolveCommit(root, p.commit);
      if (!commit) return fail('git_failed', p.commit ? 'The commit was not found in this repository' : 'The repository has no commits (HEAD is unborn)');
      const head = readHead(root);
      const dirty = (await this.isDirty(root)) ?? true;
      const text = await this.readRecipeText(root, commit);
      const pol = this.d.policy().remote;
      const base = { commit, branch: head?.branch ?? null, dirty, allowDeploy: pol.allowDeploy, allowDeployShell: pol.allowDeployShell };
      let result: DeployInspectResult;
      if (text === null || text === 'too_large') {
        const wt = this.workingTreeCopy(root);
        result = {
          ...base,
          recipePresent: text === 'too_large',
          workingTreeDiffers: wt !== null,
          valid: false,
          issues: text === 'too_large' ? [`${DEPLOY_RECIPE_PATH} is larger than ${DEPLOY_LIMITS.recipeMaxBytes} bytes`] : [wt !== null ? `${DEPLOY_RECIPE_PATH} exists in the working tree but is NOT committed at ${commit.slice(0, 8)}: commit it first (deploys read the committed recipe)` : `${DEPLOY_RECIPE_PATH} was not found at ${commit.slice(0, 8)}`],
          recipe: null,
          recipeHash: null,
          usesShell: false,
          machineMatches: {},
        };
      } else {
        const parsed = parseRecipe(text);
        const wt = this.workingTreeCopy(root);
        const machineMatches: Record<string, boolean> = {};
        for (const t of parsed.recipe?.targets ?? []) machineMatches[t.name] = t.machine.toLowerCase() === p.machine.toLowerCase();
        result = {
          ...base,
          recipePresent: true,
          workingTreeDiffers: wt !== null && wt !== text,
          valid: parsed.recipe !== null,
          issues: parsed.issues,
          recipe: parsed.recipe,
          recipeHash: parsed.recipeHash,
          usesShell: parsed.usesShell,
          machineMatches,
        };
      }
      const checked = DeployInspectResultSchema.safeParse(result);
      if (!checked.success) return fail('internal', 'inspect result failed validation');
      // agent kanali xabari 256 KiB: normallashtirilgan retsept juda katta bo'lsa yuborib bo'lmaydi
      if (JSON.stringify(checked.data).length > 200_000) return fail('recipe_invalid', 'The normalized recipe is too large to send (reduce targets/steps)');
      return { ok: true, result: { deploy: checked.data, detail: `${checked.data.valid ? 'valid' : 'invalid'} recipe @ ${commit.slice(0, 8)}` } };
    } catch (err) {
      this.d.log.warn('deploy.inspect xatosi', { error: errMsg(err).slice(0, 200) });
      return fail('git_failed', 'deploy inspect failed');
    }
  }

  // --- deploy.run / deploy.rollback -----------------------------------------------------------

  async execute(commandId: string, kind: 'run' | 'rollback', p: DeployExecPayload, root: string): Promise<RunnerOutcome> {
    if (this.platform === 'win32') return fail('action_not_allowed', 'deploy is not supported on Windows');
    const lockKey = `${root}::${p.target}`;
    if (this.active.has(lockKey)) return fail('deploy_busy', 'A deploy for this target is already running');
    this.active.add(lockKey);
    try {
      return await this.executeLocked(commandId, kind, p, root);
    } finally {
      this.active.delete(lockKey);
    }
  }

  private async executeLocked(commandId: string, kind: 'run' | 'rollback', p: DeployExecPayload, root: string): Promise<RunnerOutcome> {
    const pol = this.d.policy().remote;
    if (!pol.allowDeploy) return fail('action_not_allowed', 'Deploy is not enabled in the local policy (agentd policy allow-deploy)');

    // 1) pin: HEAD == commit (egasi ko'rgan commit)
    const head = await this.resolveCommit(root, undefined);
    const pinned = await this.resolveCommit(root, p.commit);
    if (!head || !pinned || head !== pinned) return fail('commit_changed', `HEAD is not at the confirmed commit ${p.commit.slice(0, 8)} (it moved since the recipe was reviewed)`);
    // 2) ishchi daraxt toza (kuzatiladigan fayllar): deploy qilinadigan kod = ko'rib chiqilgan commit
    const dirty = await this.isDirty(root);
    if (dirty === null) return fail('git_failed', 'git status failed');
    if (dirty) return fail('dirty_worktree', 'There are uncommitted changes to tracked files; commit or stash them first');
    // 3) retsept shu commit'dan, xesh mos
    const text = await this.readRecipeText(root, pinned);
    if (text === null || text === 'too_large') return fail('recipe_missing', `${DEPLOY_RECIPE_PATH} was not found (or is too large) at ${pinned.slice(0, 8)}`);
    const parsed = parseRecipe(text);
    if (!parsed.recipe || !parsed.recipeHash) return fail('recipe_invalid', `The recipe is invalid: ${parsed.issues[0] ?? 'unknown'}`.slice(0, 300));
    if (parsed.recipeHash !== p.recipeHash) return fail('recipe_changed', 'The recipe content changed since you confirmed it (hash mismatch); inspect it again');
    const target = parsed.recipe.targets.find((t) => t.name === p.target);
    if (!target) return fail('target_not_found', `Target "${p.target}" is not in the recipe`);
    if (target.machine.toLowerCase() !== p.machine.toLowerCase()) return fail('machine_mismatch', `The target is for machine "${target.machine}", not "${p.machine}"`);
    if (target.usesShell && !pol.allowDeployShell) return fail('shell_not_allowed', 'The recipe uses shell steps; enable them locally with: agentd policy allow-deploy-shell');
    if (kind === 'rollback' && target.rollback.length === 0) return fail('recipe_invalid', 'The target defines no rollback steps');

    // 4) cwd
    const cwdCheck = this.resolveTargetCwd(root, target.cwd, pol.allowedRoots);
    if (!cwdCheck.ok) return fail(cwdCheck.code, cwdCheck.message);

    const sink = new OutputSink(commandId, this.d.send, this.d.flushMs ?? 500);
    const ctx: RunCtx = {
      commandId,
      recipe: parsed.recipe,
      target,
      commit: pinned,
      hash: parsed.recipeHash,
      root,
      cwd: cwdCheck.real,
      placeholders: { commit: pinned, target: target.name },
      sink,
      baseEnv: this.buildBaseEnv(target.name, pinned),
      allowShell: pol.allowDeployShell,
      results: [],
    };
    const started = this.now();
    sink.push([`== ${kind === 'run' ? 'deploy' : 'rollback'} ${target.name} @ ${pinned.slice(0, 8)} (recipe ${p.recipeHash.slice(0, 8)}) ==`]);
    let summary: DeploySummary;
    try {
      summary = kind === 'run' ? await this.runDeploy(ctx, started) : await this.runRollback(ctx, started);
    } catch (err) {
      this.d.log.error('deploy kutilmagan xato', { error: errMsg(err).slice(0, 200) });
      sink.end('error', { code: 'internal', message: 'unexpected deploy error' });
      return fail('internal', 'unexpected deploy error');
    }
    const okEnd = kind === 'run' ? summary.outcome === 'success' : summary.outcome === 'rolled_back';
    sink.end(okEnd ? 'complete' : 'error', okEnd ? undefined : { code: 'deploy_failed', message: summary.outcome });
    const checked = DeploySummarySchema.safeParse({ ...summary, outputTruncated: sink.truncated });
    const out = checked.success ? checked.data : summary;
    // `run`: faqat `success` muvaffaqiyat (qayta tiklangan deploy HAM muvaffaqiyatsiz: buyruq `failed`, xulosada `rolled_back`);
    // `rollback`: `rolled_back` muvaffaqiyat.
    const succeeded = kind === 'run' ? out.outcome === 'success' : out.outcome === 'rolled_back';
    if (succeeded) return { ok: true, result: { deploy: out, detail: `${out.outcome} in ${Math.round(out.durationMs / 1000)}s`.slice(0, 200) } };
    const code: CommandErrorCode = out.failedPhase === 'preflight' ? 'preflight_failed' : out.failedPhase === 'health' ? 'health_check_failed' : 'deploy_failed';
    return fail(code, `${out.outcome}${out.failedStep ? ` at "${out.failedStep}"` : ''}`.slice(0, 300), out);
  }

  private resolveTargetCwd(root: string, cwd: string, roots: readonly string[]): { ok: true; real: string } | { ok: false; code: CommandErrorCode; message: string } {
    const ops = this.d.ops ?? realPathOps;
    const sens = this.d.sensitive ?? sensitiveDirs();
    const abs = path.isAbsolute(cwd);
    const resolved = abs ? cwd : path.resolve(root, cwd);
    const c = checkCwd(resolved, abs ? roots : [root], ops, sens);
    if (!c.ok) return { ok: false, code: c.code, message: `target cwd: ${c.message}` };
    return { ok: true, real: c.real };
  }

  private buildBaseEnv(target: string, commit: string): NodeJS.ProcessEnv {
    const src = this.d.env ?? process.env;
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(src)) {
      if (v === undefined || k.startsWith('COMMANDER_') || k.startsWith('AGENTD_')) continue;
      env[k] = v;
    }
    return safeExecEnv(env, { COMMANDER_DEPLOY: '1', COMMANDER_DEPLOY_TARGET: target, COMMANDER_DEPLOY_COMMIT: commit, GIT_TERMINAL_PROMPT: '0' });
  }

  // --- bosqichlar -----------------------------------------------------------------------------

  private summary(ctx: RunCtx, kind: 'run' | 'rollback', outcome: DeploySummary['outcome'], failed: { phase: DeployPhase; step: string } | null, health: DeploySummary['health'], started: number): DeploySummary {
    return {
      kind,
      target: ctx.target.name,
      commit: ctx.commit,
      recipeHash: ctx.hash,
      outcome,
      failedPhase: failed?.phase ?? null,
      failedStep: failed?.step ?? null,
      steps: ctx.results.slice(0, DEPLOY_LIMITS.summarySteps),
      health,
      rollbackDefined: ctx.target.rollback.length > 0,
      durationMs: Math.max(0, this.now() - started),
      outputTruncated: ctx.sink.truncated,
    };
  }

  private async runDeploy(ctx: RunCtx, started: number): Promise<DeploySummary> {
    const deadline = started + ctx.target.timeoutSec * 1000;
    const t = ctx.target;
    const pre = await this.runPhase(ctx, 'preflight', t.preflight, deadline);
    if (pre) return this.summary(ctx, 'run', 'failed', pre, null, started);
    const main = await this.runPhase(ctx, 'steps', t.steps, deadline);
    let failed: { phase: DeployPhase; step: string } | null = main;
    let health: DeploySummary['health'] = null;
    if (!failed && t.health) {
      const h = await this.runHealth(ctx, 'health', t.health, deadline);
      health = h;
      if (!h.ok) failed = { phase: 'health', step: 'health check' };
    }
    if (!failed) return this.summary(ctx, 'run', 'success', null, health, started);
    if (t.rollback.length === 0) return this.summary(ctx, 'run', 'failed', failed, health, started);
    ctx.sink.push([`== deploy failed (${failed.phase}${failed.step ? `: ${failed.step}` : ''}): rolling back ==`]);
    const rb = await this.runPhase(ctx, 'rollback', t.rollback, null);
    if (rb) return this.summary(ctx, 'run', 'rollback_failed', failed, health, started);
    let rbHealth = health;
    if (t.health) {
      rbHealth = await this.runHealth(ctx, 'rollback_health', t.health, null);
      if (!rbHealth.ok) return this.summary(ctx, 'run', 'rollback_failed', failed, rbHealth, started);
    }
    return this.summary(ctx, 'run', 'rolled_back', failed, rbHealth, started);
  }

  private async runRollback(ctx: RunCtx, started: number): Promise<DeploySummary> {
    const t = ctx.target;
    const rb = await this.runPhase(ctx, 'rollback', t.rollback, null);
    if (rb) return this.summary(ctx, 'rollback', 'rollback_failed', rb, null, started);
    let health: DeploySummary['health'] = null;
    if (t.health) {
      health = await this.runHealth(ctx, 'rollback_health', t.health, null);
      if (!health.ok) return this.summary(ctx, 'rollback', 'rollback_failed', { phase: 'rollback_health', step: 'health check' }, health, started);
    }
    return this.summary(ctx, 'rollback', 'rolled_back', null, health, started);
  }

  /** Qadamlarni ketma-ket bajaradi; birinchi muvaffaqiyatsizlikda to'xtaydi (qolganlari `skipped`). */
  private async runPhase(ctx: RunCtx, phase: DeployPhase, steps: readonly DeployStep[], deadline: number | null): Promise<{ phase: DeployPhase; step: string } | null> {
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i]!;
      ctx.sink.push([`-- [${phase} ${i + 1}/${steps.length}] ${s.name}`]);
      const r = await this.runStep(ctx, phase, s, deadline);
      ctx.results.push(r);
      if (r.status !== 'ok') {
        for (const rest of steps.slice(i + 1)) ctx.results.push({ phase, name: rest.name, status: 'skipped', exitCode: null, durationMs: 0 });
        ctx.sink.push([`-- step "${s.name}" ${r.status}${r.exitCode !== null ? ` (exit ${r.exitCode})` : ''}`]);
        return { phase, step: s.name };
      }
    }
    return null;
  }

  private resolveStepCwd(ctx: RunCtx, step: DeployStep): string | null {
    if (!step.cwd) return ctx.cwd;
    const ops = this.d.ops ?? realPathOps;
    try {
      const real = ops.realpath(path.resolve(ctx.cwd, step.cwd));
      if (!ops.isDirectory(real) || !isInside(ctx.cwd, real, ops.lib, ops.caseInsensitive)) return null;
      return real;
    } catch {
      return null;
    }
  }

  /** argv[0] -> bajariladigan yo'l (bare nom: ishonchli PATH, cwd/loyiha papkasi chiqarib tashlanadi; nisbiy yo'l: cwd ichida). */
  private resolveExec(ctx: RunCtx, cmd: string, cwd: string): string | null {
    if (path.isAbsolute(cmd)) return cmd;
    if (cmd.includes('/')) {
      const ops = this.d.ops ?? realPathOps;
      try {
        const real = ops.realpath(path.resolve(cwd, cmd));
        return isInside(ctx.cwd, real, ops.lib, ops.caseInsensitive) && statSync(real).isFile() ? real : null;
      } catch {
        return null;
      }
    }
    const find = this.d.resolveBin ?? ((n: string, ex: string[]) => findTrustedBin(n, { excludeDirs: ex }));
    return find(cmd, [ctx.cwd, ctx.root]) ?? null;
  }

  private stepEnv(ctx: RunCtx, step: DeployStep, phase: DeployPhase): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...ctx.baseEnv, COMMANDER_DEPLOY_PHASE: phase };
    for (const [k, v] of Object.entries(step.env)) env[k] = substitute(v, ctx.placeholders);
    return env;
  }

  private async runStep(ctx: RunCtx, phase: DeployPhase, step: DeployStep, deadline: number | null): Promise<DeployStepResult> {
    const t0 = this.now();
    const done = (status: DeployStepResult['status'], exitCode: number | null): DeployStepResult => ({ phase, name: step.name.slice(0, DEPLOY_LIMITS.stepNameMaxChars + 20), status, exitCode, durationMs: Math.max(0, this.now() - t0) });
    const remaining = deadline === null ? Infinity : deadline - t0;
    if (remaining <= 0) {
      ctx.sink.push(['-- deploy time budget exhausted']);
      return done('timeout', null);
    }
    const timeoutMs = Math.min(step.timeoutSec * 1000, remaining);
    const cwd = this.resolveStepCwd(ctx, step);
    if (!cwd) {
      ctx.sink.push(['-- step cwd is outside the target directory']);
      return done('failed', null);
    }
    let bin: string | null;
    let args: string[];
    if (step.kind === 'shell') {
      if (!ctx.allowShell) {
        ctx.sink.push(['-- shell steps are disabled by the local policy']);
        return done('failed', null);
      }
      bin = '/bin/sh';
      args = ['-c', substitute(step.shell ?? '', ctx.placeholders)];
    } else {
      const argv = step.argv.map((a) => substitute(a, ctx.placeholders));
      if (argvInvokesShell(argv) && !ctx.allowShell) {
        ctx.sink.push(['-- this step runs a shell; disabled by the local policy']);
        return done('failed', null);
      }
      bin = this.resolveExec(ctx, argv[0]!, cwd);
      args = argv.slice(1);
      if (!bin) {
        ctx.sink.push([`-- command not found in the trusted PATH: ${argv[0]!.slice(0, 80)}`]);
        return done('failed', 127);
      }
    }
    const r = await this.runProc(ctx, bin, args, cwd, this.stepEnv(ctx, step, phase), timeoutMs);
    if (r.timedOut) return done('timeout', null);
    return r.code === 0 ? done('ok', 0) : done('failed', r.code);
  }

  /** Jarayonni ishga tushiradi, chiqishni sink'ga oqizadi, muddat tugasa o'ldiradi. */
  private runProc(ctx: RunCtx, bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ code: number | null; timedOut: boolean }> {
    return new Promise((resolve) => {
      const proc = this.spawnProc(bin, args, { cwd, env });
      const out = { split: new LineSplitter(), red: new LogRedactor() };
      const err = { split: new LineSplitter(), red: new LogRedactor() };
      let timedOut = false;
      let settled = false;
      const emit = (s: { split: LineSplitter; red: LogRedactor }, chunk: Buffer): void => ctx.sink.push(s.red.lines(s.split.push(chunk)));
      proc.onStdout((c) => emit(out, c));
      proc.onStderr((c) => emit(err, c));
      const timer = setTimeout(() => {
        timedOut = true;
        ctx.sink.push([`-- timed out after ${Math.round(timeoutMs / 1000)}s: terminating`]);
        proc.kill();
        // jarayon o'lmasa ham oqim osilib qolmasin
        setTimeout(() => finish(null), 8000).unref();
      }, timeoutMs);
      const finish = (code: number | null, error?: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ctx.sink.push([...out.red.lines(out.split.end()), ...err.red.lines(err.split.end())]);
        if (error) ctx.sink.push([`-- could not start: ${error.slice(0, 60)}`]);
        resolve({ code, timedOut });
      };
      proc.onExit((code, error) => finish(code, error));
    });
  }

  // --- health-check ---------------------------------------------------------------------------

  private async runHealth(ctx: RunCtx, phase: 'health' | 'rollback_health', h: DeployHealth, deadline: number | null): Promise<NonNullable<DeploySummary['health']>> {
    const total = 1 + h.retries;
    let lastStatus: number | null = null;
    let attempts = 0;
    const t0 = this.now();
    ctx.sink.push([`-- [${phase}] ${h.kind === 'http' ? `GET ${redactUrl(substitute(h.url ?? '', ctx.placeholders))}` : 'command'} (up to ${total} attempts)`]);
    for (let i = 0; i < total; i++) {
      if (deadline !== null && this.now() >= deadline) {
        ctx.sink.push(['-- deploy time budget exhausted during the health check']);
        break;
      }
      attempts++;
      let ok = false;
      if (h.kind === 'http') {
        const url = substitute(h.url ?? '', ctx.placeholders);
        lastStatus = await this.httpGet(url, h.timeoutSec * 1000);
        ok = lastStatus !== null && h.expectStatus.includes(lastStatus);
        ctx.sink.push([`   attempt ${i + 1}/${total}: ${lastStatus === null ? 'no response' : lastStatus}`]);
      } else {
        const argv = h.argv.map((a) => substitute(a, ctx.placeholders));
        const bin = argvInvokesShell(argv) && !ctx.allowShell ? null : this.resolveExec(ctx, argv[0]!, ctx.cwd);
        if (!bin) {
          ctx.sink.push(['   health command not runnable (not found, or it is a shell and shell steps are disabled)']);
        } else {
          const r = await this.runProc(ctx, bin, argv.slice(1), ctx.cwd, { ...ctx.baseEnv, COMMANDER_DEPLOY_PHASE: phase }, h.timeoutSec * 1000);
          lastStatus = r.code;
          ok = r.code === 0 && !r.timedOut;
          ctx.sink.push([`   attempt ${i + 1}/${total}: exit ${r.timedOut ? 'timeout' : r.code}`]);
        }
      }
      if (ok) {
        ctx.results.push({ phase, name: 'health check', status: 'ok', exitCode: h.kind === 'command' ? 0 : null, durationMs: Math.max(0, this.now() - t0) });
        return { ok: true, attempts, lastStatus };
      }
      if (i < total - 1) await this.sleep(h.intervalSec * 1000);
    }
    ctx.results.push({ phase, name: 'health check', status: 'failed', exitCode: h.kind === 'command' ? lastStatus : null, durationMs: Math.max(0, this.now() - t0) });
    return { ok: false, attempts, lastStatus };
  }
}

/** Jurnal/chiqishda URL ichidagi so'rov qatori (token bo'lishi mumkin) olib tashlanadi. */
function redactUrl(u: string): string {
  try {
    const p = new URL(u);
    return `${p.protocol}//${p.host}${p.pathname}${p.search ? '?…' : ''}`;
  } catch {
    return '(invalid url)';
  }
}

