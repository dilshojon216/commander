import { isHardExcludedTool, isRuleFileTool, isRuleToolAllowed, RULE_LIMITS } from '@commander/contracts';
import type { ApprovalTarget } from '@commander/contracts';

/**
 * Avto-ruxsat qoidalarini moslashtirish (sof mantiq, 2.13). Markaz faqat agentd'ning redakt qilingan kiritmasi va
 * `target` maslahatini biladi: qaror shundan chiqadi. Gumon bo'lsa HAR DOIM "mos emas" (qo'lda tasdiq).
 */

export interface RuleLike {
  id: number;
  tools: readonly string[];
  pathGlobs: readonly string[];
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface RuleRequest {
  toolName: string;
  target: ApprovalTarget | undefined;
}

/** Hech qachon avto-ruxsat olmaydigan yo'l segmentlari (kichik harf): kod bajarilishiga yoki kalitlarga olib boradi. */
const PROTECTED_DIRS: ReadonlySet<string> = new Set([
  '.git', '.claude', '.ssh', '.gnupg', '.aws', '.kube', '.azure', '.docker', '.husky', '.vscode', '.idea', '.config',
  // M-13: CI/dev-konteyner/muharrir yo'llari kod bajarilishiga olib keladi
  '.github', '.gitlab', '.circleci', '.devcontainer', '.cursor', '.cargo', '.buildkite', '.azure-pipelines',
]);
const PROTECTED_FILE_RES: readonly RegExp[] = [
  /^\.env($|\.)/,
  /^\.envrc$/,
  /^\.mcp\.json$/,
  /^\.gitmodules$/,
  /^\.gitattributes$/,
  /^\.gitconfig$/,
  /^\.(npmrc|yarnrc|yarnrc\.yml|pypirc|netrc|git-credentials|pgpass|my\.cnf)$/,
  /^\.(bashrc|bash_profile|bash_login|profile|zshrc|zprofile|zshenv|zlogin)$/,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/,
  /\.(pem|key|p12|pfx|keystore|jks|kdbx)$/,
  /^credentials(\.|$)/,
  /^secrets?(\.|$)/,
  /^authorized_keys$/,
  // M-13: paket/CI/build/skript fayllari (ularga yozish keyingi `npm install`/CI/make orqali kod bajaradi)
  /^\.gitlab-ci\.ya?ml$/,
  /^(package|package-lock|npm-shrinkwrap)\.json$/,
  /^(pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|bun\.lockb?)$/,
  /^(makefile|gnumakefile|justfile|rakefile|jenkinsfile|taskfile\.ya?ml)$/,
  /\.(sh|bash|zsh|ps1|psm1|bat|cmd)$/,
  /^dockerfile($|[.-])/,
  /\.dockerfile$/,
  /^(docker-)?compose.*\.ya?ml$/,
  /^docker-compose.*\.ya?ml$/,
  /^(claude|agents|gemini)\.md$/,
  /\.(service|timer|plist)$/,
  /^crontab$/,
  /^\.pre-commit-config\.ya?ml$/,
  /^(pyproject\.toml|setup\.py|setup\.cfg|conftest\.py|tox\.ini|noxfile\.py)$/,
  /^build\.rs$/,
  /\.config\.(js|cjs|mjs|ts|cts|mts)$/,
  /^\.(eslintrc|prettierrc|babelrc)(\.|$)/,
];

/** Markaz tomonida qayta tekshirilgan nisbiy yo'l: posix, `..`/absolyut/NUL/teskari slesh yo'q. Aks holda `null`. */
export function normalizeTargetPath(path: string): string | null {
  if (path.length === 0 || path.length > 1024) return null;
  if (path.includes('\0') || path.includes('\\') || path.startsWith('/') || /^[A-Za-z]:/.test(path)) return null;
  if (path === '.') return '.';
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') return null;
    out.push(seg);
  }
  return out.length === 0 ? '.' : out.join('/');
}

export function isProtectedPath(path: string): boolean {
  if (path === '.') return false;
  for (const seg of path.split('/')) {
    const s = seg.toLowerCase();
    if (PROTECTED_DIRS.has(s)) return true;
    if (PROTECTED_FILE_RES.some((re) => re.test(s))) return true;
  }
  return false;
}

