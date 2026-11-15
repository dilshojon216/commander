import { GIT_OPS_LIMITS, SHA_RE } from '@commander/contracts';
import type { DiffFile, DiffPayload, DiffResult } from '@commander/contracts';
import { GIT_STATUS_TIMEOUT_MS, isGitRoot, readHead, runGit } from './git-info.js';
import type { GitRunner } from './git-info.js';
import { trimTrailingReplacement } from './project-files.js';
import { redact } from './redact.js';

/**
 * `project.diff` (task 3.5): loyiha ildizi ichida `git diff` (shell'siz, qat'iy argumentlar, rangsiz, tashqi diff vositasisiz),
 * natija redakt qilinadi va kesiladi. Faqat O'QISH: hech narsa o'zgartirilmaydi.
 *
 * Xavfsizlik:
 *  - bayroqlar: `-c core.pager=cat -c diff.external= --no-ext-diff --no-textconv --no-color` (foydalanuvchi sozlamalari/filtrlari ishlamaydi);
 *  - baza FAQAT tekshirilgan to'liq sha'ga aylantirilib beriladi (`HEAD` | sha | merge-base:<branch>), argument hech qachon `-` bilan boshlanmaydi;
 *  - kuzatilmayotgan (untracked) fayllar FAQAT nomi bilan ro'yxatlanadi (kontent va binar yo'q);
 *  - maxfiy fayllar (`.env*`, kalitlar, sertifikatlar) patch'i yo'q (faqat nomi va +/-);
 *  - binar fayllar patch'siz; har fayl <= 24 KB, umumiy <= maxBytes (default 192 KB).
 */

export type DiffFailure = { ok: false; code: 'not_a_git_repo' | 'base_invalid' | 'git_failed'; message: string };
export type DiffOutcome = { ok: true; result: DiffResult } | DiffFailure;

const PATCH_MAX_BUFFER = 6 * 1024 * 1024;
const STAT_MAX_BUFFER = 4 * 1024 * 1024;
const TRUNC_NOTE = '\n… (kesildi)\n';

/** Barcha diff chaqiruvlariga umumiy bayroqlar (sof). `diff` subcommand shundan keyin keladi. */
export const DIFF_GLOBAL_FLAGS: readonly string[] = ['-c', 'core.pager=cat', '-c', 'diff.external=', '-c', 'core.quotepath=off'];
export const DIFF_COMMON_FLAGS: readonly string[] = ['--no-ext-diff', '--no-textconv', '--no-color', '-M'];

export type DiffMode = 'numstat' | 'name-status' | 'patch';

/** `git diff` argumentlari (sof, shell'siz). `sha` = ALLAQACHON tekshirilgan to'liq/qisqa hex. */
export function buildDiffArgs(mode: DiffMode, sha: string): string[] {
  if (!SHA_RE.test(sha)) throw new Error('diff base must be a hex sha');
  const modeFlags = mode === 'numstat' ? ['--numstat', '-z'] : mode === 'name-status' ? ['--name-status', '-z'] : ['-U3'];
  return [...DIFF_GLOBAL_FLAGS, 'diff', ...DIFF_COMMON_FLAGS, ...modeFlags, sha, '--'];
}

// --- maxfiy fayllar ---------------------------------------------------------------------------

const SECRET_BASENAME_RES: RegExp[] = [
  /^\.env(?:\..+)?$/i,
  /^\.(?:npmrc|netrc|pgpass|git-credentials|htpasswd)$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\..+)?$/i,
  /\.(?:pem|key|p12|pfx|jks|keystore|kdbx|ppk|asc|gpg)$/i,
  /^(?:credentials|secrets?)(?:\.[a-z0-9]+)?$/i,
  /^service[-_]?account.*\.json$/i,
];
const ENV_TEMPLATE_RE = /^\.env\.(?:example|sample|template|dist|defaults?)$/i;
const SECRET_DIRS = new Set(['.ssh', '.aws', '.gnupg', '.kube', '.docker']);

/** Maxfiy bo'lishi mumkin bo'lgan fayl: diff'ida matn ko'rsatilmaydi. */
export function isSecretPath(path: string): boolean {
  const parts = path.split('/');
  const base = parts[parts.length - 1] ?? path;
  if (ENV_TEMPLATE_RE.test(base)) return false;
  if (parts.slice(0, -1).some((d) => SECRET_DIRS.has(d))) return true;
  return SECRET_BASENAME_RES.some((re) => re.test(base));
}

// --- parserlar --------------------------------------------------------------------------------

