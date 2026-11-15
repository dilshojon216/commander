import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { SCAN_LIMITS, ScanResultSchema, emptyCounts, sortFindings } from '@commander/contracts';
import type { ScanEcosystem, ScanFinding, ScanResult, ScanTool, ScanToolRun, ScanToolStatus } from '@commander/contracts';
import { errMsg, type Logger } from './logger.js';
import { isInside, realPathOps, sensitiveDirs } from './policy.js';
import { redact } from './redact.js';
import type { RunnerOutcome } from './runner.js';
import { parseGoListUpdates, parseGovulncheck, parseAdvisoriesMap, parseNpmAudit, parsePipAudit, parsePubOutdated, parseYarnAudit } from './scan-parsers.js';
import { envFileFinding, looksBinary, scanTextForSecrets, secretFinding, shouldSkipFile } from './secret-scan.js';
import { findTrustedBin, safeExecEnv } from './trusted-bin.js';

/**
 * Xavfsizlik/dependency tekshiruvi (task 6.10): `project.scan`. Siyosat (`allowScan`, ildiz) va imzo `CommandManager`da tekshirilgan.
 * FAQAT o'qiydigan, mahalliy mavjud asboblar (argumentlar massivi, shell YO'Q, absolyut yo'l, muddat + chiqish chegarasi, jarayon
 * daraxti o'ldiriladi); hech narsa o'rnatilmaydi/yozilmaydi (`npm audit --package-lock-only`, `fix` YO'Q). Tarmoq faqat audit
 * (reestr) uchun. Sirlar: faqat fayl+qator+qoida (secret-scan.ts).
 */

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  missing: boolean;
  timedOut: boolean;
  /** Chiqish chegarasidan oshdi (jarayon to'xtatildi). */
  overflow?: boolean;
}
export type ScanExec = (bin: string, args: readonly string[], opts: { cwd: string; timeoutMs: number; env?: Record<string, string> }) => Promise<ExecResult>;

export interface ScanFs {
  exists(path: string): boolean;
  readText(path: string): string | null;
  /** Fayl boshidan `max` bayt (yo'q = null) va to'liq hajmi. */
  readHead(path: string, max: number): { head: Uint8Array; size: number } | null;
  /** Papka yozuvlari (nom + papkami); xato = bo'sh. */
  list(dir: string): Array<{ name: string; dir: boolean }>;
}

export interface ProjectScanDeps {
  log: Logger;
  exec?: ScanExec;
  fs?: ScanFs;
  resolveBin?: (name: string) => string | undefined;
  now?: () => number;
  /** Maxfiy papkalar (default `sensitiveDirs()`): ildiz `$HOME` bo'lsa ham ular yurilmaydi va skanerlanmaydi. */
  sensitive?: readonly string[];
}

const SYSTEM_DIRS = ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin'];
const resolveDefault = (name: string): string | undefined => {
  const found = findTrustedBin(name, { allowShims: true });
  if (found) return found;
  if (process.platform === 'win32') return undefined;
  return findTrustedBin(name, { env: { PATH: SYSTEM_DIRS.join(':') } });
};

/** Jarayonni (va uning daraxtini) o'ldiradi. */
function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).unref();
    else process.kill(-pid, 'SIGKILL');
  } catch {
    /* allaqachon tugagan */
  }
}

