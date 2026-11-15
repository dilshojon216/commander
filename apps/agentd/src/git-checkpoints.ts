import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CHECKPOINT_LIMITS, CHECKPOINT_REF_PREFIX, CHECKPOINT_LABEL_RE, SHA_RE, checkpointSlug, checkpointStamp, isCheckpointRef } from '@commander/contracts';
import type {
  CheckpointInfo,
  CheckpointListResult,
  CheckpointPayload,
  CheckpointRestoreResult,
  CheckpointResult,
  CheckpointRestorePayload,
  CommandErrorCode,
} from '@commander/contracts';
import { isSecretPath } from './git-diff.js';
import { readHead } from './git-info.js';
import { errMsg, type Logger } from './logger.js';
import type { RunnerOutcome } from './runner.js';
import { safeExecEnv, trustedBin } from './trusted-bin.js';

/**
 * Git checkpoint'lar (task 6.9). Ishchi daraxtga, indeksga, HEAD'ga va branch'larga TEGMAYDI (faqat `.git` ichiga ob'ektlar va
 * `refs/commander/checkpoints/*` ref'i qo'shiladi).
 *
 * Checkpoint commit'i `git stash create` formatida: tree = ishchi daraxt holati, ota-onalar = [HEAD, indeks commit'i]
 * (shu sabab `git stash apply <sha>` ham ishlaydi). `git stash create` KUZATILMAYOTGAN fayllarni olmaydi; biz VAQTINCHALIK indeks
 * (`GIT_INDEX_FILE`, haqiqiy indeksning nusxasi) bilan olamiz: `git add -u` (tracked o'zgarishlar va o'chirishlar) + `.gitignore` bilan
 * ignor qilinmagan kuzatilmayotgan fayllar (`update-index --add`), shuning uchun haqiqiy indeks hech qachon o'zgarmaydi.
 * Maxfiy fayllar (`.env*`, kalit/sertifikat, `.ssh/` ...) va katta (> 5 MB) fayllar kuzatilmayotganlardan TASHLANADI (ob'ekt bazasiga
 * sir tushmasin); ular qaytarishda ham o'zgarmaydi.
 *
 * Qaytarish (`restore`): (1) tekshiruv: ref FAQAT `refs/commander/checkpoints/<ts>-<slug>` va Commander markeri bor commit; branch
 * checkpoint paytidagi bilan bir xil; HEAD o'sha commit yoki uning avlodi (aks holda `head_diverged`); unmerged yo'q;
 * (2) HAR DOIM avtomatik "pre-restore" checkpoint (hozirgi holat saqlanadi, qaytarishni bekor qilish mumkin);
 * (3) `reset --hard <checkpoint HEAD>` (branch ko'rsatkichi orqaga suriladi; olib tashlangan commitlar pre-restore ref'i orqali
 * erishiladigan bo'lib qoladi), (4) `checkout <checkpoint> -- .` (ishchi daraxt+indeks), (5) checkpoint paytida o'chirilgan tracked
 * fayllarni o'chirish, (6) `read-tree <saqlangan indeks>` (staged/unstaged farqi tiklanadi). Checkpoint'dan KEYIN yaratilgan
 * kuzatilmayotgan fayllarga tegilmaydi. Branch o'chirilmaydi, push/force YO'Q.
 */

export interface GitExecOpts {
  env?: Record<string, string>;
  input?: string;
  timeoutMs?: number;
  maxBuffer?: number;
}

/** `git` ni shell'siz ishga tushiradi: stdout (matn) qaytaradi; chiqish kodi != 0 bo'lsa throw (xato matnida stderr boshi). */
export type GitExec = (cwd: string, args: readonly string[], opts?: GitExecOpts) => Promise<string>;