export interface StatEntry {
  path: string;
  oldPath: string | null;
  status: DiffFile['status'];
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

const STATUS_BY_LETTER: Record<string, DiffFile['status']> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', T: 'typechange' };

/** `git diff --name-status -z`: `M\0path\0`, `R100\0old\0new\0`. Noma'lum holat (`U`, `X`) `modified`. */
export function parseNameStatus(out: string): Array<{ path: string; oldPath: string | null; status: DiffFile['status'] }> {
  const t = out.split('\0');
  const res: Array<{ path: string; oldPath: string | null; status: DiffFile['status'] }> = [];
  for (let i = 0; i < t.length; ) {
    const code = t[i++];
    if (!code) continue;
    const letter = code[0]!;
    const status = STATUS_BY_LETTER[letter] ?? 'modified';
    if (letter === 'R' || letter === 'C') {
      const oldPath = t[i++];
      const path = t[i++];
      if (oldPath === undefined || path === undefined) break;
      res.push({ path, oldPath, status });
    } else {
      const path = t[i++];
      if (path === undefined) break;
      res.push({ path, oldPath: null, status });
    }
  }
  return res;
}

/** `git diff --numstat -z`: `adds\tdels\tpath\0` va rename: `adds\tdels\t\0old\0new\0`. Binar: `-\t-`. */
export function parseNumstat(out: string): Array<{ path: string; additions: number | null; deletions: number | null; binary: boolean }> {
  const t = out.split('\0');
  const res: Array<{ path: string; additions: number | null; deletions: number | null; binary: boolean }> = [];
  for (let i = 0; i < t.length; ) {
    const rec = t[i++];
    if (!rec) continue;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(rec);
    if (!m) continue;
    const binary = m[1] === '-' || m[2] === '-';
    let path = m[3]!;
    if (path === '') {
      i++; // eski yo'l
      path = t[i++] ?? '';
    }
    res.push({ path, additions: binary ? null : Number(m[1]), deletions: binary ? null : Number(m[2]), binary });
  }
  return res;
}

/** name-status va numstat ro'yxatlarini (yo'l bo'yicha) birlashtiradi. */
export function mergeStats(ns: ReturnType<typeof parseNameStatus>, num: ReturnType<typeof parseNumstat>): StatEntry[] {
  const numBy = new Map(num.map((n) => [n.path, n]));
  return ns.map((f) => {
    const n = numBy.get(f.path);
    return { path: f.path, oldPath: f.oldPath, status: f.status, additions: n?.additions ?? null, deletions: n?.deletions ?? null, binary: n?.binary ?? false };
  });
}

/** Yagona `git diff` chiqishini `diff --git` bloklariga bo'ladi (tartib git'ning fayl tartibi bilan bir xil). */
export function splitPatchBlocks(patch: string): string[] {
  const blocks: string[] = [];
  let cur: string[] | null = null;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      if (cur) blocks.push(cur.join('\n'));
      cur = [line];
    } else if (cur) cur.push(line);
  }
  if (cur) blocks.push(cur.join('\n'));
  return blocks;
}

const byteLen = (s: string): number => Buffer.byteLength(s, 'utf8');

/** `text` ni `maxBytes` ga qator chegarasida kesadi. */
export function capBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (byteLen(text) <= maxBytes) return { text, truncated: false };
  let out = '';
  let used = 0;
  for (const line of text.split('\n')) {
    const add = byteLen(line) + 1;
    if (used + add > maxBytes) break;
    out += `${line}\n`;
    used += add;
  }
  if (out === '') out = trimTrailingReplacement(Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8'));
  return { text: out + TRUNC_NOTE, truncated: true };
}

export interface AssembleOptions {
  maxBytes: number;
  statOnly: boolean;
}

/** Statistika + patch bloklaridan fayl ro'yxatini yig'adi (redakt, kesish, byudjet). Sof. */
export function assembleFiles(stats: readonly StatEntry[], blocks: readonly string[], opts: AssembleOptions): { files: DiffFile[]; bytes: number; truncated: boolean } {
  const files: DiffFile[] = [];
  let bytes = 0;
  let truncated = stats.length > GIT_OPS_LIMITS.maxFiles;
  stats.slice(0, GIT_OPS_LIMITS.maxFiles).forEach((s, i) => {
    const base = { path: s.path.slice(0, GIT_OPS_LIMITS.pathMaxChars), oldPath: s.oldPath ? s.oldPath.slice(0, GIT_OPS_LIMITS.pathMaxChars) : null, status: s.status, additions: s.additions, deletions: s.deletions, binary: s.binary };
    const hide = (hidden: NonNullable<DiffFile['hidden']>, trunc = false): void => {
      files.push({ ...base, patch: null, truncated: trunc, hidden });
    };
    if (opts.statOnly) return hide('stat_only');
    if (isSecretPath(s.path) || (s.oldPath !== null && isSecretPath(s.oldPath))) return hide('secret');
    if (s.binary) return hide('binary');
    const block = blocks[i];
    if (block === undefined) {
      truncated = true;
      return hide('budget', true);
    }
    const remaining = opts.maxBytes - bytes;
    if (remaining <= 0) {
      truncated = true;
      return hide('budget', true);
    }
    const redacted = redact(block);
    const capped = capBytes(redacted, Math.min(GIT_OPS_LIMITS.perFileMaxBytes, remaining));
    if (capped.truncated) truncated = true;
    bytes += byteLen(capped.text);
    files.push({ ...base, patch: capped.text, truncated: capped.truncated, hidden: null });
  });
  return { files, bytes, truncated };
}

