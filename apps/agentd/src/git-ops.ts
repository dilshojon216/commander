import { isSafeBranchName } from '@commander/contracts';
import type { CiStatusPayload, CiStatusResult, DiffPayload, OpenPrPayload, PrResult } from '@commander/contracts';
import { collectDiff } from './git-diff.js';
import type { GhRunner } from './gh.js';
import { createGhRunner, deriveCiState, detectGh, isPrExistsError, parseGhChecks, parseGhPrList, parseGhRuns, parsePrUrl } from './gh.js';
import { GIT_STATUS_TIMEOUT_MS, isGitRoot, readHead, runGit } from './git-info.js';
import type { GitRunner } from './git-info.js';
import { errMsg, type Logger } from './logger.js';
import { redact } from './redact.js';
import type { RunnerOutcome } from './runner.js';

/**
 * Git/PR buyruqlari (task 3.5): `project.diff`, `project.open_pr`, `project.ci_status`. Siyosat (yoqilgan, ruxsat, ildiz) va
 * imzo `CommandManager`da ALLAQACHON tekshirilgan; bu yerda faqat bajarish va qo'shimcha xavfsizlik (PR oldshartlari).
 *
 * PR xavfsizligi:
 *  - `gh` o'rnatilmagan/avtorizatsiyasiz bo'lsa HECH NARSA qilinmaydi (`gh_unavailable` | `gh_unauthenticated`);
 *  - `git push -u origin refs/heads/<b>:refs/heads/<b>`: FAQAT mavjud `origin`ga, majburiy (force) YO'Q, `+` YO'Q;
 *  - asosiy (default) branch'dan, ishchi daraxti iflos bo'lsa, commit'siz yoki `origin` yo'q bo'lsa rad etiladi;
 *  - title/body/branch alohida argument (shell YO'Q; `--title=...` shakli: qiymat bayroqqa aylanmaydi).
 */

export interface GitOpsDeps {
  log: Logger;
  git?: GitRunner;
  gh?: GhRunner;
}

const fail = (code: NonNullable<RunnerOutcome['code']>, message: string): RunnerOutcome => ({ ok: false, code, message });

const PUSH_TIMEOUT_MS = 90_000;
const GH_CREATE_TIMEOUT_MS = 60_000;

export class GitOps {
  private readonly git: GitRunner;
  private readonly gh: GhRunner;

  constructor(private readonly d: GitOpsDeps) {
    this.git = d.git ?? runGit;
    this.gh = d.gh ?? createGhRunner();
  }

  async diff(p: DiffPayload): Promise<RunnerOutcome> {
    try {
      const r = await collectDiff(p.root, p, { git: this.git });
      return r.ok ? { ok: true, result: { diff: r.result } } : fail(r.code, r.message);
    } catch (err) {
      this.d.log.warn('project.diff xatosi', { error: errMsg(err).slice(0, 200) });
      return fail('git_failed', 'diff failed');
    }
  }

  // --- PR ----------------------------------------------------------------------------------

  private async tryGit(root: string, args: string[], timeoutMs?: number): Promise<string | null> {
    try {
      return (await this.git(root, args, timeoutMs ? { timeoutMs } : undefined)).trim();
    } catch {
      return null;
    }
  }