export const defaultGitExec: GitExec = (cwd, args, opts) =>
  new Promise((resolve, reject) => {
    const bin = trustedBin('git');
    if (!bin) return reject(new Error('git not found in the trusted PATH'));
    const child = spawn(bin, ['-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', '-c', 'protocol.ext.allow=never', '-c', 'commit.gpgsign=false', '-c', 'gc.auto=0', ...args], {
      cwd,
      env: safeExecEnv(process.env, { LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', ...(opts?.env ?? {}) }),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const max = opts?.maxBuffer ?? 8 * 1024 * 1024;
    const out: Buffer[] = [];
    let size = 0;
    let err = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, opts?.timeoutMs ?? 60_000);
    child.stdout.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) {
        killed = true;
        child.kill('SIGKILL');
      } else out.push(c);
    });
    child.stderr.on('data', (c: Buffer) => {
      if (err.length < 2000) err += c.toString('utf8');
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) return reject(new Error('git timed out or produced too much output'));
      if (code === 0) return resolve(Buffer.concat(out).toString('utf8'));
      reject(Object.assign(new Error(`git ${args[0] ?? ''} failed (${code}): ${err.trim().split('\n')[0]?.slice(0, 200) ?? ''}`), { exitCode: code }));
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(opts?.input ?? '');
  });

export interface GitCheckpointsDeps {
  log: Logger;
  git?: GitExec;
  now?: () => Date;
  /** Testlar uchun: vaqtinchalik papka. */
  tmp?: string;
}

const fail = (code: CommandErrorCode, message: string): RunnerOutcome => ({ ok: false, code, message });
const MARKER = 'Commander-Checkpoint: 1';
const AUTHOR_ENV = { GIT_AUTHOR_NAME: 'Commander', GIT_AUTHOR_EMAIL: 'commander@localhost', GIT_COMMITTER_NAME: 'Commander', GIT_COMMITTER_EMAIL: 'commander@localhost' };
const ZERO = (len: number): string => '0'.repeat(len);

class CheckpointError extends Error {
  constructor(
    readonly code: CommandErrorCode,
    message: string,
  ) {
    super(message);
  }
}

interface ParsedCheckpoint {
  info: CheckpointInfo;
  parents: string[];
  wtTree: string;
  idxTree: string;
}

/** `git cat-file commit` matni -> checkpoint maydonlari (sof). Marker yoki maydon yaroqsiz bo'lsa `null`. */
export function parseCheckpointCommit(ref: string, sha: string, raw: string): Omit<ParsedCheckpoint, 'idxTree'> | null {
  const sep = raw.indexOf('\n\n');
  if (sep < 0) return null;
  const header = raw.slice(0, sep).split('\n');
  const body = raw.slice(sep + 2).split('\n');
  if (!body.includes(MARKER)) return null;
  const field = (name: string): string | undefined => body.find((l) => l.startsWith(`${name}: `))?.slice(name.length + 2).trim();
  const tree = header.find((l) => l.startsWith('tree '))?.slice(5).trim() ?? '';
  const parents = header.filter((l) => l.startsWith('parent ')).map((l) => l.slice(7).trim());
  const committer = header.find((l) => l.startsWith('committer '));
  const ts = committer ? /\s(\d{9,11})\s[+-]\d{4}$/.exec(committer)?.[1] : undefined;
  const head = field('Head') ?? '';
  const label = field('Label') ?? '';
  const branch = field('Branch');
  const untracked = Number(field('Untracked') ?? '0');
  if (!SHA_RE.test(tree) || !SHA_RE.test(head) || parents[0] !== head || parents.length < 2 || !ts || !CHECKPOINT_LABEL_RE.test(label) || !Number.isInteger(untracked) || untracked < 0) return null;
  return {
    info: {
      ref,
      sha,
      label,
      createdAt: new Date(Number(ts) * 1000).toISOString(),
      headSha: head,
      branch: branch && branch !== '(detached)' ? branch.slice(0, 200) : null,
      auto: field('Auto') === 'true',
      untracked,
    },
    parents,
    wtTree: tree,
  };
}

export class GitCheckpoints {
  private readonly git: GitExec;
  private readonly now: () => Date;

  constructor(private readonly d: GitCheckpointsDeps) {
    this.git = d.git ?? defaultGitExec;
    this.now = d.now ?? (() => new Date());
  }

  private async g(root: string, args: readonly string[], opts?: GitExecOpts): Promise<string> {
    return this.git(root, args, opts);
  }

  private async tryG(root: string, args: readonly string[], opts?: GitExecOpts): Promise<string | null> {
    try {
      return await this.git(root, args, opts);
    } catch {
      return null;
    }
  }

  private async revParse(root: string, spec: string): Promise<string | null> {
    const out = (await this.tryG(root, ['rev-parse', '--verify', '--quiet', spec]))?.trim() ?? '';
    return SHA_RE.test(out) ? out : null;
  }

  // --- create ---------------------------------------------------------------------------------

  async create(p: CheckpointPayload): Promise<RunnerOutcome> {
    try {
      const r = await this.createInner(p.root, p.label, p.auto === true);
      return { ok: true, result: { checkpoint: r, detail: `${r.checkpoint.ref.slice(CHECKPOINT_REF_PREFIX.length)}${r.clean ? ' (clean)' : ''}`.slice(0, 200) } };
    } catch (err) {
      return this.toOutcome(err, 'checkpoint failed');
    }
  }

  private toOutcome(err: unknown, fallback: string): RunnerOutcome {
    if (err instanceof CheckpointError) return fail(err.code, err.message);
    this.d.log.warn('checkpoint xatosi', { error: errMsg(err).slice(0, 200) });
    return fail('checkpoint_failed', `${fallback}: ${errMsg(err).slice(0, 150)}`);
  }

  private async createInner(root: string, label: string, auto: boolean): Promise<CheckpointResult> {
    if (!CHECKPOINT_LABEL_RE.test(label)) throw new CheckpointError('invalid_payload', 'invalid checkpoint label');
    const head = await this.revParse(root, 'HEAD^{commit}');
    if (!head) throw new CheckpointError('no_commits', 'The repository has no commits yet (nothing to anchor the checkpoint to)');
    const headTree = await this.revParse(root, 'HEAD^{tree}');
    const branch = readHead(root)?.branch ?? null;
    const realIndexRel = (await this.g(root, ['rev-parse', '--git-path', 'index'])).trim();
    const realIndex = path.resolve(root, realIndexRel);

    // haqiqiy indeks daraxti (staged holat): faqat ob'ekt yoziladi, indeks o'zgarmaydi
    let idxTree: string;
    try {
      idxTree = (await this.g(root, ['write-tree'])).trim();
    } catch {
      throw new CheckpointError('checkpoint_failed', 'The index has unmerged paths (resolve the merge/rebase first)');
    }

    const tmpDir = mkdtempSync(path.join(this.d.tmp ?? tmpdir(), 'commander-ckpt-'));
    try {
      const tmpIndex = path.join(tmpDir, 'index');
      const env = { GIT_INDEX_FILE: tmpIndex };
      if (existsSync(realIndex)) copyFileSync(realIndex, tmpIndex);
      else await this.g(root, ['read-tree', head], { env });
      await this.g(root, ['add', '--update'], { env, timeoutMs: 120_000 });

      // kuzatilmayotgan fayllar: ignor qilinmaganlari, maxfiy/katta emas
      const others = (await this.g(root, ['ls-files', '--others', '--exclude-standard', '-z'], { maxBuffer: 16 * 1024 * 1024 })).split('\0').filter((x) => x.length > 0);
      const keep: string[] = [];
      let skipped = 0;
      for (const f of others) {
        if (f.endsWith('/') || isSecretPath(f)) {
          skipped++;
          continue;
        }
        let st;
        try {
          st = lstatSync(path.join(root, f));
        } catch {
          continue;
        }
        if ((!st.isFile() && !st.isSymbolicLink()) || st.size > CHECKPOINT_LIMITS.untrackedMaxBytes || keep.length >= CHECKPOINT_LIMITS.untrackedMaxFiles) {
          skipped++;
          continue;
        }
        keep.push(f);
      }
      if (keep.length > 0) await this.g(root, ['update-index', '--add', '-z', '--stdin'], { env, input: keep.join('\0') + '\0', timeoutMs: 120_000 });
      const wtTree = (await this.g(root, ['write-tree'], { env })).trim();

      const branchLabel = branch ?? '(detached)';
      const idxCommit = (
        await this.g(root, ['commit-tree', idxTree, '-p', head, '-F', '-'], { env: AUTHOR_ENV, input: `index on ${branchLabel}: ${head.slice(0, 8)}\n` })
      ).trim();
      const message = [`commander checkpoint: ${label}`, '', MARKER, `Label: ${label}`, `Branch: ${branchLabel}`, `Head: ${head}`, `Auto: ${auto ? 'true' : 'false'}`, `Untracked: ${keep.length}`, ''].join('\n');
      const sha = (await this.g(root, ['commit-tree', wtTree, '-p', head, '-p', idxCommit, '-F', '-'], { env: AUTHOR_ENV, input: message })).trim();

      const ref = await this.placeRef(root, sha, label);
      const parsed = await this.readCheckpoint(root, ref);
      if (!parsed) throw new CheckpointError('checkpoint_failed', 'The created checkpoint could not be read back');
      return { checkpoint: parsed.info, clean: wtTree === headTree, untrackedSkipped: skipped };
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  /** `update-ref <ref> <sha> <zero>`: mavjud bo'lsa yozmaydi; to'qnashuvda `-2`.. qo'shimchasi. */
  private async placeRef(root: string, sha: string, label: string): Promise<string> {
    const stamp = checkpointStamp(this.now());
    const slug = checkpointSlug(label);
    for (let n = 1; n <= 20; n++) {
      const suffix = n === 1 ? '' : `-${n}`;
      const ref = `${CHECKPOINT_REF_PREFIX}${stamp}-${slug.slice(0, CHECKPOINT_LIMITS.slugMaxChars - suffix.length).replace(/-+$/, '')}${suffix}`;
      if (!isCheckpointRef(ref)) continue;
      if ((await this.tryG(root, ['check-ref-format', ref])) === null) continue;
      if ((await this.tryG(root, ['update-ref', ref, sha, ZERO(sha.length)])) !== null) return ref;
    }
    throw new CheckpointError('checkpoint_failed', 'Could not create a unique checkpoint ref');
  }

  // --- o'qish ---------------------------------------------------------------------------------

  private async readCheckpoint(root: string, ref: string): Promise<ParsedCheckpoint | null> {
    if (!isCheckpointRef(ref)) return null;
    const sha = await this.revParse(root, `${ref}^{commit}`);
    if (!sha) return null;
    const raw = await this.tryG(root, ['cat-file', 'commit', sha], { maxBuffer: 256 * 1024 });
    if (raw === null) return null;
    const base = parseCheckpointCommit(ref, sha, raw);
    if (!base) return null;
    const idxCommit = base.parents[1]!;
    const idxTree = await this.revParse(root, `${idxCommit}^{tree}`);
    if (!idxTree) return null;
    return { ...base, idxTree };
  }

  async list(p: { root: string }): Promise<RunnerOutcome> {
    try {
      const out = await this.g(p.root, ['for-each-ref', '--sort=-refname', '--format=%(refname)', CHECKPOINT_REF_PREFIX], { maxBuffer: 4 * 1024 * 1024 });
      const refs = out.split('\n').map((l) => l.trim()).filter((l) => isCheckpointRef(l));
      const items: CheckpointInfo[] = [];
      for (const ref of refs) {
        if (items.length >= CHECKPOINT_LIMITS.listMax) break;
        const c = await this.readCheckpoint(p.root, ref);
        if (c) items.push(c.info);
      }
      const result: CheckpointListResult = { items, total: refs.length };
      return { ok: true, result: { checkpoint: result, detail: `${items.length} checkpoints` } };
    } catch (err) {
      return this.toOutcome(err, 'listing failed');
    }
  }

  // --- restore --------------------------------------------------------------------------------

  async restore(p: CheckpointRestorePayload): Promise<RunnerOutcome> {
    try {
      const r = await this.restoreInner(p.root, p.ref);
      return { ok: true, result: { checkpoint: r, detail: `restored ${p.ref.slice(CHECKPOINT_REF_PREFIX.length)}${r.headMoved ? ' (HEAD moved back)' : ''}`.slice(0, 200) } };
    } catch (err) {
      return this.toOutcome(err, 'restore failed');
    }
  }

  private async restoreInner(root: string, ref: string): Promise<CheckpointRestoreResult> {
    const ck = await this.readCheckpoint(root, ref);
    if (!ck) throw new CheckpointError('checkpoint_not_found', 'The checkpoint was not found (or is not a Commander checkpoint)');
    const currentHead = await this.revParse(root, 'HEAD^{commit}');
    if (!currentHead) throw new CheckpointError('no_commits', 'The repository has no commits');
    const branch = readHead(root)?.branch ?? null;
    if (branch !== ck.info.branch) {
      throw new CheckpointError('branch_changed', `The checkpoint was taken on ${ck.info.branch ?? 'a detached HEAD'}, but the current branch is ${branch ?? 'a detached HEAD'}; check it out first`);
    }
    let headMoved = false;
    if (currentHead !== ck.info.headSha) {
      // checkpoint paytidagi commit hozirgi HEAD'ning ajdodi bo'lishi shart (faqat "orqaga" qaytariladi)
      if ((await this.tryG(root, ['merge-base', '--is-ancestor', ck.info.headSha, currentHead])) === null) {
        throw new CheckpointError('head_diverged', 'HEAD is not a descendant of the checkpoint commit (history was rewritten or switched); restore refused');
      }
      headMoved = true;
    }
    if ((await this.g(root, ['ls-files', '--unmerged'])).trim().length > 0) throw new CheckpointError('checkpoint_failed', 'The index has unmerged paths (resolve the merge/rebase first)');

    // hozirgi holat saqlanadi (qaytarishni qaytarish mumkin)
    const pre = await this.createInner(root, 'pre-restore', true);

    const deleted = (
      await this.g(root, ['diff-tree', '-r', '--name-only', '--no-renames', '--diff-filter=D', '-z', ck.info.headSha, ck.wtTree], { maxBuffer: 16 * 1024 * 1024 })
    )
      .split('\0')
      .filter((x) => x.length > 0);

    await this.g(root, ['reset', '--hard', ck.info.headSha], { timeoutMs: 120_000 });
    await this.g(root, ['checkout', ck.info.sha, '--', '.'], { timeoutMs: 120_000 });
    for (const rel of deleted) this.removeTracked(root, rel);
    await this.g(root, ['read-tree', ck.idxTree]);

    return { restored: ref as CheckpointRestoreResult['restored'], preRestore: pre.checkpoint, headSha: ck.info.headSha, headMoved, branch };
  }

  /** Checkpoint paytida o'chirilgan tracked fayl: ishchi daraxtdan olib tashlanadi (yo'l ildiz ichida, papka emas). */
  private removeTracked(root: string, rel: string): void {
    const norm = path.normalize(rel);
    if (path.isAbsolute(norm) || norm.split(path.sep).includes('..') || norm.split(path.sep)[0] === '.git') return;
    const abs = path.join(root, norm);
    try {
      const st = lstatSync(abs);
      if (st.isFile() || st.isSymbolicLink()) unlinkSync(abs);
    } catch {
      /* allaqachon yo'q */
    }
  }
}