// --- yig'ish ----------------------------------------------------------------------------------

const errCode = (err: unknown): string | undefined => (err as { code?: string } | null)?.code;

/**
 * Bazani to'liq sha'ga aylantiradi: `HEAD` | sha | `merge-base:<branch>` (avval `<branch>`, so'ng `origin/<branch>`).
 * Topilmasa `null`.
 */
export async function resolveBase(root: string, base: string, git: GitRunner): Promise<string | null> {
  const one = async (args: string[]): Promise<string | null> => {
    try {
      const out = (await git(root, args)).trim();
      return SHA_RE.test(out) ? out : null;
    } catch {
      return null;
    }
  };
  if (base === 'HEAD') return one(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  if (SHA_RE.test(base)) return one(['rev-parse', '--verify', '--quiet', `${base}^{commit}`]);
  if (base.startsWith('merge-base:')) {
    const branch = base.slice('merge-base:'.length);
    return (await one(['merge-base', 'HEAD', branch])) ?? (await one(['merge-base', 'HEAD', `origin/${branch}`]));
  }
  return null;
}

export interface CollectDiffOptions {
  git?: GitRunner;
}

/** `project.diff` bajarilishi (siyosat va ildiz ALLAQACHON tekshirilgan). */
export async function collectDiff(root: string, p: Pick<DiffPayload, 'base' | 'maxBytes' | 'statOnly'>, opts: CollectDiffOptions = {}): Promise<DiffOutcome> {
  const git = opts.git ?? runGit;
  if (!isGitRoot(root)) return { ok: false, code: 'not_a_git_repo', message: 'The project is not a git repository' };
  const requested = p.base ?? 'HEAD';
  const baseSha = await resolveBase(root, requested, git);
  if (!baseSha) return { ok: false, code: 'base_invalid', message: 'The diff base could not be resolved to a commit' };
  const maxBytes = Math.min(p.maxBytes ?? GIT_OPS_LIMITS.diffMaxBytes, GIT_OPS_LIMITS.diffMaxBytes);
  const statOnly = p.statOnly === true;

  let stats: StatEntry[];
  try {
    const [nsOut, numOut] = await Promise.all([
      git(root, buildDiffArgs('name-status', baseSha), { timeoutMs: GIT_STATUS_TIMEOUT_MS, maxBuffer: STAT_MAX_BUFFER }),
      git(root, buildDiffArgs('numstat', baseSha), { timeoutMs: GIT_STATUS_TIMEOUT_MS, maxBuffer: STAT_MAX_BUFFER }),
    ]);
    stats = mergeStats(parseNameStatus(nsOut), parseNumstat(numOut));
  } catch {
    return { ok: false, code: 'git_failed', message: 'git diff --stat failed' };
  }

  let blocks: string[] = [];
  let patchTruncated = false;
  if (!statOnly && stats.length > 0) {
    try {
      blocks = splitPatchBlocks(await git(root, buildDiffArgs('patch', baseSha), { timeoutMs: GIT_STATUS_TIMEOUT_MS * 2, maxBuffer: PATCH_MAX_BUFFER }));
    } catch (err) {
      // Juda katta diff (maxBuffer) yoki taymaut: patch'siz, faqat statistika (`budget`)
      if (errCode(err) !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return { ok: false, code: 'git_failed', message: 'git diff failed' };
      patchTruncated = true;
    }
  }
  const asm = assembleFiles(stats, blocks, { maxBytes, statOnly });

  let untracked: string[] = [];
  let untrackedTotal = 0;
  try {
    const out = await git(root, ['ls-files', '--others', '--exclude-standard', '-z'], { timeoutMs: GIT_STATUS_TIMEOUT_MS, maxBuffer: STAT_MAX_BUFFER });
    const all = out.split('\0').filter((x) => x.length > 0);
    untrackedTotal = all.length;
    untracked = all.slice(0, GIT_OPS_LIMITS.maxUntracked).map((x) => x.slice(0, GIT_OPS_LIMITS.pathMaxChars));
  } catch {
    /* untracked ro'yxati ixtiyoriy */
  }

  const head = readHead(root);
  const result: DiffResult = {
    base: requested,
    baseSha,
    headSha: head?.sha ?? null,
    branch: head?.branch ?? null,
    files: asm.files,
    filesTotal: stats.length,
    totalAdditions: stats.reduce((a, s) => a + (s.additions ?? 0), 0),
    totalDeletions: stats.reduce((a, s) => a + (s.deletions ?? 0), 0),
    untracked,
    untrackedTotal,
    bytes: asm.bytes,
    truncated: asm.truncated || patchTruncated || untrackedTotal > untracked.length,
  };
  return { ok: true, result };
}