  /** Default branch: `origin/HEAD` ko'rsatgan nom; yo'q bo'lsa `null` (shunda faqat `base === head` tekshiriladi). */
  private async defaultBranch(root: string): Promise<string | null> {
    const out = await this.tryGit(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
    if (!out) return null;
    const name = out.startsWith('origin/') ? out.slice('origin/'.length) : out;
    return isSafeBranchName(name) ? name : null;
  }

  async openPr(p: OpenPrPayload): Promise<RunnerOutcome> {
    const root = p.root;
    if (!isGitRoot(root)) return fail('not_a_git_repo', 'The project is not a git repository');

    const avail = await detectGh(this.gh, root);
    if (avail === 'missing') return fail('gh_unavailable', 'The GitHub CLI (gh) is not installed on this machine');
    if (avail === 'unauthenticated') return fail('gh_unauthenticated', 'The GitHub CLI is not authenticated (run `gh auth login` on the machine)');

    const current = readHead(root)?.branch ?? null;
    const head = p.head ?? current;
    if (!head) return fail('git_failed', 'HEAD is detached; check out a branch first');
    if (head === p.base) return fail('on_default_branch', 'The head branch is the same as the base branch');
    const def = await this.defaultBranch(root);
    if (def && head === def) return fail('on_default_branch', 'Refusing to open a PR from the default branch');

    const origin = await this.tryGit(root, ['config', '--get', 'remote.origin.url']);
    if (!origin) return fail('no_remote', 'The repository has no "origin" remote');

    const headSha = await this.tryGit(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${head}`]);
    if (!headSha) return fail('git_failed', 'The head branch does not exist locally');

    if (head === current) {
      // Tracked o'zgarishlar (staged/unstaged) PR'ga kirmaydi: oldin commit qilinsin. Untracked e'tiborga olinmaydi.
      const st = await this.tryGit(root, ['status', '--porcelain=v2', '-z', '--untracked-files=no'], GIT_STATUS_TIMEOUT_MS);
      if (st === null) return fail('git_failed', 'git status failed');
      if (st.length > 0) return fail('dirty_worktree', 'There are uncommitted changes; commit or stash them first');
    }

    let baseRef: string | null = null;
    for (const ref of [`refs/remotes/origin/${p.base}`, `refs/heads/${p.base}`]) {
      if (await this.tryGit(root, ['rev-parse', '--verify', '--quiet', ref])) {
        baseRef = ref;
        break;
      }
    }
    if (!baseRef) return fail('base_invalid', 'The base branch was not found (origin/<base> or local)');
    const ahead = await this.tryGit(root, ['rev-list', '--count', `${baseRef}..refs/heads/${head}`]);
    if (ahead === null || !/^\d+$/.test(ahead)) return fail('git_failed', 'Could not compare the branch with its base');
    if (Number(ahead) === 0) return fail('nothing_to_pr', 'The branch has no commits ahead of the base');

    // Yuborish: remote'dagi nusxa boshqa bo'lsa (yoki yo'q bo'lsa). Majburiy emas: non-fast-forward git tomonidan rad etiladi.
    const remoteSha = await this.tryGit(root, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${head}`]);
    let pushed = false;
    if (remoteSha !== headSha) {
      try {
        await this.git(root, ['push', '--set-upstream', 'origin', `refs/heads/${head}:refs/heads/${head}`], { timeoutMs: PUSH_TIMEOUT_MS });
        pushed = true;
      } catch (err) {
        const detail = redact(errMsg(err)).replace(/\s+/g, ' ').slice(0, 200);
        this.d.log.warn('git push xatosi', { branch: head, error: detail });
        return fail('push_failed', `git push to origin failed: ${detail}`.slice(0, 300));
      }
    }

    const args = ['pr', 'create', `--title=${p.title}`, `--body=${p.body}`, `--base=${p.base}`, `--head=${head}`, ...(p.draft ? ['--draft'] : [])];
    const r = await this.gh(root, args, { timeoutMs: GH_CREATE_TIMEOUT_MS });
    if (r.missing) return fail('gh_unavailable', 'The GitHub CLI (gh) is not installed on this machine');
    const mk = (parsed: { url: string; number: number }, existing: boolean): RunnerOutcome => {
      const pr: PrResult = { url: parsed.url, number: parsed.number, existing, branch: head, base: p.base, draft: p.draft, pushed };
      return { ok: true, result: { pr } };
    };
    if (r.code === 0) {
      const parsed = parsePrUrl(r.stdout) ?? parsePrUrl(r.stderr);
      return parsed ? mk(parsed, false) : fail('pr_failed', 'gh did not report the PR URL');
    }
    if (isPrExistsError(r.stderr)) {
      const parsed = parsePrUrl(r.stderr);
      if (parsed) return mk(parsed, true);
    }
    this.d.log.warn('gh pr create xatosi', { code: r.code, timedOut: r.timedOut });
    return fail('pr_failed', `gh pr create failed${r.timedOut ? ' (timeout)' : ''}: ${redact(r.stderr).replace(/\s+/g, ' ').trim().slice(0, 200)}`);
  }

  // --- CI ----------------------------------------------------------------------------------

  async ciStatus(p: CiStatusPayload): Promise<RunnerOutcome> {
    const root = p.root;
    if (!isGitRoot(root)) return fail('not_a_git_repo', 'The project is not a git repository');
    const branch = p.branch ?? readHead(root)?.branch ?? null;
    if (!branch || !isSafeBranchName(branch)) return fail('git_failed', 'No branch to check (detached HEAD)');

    const avail = await detectGh(this.gh, root);
    if (avail === 'missing') return fail('gh_unavailable', 'The GitHub CLI (gh) is not installed on this machine');
    if (avail === 'unauthenticated') return fail('gh_unauthenticated', 'The GitHub CLI is not authenticated');

    const prList = await this.gh(root, ['pr', 'list', `--head=${branch}`, '--state=all', '--limit=1', '--json=number,url,state,title,isDraft']);
    if (prList.timedOut) return fail('pr_failed', 'gh timed out');
    const pr = prList.code === 0 ? parseGhPrList(prList.stdout) : null;
    // `gh pr checks` fail/pending holatida ham stdout'ga JSON yozadi (chiqish kodi 1/8): kodga qaramay tahlil qilinadi
    const checks = pr ? parseGhChecks((await this.gh(root, ['pr', 'checks', String(pr.number), '--json=name,bucket,link'])).stdout) : [];
    const runs = await this.gh(root, ['run', 'list', `--branch=${branch}`, '--limit=5', '--json=databaseId,name,status,conclusion,headSha,url']);
    const run = runs.code === 0 ? parseGhRuns(runs.stdout) : null;
    if (!pr && prList.code !== 0 && runs.code !== 0) return fail('pr_failed', `gh could not read the repository status: ${redact(prList.stderr).replace(/\s+/g, ' ').trim().slice(0, 160)}`);

    const ci: CiStatusResult = { branch, state: deriveCiState(checks, run), pr, checks, run };
    return { ok: true, result: { ci } };
  }
}