export const defaultScanExec: ScanExec = (bin, args, opts) =>
  new Promise<ExecResult>((resolve) => {
    let out = '';
    let err = '';
    let overflow = false;
    let timedOut = false;
    let done = false;
    const finish = (r: ExecResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const child = spawn(bin, [...args], {
      cwd: opts.cwd,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: safeExecEnv(process.env, { NO_COLOR: '1', CI: '1', npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'true', ...(opts.env ?? {}) }),
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, opts.timeoutMs);
    child.stdout.on('data', (d: Buffer) => {
      if (out.length < SCAN_LIMITS.maxToolOutputBytes) out += d.toString('utf8');
      else if (!overflow) {
        overflow = true;
        killTree(child.pid);
      }
    });
    child.stderr.on('data', (d: Buffer) => {
      if (err.length < 64 * 1024) err += d.toString('utf8');
    });
    child.on('error', (e: NodeJS.ErrnoException) => finish({ code: null, stdout: '', stderr: '', missing: e.code === 'ENOENT', timedOut: false }));
    child.on('close', (code) => finish({ code, stdout: out, stderr: err, missing: false, timedOut, overflow }));
  });

export const defaultScanFs: ScanFs = {
  exists: (p) => existsSync(p),
  readText: (p) => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  },
  readHead: (p, max) => {
    try {
      const st = statSync(p);
      if (!st.isFile()) return null;
      const fd = openSync(p, 'r');
      try {
        const buf = Buffer.alloc(Math.min(max, st.size));
        readSync(fd, buf, 0, buf.length, 0);
        return { head: buf, size: st.size };
      } finally {
        closeSync(fd);
      }
    } catch {
      return null;
    }
  },
  list: (d) => {
    try {
      return readdirSync(d, { withFileTypes: true }).map((e) => ({ name: e.name, dir: e.isDirectory() }));
    } catch {
      return [];
    }
  },
};

const WALK_SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.dart_tool', '.next', '.nx', 'vendor', 'target', '.venv', 'venv', '__pycache__', '.gradle', 'Pods', '.idea', 'coverage']);

interface ToolPlan {
  tool: ScanTool;
  bin: string;
  args: string[];
  env?: Record<string, string>;
  parse: (stdout: string) => ScanFinding[];
  /** Chiqish kodi `ok` hisoblanadigan (audit topilma bo'lsa nolga teng emas); parse natijasi bo'lsa har doim ok. */
  okCodes?: number[];
}

const cap = (s: string, n = SCAN_LIMITS.detailMaxChars): string => redact(s).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n);

export class ProjectScan {
  private readonly exec: ScanExec;
  private readonly fs: ScanFs;
  private readonly bin: (name: string) => string | undefined;
  private readonly now: () => number;

  constructor(private readonly d: ProjectScanDeps) {
    this.exec = d.exec ?? defaultScanExec;
    this.fs = d.fs ?? defaultScanFs;
    this.bin = d.resolveBin ?? resolveDefault;
    this.now = d.now ?? Date.now;
  }

  /** Ildizdan ekotizimlarni aniqlaydi (sof: faqat fayl mavjudligi/matni). */
  detect(root: string): { ecosystems: ScanEcosystem[]; has: (f: string) => boolean } {
    const has = (f: string): boolean => this.fs.exists(join(root, f));
    const eco: ScanEcosystem[] = [];
    if (has('package.json')) {
      if (has('pnpm-lock.yaml')) eco.push('pnpm');
      else if (has('yarn.lock')) eco.push('yarn');
      else eco.push('npm');
    }
    const files = this.fs.list(root).map((e) => e.name);
    if (files.some((n) => /^requirements.*\.txt$/.test(n)) || has('pyproject.toml') || has('Pipfile')) eco.push('python');
    if (has('pubspec.yaml')) eco.push(/^\s*flutter:\s*$/m.test(this.fs.readText(join(root, 'pubspec.yaml')) ?? '') && /sdk:\s*flutter/.test(this.fs.readText(join(root, 'pubspec.yaml')) ?? '') ? 'flutter' : 'dart');
    if (has('go.mod')) eco.push('go');
    return { ecosystems: eco, has };
  }

