import { execFile } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { PROJECT_SNAPSHOT_LIMITS, normalizeRepoKey, type ProjectCommit } from '@commander/contracts';
import { redactShapes } from './redact.js';
import { safeExecEnv, trustedBin } from './trusted-bin.js';

/**
 * Git ma'lumotlari (task 2.1). Ikki qatlam:
 *  1. Sof fayl o'qish (`.git/HEAD`, ref fayli, `packed-refs`): git jarayonisiz branch + HEAD sha (HEAD o'zgarishini
 *     arzon kuzatish va git yo'q/ishlamaydigan mashinada zaxira).
 *  2. `git` jarayoni (shell'siz, qat'iy argumentlar, taymaut): status, log, remote.
 * Faqat loyiha ildizi ichida o'qiydi/ishga tushiradi (`cwd = root`).
 */

export interface GitRunner {
  (cwd: string, args: readonly string[], opts?: { timeoutMs?: number; maxBuffer?: number }): Promise<string>;
}

export const GIT_TIMEOUT_MS = 10_000;
export const GIT_STATUS_TIMEOUT_MS = 15_000;
const GIT_MAX_BUFFER = 4 * 1024 * 1024;

export const runGit: GitRunner = (cwd, args, opts) =>
  new Promise((resolveP, reject) => {
    // M-18: absolyut yo'l (ishonchli PATH, startda); bare `git` Windows'da repo-lokal `git.exe` ga olib borardi.
    const gitBin = trustedBin('git');
    if (!gitBin) return reject(new Error('git not found in the trusted PATH'));
    execFile(
      gitBin,
      ['-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', '-c', 'protocol.ext.allow=never', ...args],
      {
        cwd,
        timeout: opts?.timeoutMs ?? GIT_TIMEOUT_MS,
        maxBuffer: opts?.maxBuffer ?? GIT_MAX_BUFFER,
        windowsHide: true,
        env: safeExecEnv(process.env, { LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat' }),
      },
      (err, stdout) => {
        if (err) reject(err);
        else resolveP(stdout);
      },
    );
  });

// --- fayl asosidagi o'qish -------------------------------------------------------------------

/** `.git` papkasi (yoki worktree/submodule faylidagi `gitdir:`). Yo'q bo'lsa `null`. */
export function resolveGitDir(root: string): string | null {
  const dotGit = join(root, '.git');
  let st;
  try {
    st = lstatSync(dotGit);
  } catch {
    return null;
  }
  if (st.isDirectory()) return dotGit;
  if (!st.isFile()) return null;
  try {
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'));
    if (!m) return null;
    const p = m[1]!.trim();
    return isAbsolute(p) ? p : resolve(root, p);
  } catch {
    return null;
  }
}

export interface HeadInfo {
  branch: string | null;
  sha: string | null;
  /** HEAD o'zgarganini aniqlash uchun barqaror iz. */
  fingerprint: string;
}

const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

function readCommonDir(gitDir: string): string {
  try {
    const rel = readFileSync(join(gitDir, 'commondir'), 'utf8').trim();
    return rel ? (isAbsolute(rel) ? rel : resolve(gitDir, rel)) : gitDir;
  } catch {
    return gitDir;
  }
}

function readRef(gitDir: string, ref: string): string | null {
  if (!/^refs\/[A-Za-z0-9._/@+-]+$/.test(ref) || ref.includes('..')) return null;
  const common = readCommonDir(gitDir);
  for (const dir of common === gitDir ? [gitDir] : [gitDir, common]) {
    try {
      const v = readFileSync(join(dir, ref), 'utf8').trim();
      if (SHA_RE.test(v)) return v;
    } catch {
      /* loose ref yo'q: packed-refs'ga o'tamiz */
    }
    try {
      for (const line of readFileSync(join(dir, 'packed-refs'), 'utf8').split('\n')) {
        if (line.startsWith('#') || line.startsWith('^')) continue;
        const [sha, name] = line.trim().split(' ');
        if (name === ref && sha && SHA_RE.test(sha)) return sha;
      }
    } catch {
      /* packed-refs yo'q */
    }
  }
  return null;
}

/** Git jarayonisiz HEAD: branch, sha, iz. `.git` yo'q yoki o'qib bo'lmasa `null`. */
export function readHead(root: string): HeadInfo | null {
  const gitDir = resolveGitDir(root);
  if (!gitDir) return null;
  let head: string;
  try {
    head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
  } catch {
    return null;
  }
  const m = /^ref:\s*(.+)$/.exec(head);
  if (m) {
    const ref = m[1]!.trim();
    const branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null;
    const sha = readRef(gitDir, ref);
    return { branch, sha, fingerprint: `${ref}@${sha ?? ''}` };
  }
  return { branch: null, sha: SHA_RE.test(head) ? head : null, fingerprint: `detached@${head.slice(0, 64)}` };
}

export const isGitRoot = (root: string): boolean => existsSync(join(root, '.git'));

// --- git jarayoni -----------------------------------------------------------------------------

export interface GitStatus {
  branch: string | null;
  headSha: string | null;
  dirtyCount: number;
  ahead: number | null;
  behind: number | null;
}

/** `git status --porcelain=v2 --branch -z` chiqishini ajratadi (sof funksiya: testlanadi). */
export function parseStatusV2(out: string): GitStatus {
  const status: GitStatus = { branch: null, headSha: null, dirtyCount: 0, ahead: null, behind: null };
  const tokens = out.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (!t) continue;
    if (t.startsWith('# branch.head ')) {
      const b = t.slice('# branch.head '.length).trim();
      status.branch = b && b !== '(detached)' ? b : null;
    } else if (t.startsWith('# branch.oid ')) {
      const o = t.slice('# branch.oid '.length).trim();
      status.headSha = SHA_RE.test(o) ? o : null;
    } else if (t.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(t);
      if (m) {
        status.ahead = Number(m[1]);
        status.behind = Number(m[2]);
      }
    } else if (t.startsWith('# ')) {
      continue;
    } else if (t.startsWith('2 ')) {
      status.dirtyCount += 1;
      i += 1; // rename/copy: keyingi token asl yo'l
    } else if (t.startsWith('1 ') || t.startsWith('u ') || t.startsWith('? ')) {
      status.dirtyCount += 1;
    }
  }
  return status;
}

const EMAIL_RE = /<?[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>?/g;

/** Muallif: FAQAT ism. Ism ichida email bo'lsa (`user.name = a@b.com`) olib tashlanadi. */
export function authorNameOnly(raw: string): string {
  const name = raw.slice(0, 512).replace(EMAIL_RE, '').replace(/\s+/g, ' ').trim();
  return (name || 'unknown').slice(0, PROJECT_SNAPSHOT_LIMITS.maxAuthorLen);
}

export const GIT_LOG_FORMAT = '%H%x1f%an%x1f%at%x1f%s%x1e';

/** `git log` chiqishi -> commitlar (sarlavha ≤200, faqat aniq sir shakllari maskalanadi, muallif ismi). */
export function parseGitLog(out: string): ProjectCommit[] {
  const commits: ProjectCommit[] = [];
  for (const record of out.split('\x1e')) {
    const r = record.replace(/^\s+/, '');
    if (!r) continue;
    const parts = r.split('\x1f');
    if (parts.length < 4) continue;
    const [sha, author, at, ...rest] = parts as [string, string, string, ...string[]];
    const ts = Number.parseInt(at, 10) * 1000;
    if (!/^[0-9a-f]{7,64}$/.test(sha) || !Number.isFinite(ts) || ts < 0) continue;
    const subject = redactShapes(rest.join('\x1f').trim()).slice(0, PROJECT_SNAPSHOT_LIMITS.maxSubjectLen);
    commits.push({ sha, subject, author: authorNameOnly(author), ts });
    if (commits.length >= PROJECT_SNAPSHOT_LIMITS.maxCommits) break;
  }
  return commits;
}

export interface GitInfo {
  branch: string | null;
  headSha: string | null;
  dirtyCount: number | null;
  ahead: number | null;
  behind: number | null;
  commits: ProjectCommit[];
  repoKey: string | null;
  /** `git status` taymautga uchradi (katta repo): chaqiruvchi shu repo uchun status'ni vaqtincha o'tkazib yuboradi. */
  statusTimedOut: boolean;
}

function isTimeout(err: unknown): boolean {
  const e = err as { killed?: boolean; code?: string; signal?: string } | null;
  return e?.killed === true || e?.signal === 'SIGTERM' || e?.code === 'ETIMEDOUT' || e?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
}

/**
 * To'liq git ma'lumoti. Har bir git chaqiruvi mustaqil: biri yiqilsa qolganlari ishlaydi; HEAD (branch/sha) fayldan to'ldiriladi.
 * `skipStatus` = katta repo orqaga chekinishi (status taymaut bergan).
 */
export async function collectGitInfo(root: string, opts: { git?: GitRunner; skipStatus?: boolean } = {}): Promise<GitInfo> {
  const git = opts.git ?? runGit;
  const fileHead = readHead(root);
  const info: GitInfo = {
    branch: fileHead?.branch ?? null,
    headSha: fileHead?.sha ?? null,
    dirtyCount: null,
    ahead: null,
    behind: null,
    commits: [],
    repoKey: null,
    statusTimedOut: false,
  };

  if (!opts.skipStatus) {
    try {
      const out = await git(root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal'], { timeoutMs: GIT_STATUS_TIMEOUT_MS });
      const s = parseStatusV2(out);
      info.branch = s.branch ?? info.branch;
      info.headSha = s.headSha ?? info.headSha;
      info.dirtyCount = s.dirtyCount;
      info.ahead = s.ahead;
      info.behind = s.behind;
    } catch (err) {
      info.statusTimedOut = isTimeout(err);
    }
  }
  try {
    const out = await git(root, ['log', '--no-color', '--no-ext-diff', `--max-count=${PROJECT_SNAPSHOT_LIMITS.maxCommits}`, `--format=${GIT_LOG_FORMAT}`]);
    info.commits = parseGitLog(out);
  } catch {
    /* commit'siz repo yoki git xatosi */
  }
  try {
    const out = await git(root, ['config', '--get', 'remote.origin.url']);
    info.repoKey = normalizeRepoKey(out.trim());
  } catch {
    /* origin yo'q */
  }
  return info;
}