/**
 * Glob mosligi: `**` = nol yoki ko'p segment, `*` = segment ichida istalgan (slesh'siz), `?` = bitta belgi.
 * Regex ishlatilmaydi (ReDoS yo'q): har segment iterativ wildcard moslashtirish.
 */
export function matchGlob(glob: string, path: string): boolean {
  return matchSegments(glob.split('/'), 0, path.split('/'), 0);
}

function matchSegments(g: string[], gi: number, p: string[], pi: number): boolean {
  while (gi < g.length) {
    const seg = g[gi]!;
    if (seg === '**') {
      while (gi < g.length && g[gi] === '**') gi += 1;
      if (gi === g.length) return true;
      for (let k = pi; k <= p.length; k += 1) if (matchSegments(g, gi, p, k)) return true;
      return false;
    }
    if (pi >= p.length || !matchWildcard(seg, p[pi]!)) return false;
    gi += 1;
    pi += 1;
  }
  return pi === p.length;
}

function matchWildcard(pattern: string, text: string): boolean {
  let pi = 0;
  let ti = 0;
  let star = -1;
  let mark = 0;
  while (ti < text.length) {
    const c = pattern[pi];
    if (c !== undefined && (c === '?' || c === text[ti]) && c !== '*') {
      pi += 1;
      ti += 1;
    } else if (c === '*') {
      star = pi;
      mark = ti;
      pi += 1;
    } else if (star !== -1) {
      pi = star + 1;
      mark += 1;
      ti = mark;
    } else {
      return false;
    }
  }
  while (pattern[pi] === '*') pi += 1;
  return pi === pattern.length;
}

export type RuleStatus = 'active' | 'expired' | 'revoked';

export function ruleStatus(rule: Pick<RuleLike, 'expiresAt' | 'revokedAt'>, now: Date): RuleStatus {
  if (rule.revokedAt) return 'revoked';
  return rule.expiresAt.getTime() <= now.getTime() ? 'expired' : 'active';
}

/** Bitta qoida shu so'rovga mos keladimi. Barcha shartlar birgalikda (VA). */
export function ruleMatches(rule: RuleLike, req: RuleRequest, now: Date): boolean {
  if (ruleStatus(rule, now) !== 'active') return false;
  // Qat'iy istisnolar va allow-list: qoida bazada noto'g'ri bo'lsa ham (qo'lda tahrir) avto-ruxsat yo'q.
  if (isHardExcludedTool(req.toolName) || !isRuleToolAllowed(req.toolName)) return false;
  if (!rule.tools.includes(req.toolName)) return false;

  if (!isRuleFileTool(req.toolName)) {
    // MCP vositalari: yo'l maslahati yo'q, qoidada glob bo'lmasligi shart.
    return rule.pathGlobs.length === 0;
  }
  const t = req.target;
  if (!t || !t.insideCwd || t.path === null) return false;
  const path = normalizeTargetPath(t.path);
  if (path === null || isProtectedPath(path)) return false;
  if (rule.pathGlobs.length === 0) return true;
  const dirTool = req.toolName === 'Glob' || req.toolName === 'Grep';
  // Katalog vositalari (Glob/Grep): katalog glob'ga to'g'ridan-to'g'ri yoki ichidagi bitta fayl sifatida mos kelsa.
  const candidates = dirTool ? [path, path === '.' ? '_' : `${path}/_`] : [path];
  return rule.pathGlobs.some((g) => candidates.some((c) => matchGlob(g, c)));
}

/** Eng past id'li mos qoida (barqaror tanlov) yoki `null`. */
export function findMatchingRule<R extends RuleLike>(rules: readonly R[], req: RuleRequest, now: Date): R | null {
  let best: R | null = null;
  for (const r of rules) if (ruleMatches(r, req, now) && (best === null || r.id < best.id)) best = r;
  return best;
}

/** Soatlik cheklov: `usedLastHour >= cap` bo'lsa qoida bu so'rovga ishlamaydi (qo'lda tasdiq). */
export function underRateCap(usedLastHour: number, cap: number = RULE_LIMITS.maxAutoPerHour): boolean {
  return usedLastHour < cap;
}