  private plans(root: string, eco: ScanEcosystem, has: (f: string) => boolean): Array<ToolPlan | { skip: ScanTool; detail: string }> {
    switch (eco) {
      case 'npm':
        if (!has('package-lock.json') && !has('npm-shrinkwrap.json')) return [{ skip: 'npm-audit', detail: 'package-lock.json not found' }];
        return [{ tool: 'npm-audit', bin: 'npm', args: ['audit', '--json', '--package-lock-only'], parse: (s) => parseNpmAudit(s, 'npm-audit') }];
      case 'pnpm':
        return [{ tool: 'pnpm-audit', bin: 'pnpm', args: ['audit', '--json'], parse: (s) => parseAdvisoriesMap(s, 'pnpm-audit') }];
      case 'yarn':
        return [{ tool: 'yarn-audit', bin: 'yarn', args: has('.yarnrc.yml') ? ['npm', 'audit', '--json'] : ['audit', '--json'], parse: parseYarnAudit }];
      case 'python': {
        const req = this.fs.list(root).map((e) => e.name).filter((n) => /^requirements[A-Za-z0-9._-]*\.txt$/.test(n)).sort()[0];
        if (!req) return [{ skip: 'pip-audit', detail: 'no requirements*.txt (pyproject-only projects are not built: read-only scan)' }];
        return [{ tool: 'pip-audit', bin: 'pip-audit', args: ['-f', 'json', '--progress-spinner', 'off', '-r', req], parse: parsePipAudit }];
      }
      case 'dart':
        return [{ tool: 'dart-outdated', bin: 'dart', args: ['pub', 'outdated', '--json'], parse: (s) => parsePubOutdated(s, 'dart-outdated') }];
      case 'flutter':
        return [{ tool: 'flutter-outdated', bin: 'flutter', args: ['pub', 'outdated', '--json'], parse: (s) => parsePubOutdated(s, 'flutter-outdated') }];
      case 'go':
        return [
          { tool: 'go-list-u', bin: 'go', args: ['list', '-m', '-u', '-json', 'all'], env: { GOFLAGS: '-mod=readonly' }, parse: parseGoListUpdates },
          { tool: 'govulncheck', bin: 'govulncheck', args: ['-json', './...'], env: { GOFLAGS: '-mod=readonly' }, parse: parseGovulncheck },
        ];
    }
  }

  private async runPlan(root: string, p: ToolPlan, deadline: number): Promise<{ run: ScanToolRun; findings: ScanFinding[] }> {
    const mk = (status: ScanToolStatus, detail: string, findings: ScanFinding[] = []): { run: ScanToolRun; findings: ScanFinding[] } => ({
      run: { tool: p.tool, status, detail: cap(detail), findings: findings.length },
      findings,
    });
    const left = deadline - this.now();
    if (left <= 1000) return mk('timeout', 'total scan time budget exhausted');
    const exe = this.bin(p.bin);
    if (!exe) return mk('skipped', `${p.bin} is not installed`);
    const r = await this.exec(exe, p.args, { cwd: root, timeoutMs: Math.min(SCAN_LIMITS.toolTimeoutMs, left), ...(p.env ? { env: p.env } : {}) });
    if (r.missing) return mk('skipped', `${p.bin} is not installed`);
    if (r.timedOut) return mk('timeout', `${p.bin} timed out`);
    if (r.overflow) return mk('failed', `${p.bin} output too large`);
    let findings: ScanFinding[] = [];
    try {
      findings = p.parse(r.stdout);
    } catch (err) {
      this.d.log.warn('scan parser xatosi', { tool: p.tool, error: errMsg(err).slice(0, 200) });
    }
    if (findings.length > 0 || r.code === 0) return mk('ok', findings.length === 0 ? 'no findings' : `${findings.length} findings`, findings);
    // Topilmasiz va nolga teng emas chiqish: audit xatosi (tarmoq, lock yo'q ...). stderr redakt qilinib qisqartiriladi.
    return mk('failed', `${p.bin} exit ${r.code ?? '?'}: ${r.stderr || r.stdout}`.slice(0, 400));
  }

  /** Kuzatiladigan fayllar (nisbiy, `/` bilan): `git ls-files -z`; git bo'lmasa chegaralangan yurish. Maxfiy papkalar (`~/.ssh` ...) HECH QACHON kirmaydi. */
  private async trackedFiles(root: string, deadline: number): Promise<string[]> {
    const lib = realPathOps.lib;
    const sens = (this.d.sensitive ?? sensitiveDirs()).map((x) => {
      try {
        return realPathOps.realpath(x);
      } catch {
        return x;
      }
    });
    const isSensitive = (abs: string): boolean => sens.some((x) => isInside(x, abs, lib, realPathOps.caseInsensitive));
    const git = this.bin('git');
    if (git && this.fs.exists(join(root, '.git'))) {
      const r = await this.exec(git, ['ls-files', '-z'], { cwd: root, timeoutMs: Math.min(30_000, Math.max(1000, deadline - this.now())) });
      if (r.code === 0 && !r.timedOut) return r.stdout.split('\0').filter((x) => x.length > 0 && !isSensitive(join(root, x)));
    }
    const out: string[] = [];
    const walk = (dir: string, depth: number): void => {
      if (depth > 8 || out.length >= SCAN_LIMITS.maxScanFiles * 2) return;
      for (const e of this.fs.list(dir)) {
        const abs = join(dir, e.name);
        if (isSensitive(abs)) continue;
        if (e.dir) {
          if (!WALK_SKIP.has(e.name) && !e.name.startsWith('.git')) walk(abs, depth + 1);
        } else out.push(relative(root, abs).split(sep).join('/'));
      }
    };
    walk(root, 0);
    return out;
  }

  private async secretScan(root: string, deadline: number): Promise<{ run: ScanToolRun; envRun: ScanToolRun; findings: ScanFinding[]; files: number }> {
    const findings: ScanFinding[] = [];
    const envFindings: ScanFinding[] = [];
    let files = 0;
    let truncated = false;
    const list = await this.trackedFiles(root, deadline);
    for (const f of list) {
      const env = envFileFinding(f);
      if (env) envFindings.push(env);
      if (shouldSkipFile(f) || env) continue; // .env faylining mazmuni O'QILMAYDI (faqat nomi)
      if (files >= SCAN_LIMITS.maxScanFiles || this.now() >= deadline) {
        truncated = true;
        break;
      }
      const h = this.fs.readHead(join(root, f), SCAN_LIMITS.maxScanFileBytes);
      if (!h || h.size > SCAN_LIMITS.maxScanFileBytes || looksBinary(h.head)) continue;
      files++;
      for (const hit of scanTextForSecrets(Buffer.from(h.head).toString('utf8'))) findings.push(secretFinding(f, hit));
    }
    const run: ScanToolRun = { tool: 'secret-scan', status: 'ok', detail: truncated ? `${files} files scanned (limit reached)` : `${files} files scanned`, findings: findings.length };
    const envRun: ScanToolRun = { tool: 'env-files', status: 'ok', detail: `${envFindings.length} tracked env/key files`, findings: envFindings.length };
    return { run, envRun, findings: [...findings, ...envFindings], files };
  }

  async scan(root: string): Promise<RunnerOutcome> {
    const started = this.now();
    const deadline = started + SCAN_LIMITS.totalTimeoutMs;
    try {
      const { ecosystems, has } = this.detect(root);
      const tools: ScanToolRun[] = [];
      let all: ScanFinding[] = [];
      for (const eco of ecosystems) {
        for (const p of this.plans(root, eco, has)) {
          if ('skip' in p) {
            tools.push({ tool: p.skip, status: 'skipped', detail: cap(p.detail), findings: 0 });
            continue;
          }
          const r = await this.runPlan(root, p, deadline);
          tools.push(r.run);
          all = all.concat(r.findings);
        }
      }
      const s = await this.secretScan(root, deadline);
      tools.push(s.run, s.envRun);
      all = all.concat(s.findings);

      const counts = emptyCounts();
      let vulnCount = 0;
      let outdatedCount = 0;
      let secretCount = 0;
      let envFileCount = 0;
      for (const f of all) {
        if (f.kind === 'outdated') {
          outdatedCount++;
          continue;
        }
        counts[f.severity]++;
        if (f.kind === 'vulnerability') vulnCount++;
        else if (f.kind === 'secret') secretCount++;
        else envFileCount++;
      }
      const sorted = sortFindings(all);
      const result: ScanResult = {
        ecosystems,
        tools: tools.slice(0, 10),
        counts,
        vulnCount,
        outdatedCount,
        secretCount,
        envFileCount,
        findings: sorted.slice(0, SCAN_LIMITS.maxFindings),
        findingsTotal: all.length,
        truncated: sorted.length > SCAN_LIMITS.maxFindings,
        filesScanned: s.files,
        durationMs: Math.max(0, this.now() - started),
      };
      const checked = ScanResultSchema.safeParse(result);
      if (!checked.success) return { ok: false, code: 'scan_failed', message: 'scan produced an invalid result' };
      return { ok: true, result: { detail: `${vulnCount} vuln, ${secretCount} secrets, ${envFileCount} env files, ${outdatedCount} outdated`, scan: checked.data } };
    } catch (err) {
      this.d.log.warn('project.scan xatosi', { error: errMsg(err).slice(0, 200) });
      return { ok: false, code: 'scan_failed', message: 'scan failed' };
    }
  }
}
