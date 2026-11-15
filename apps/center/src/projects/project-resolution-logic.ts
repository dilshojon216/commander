/**
 * Sessiya loyihasini aniqlash (sof mantiq, DB'siz).
 *
 * Qoida: sessiya loyihasi BOSHLANGAN cwd bilan belgilanadi va keyin o'zgarmaydi (`sessions.project_id` yopishqoq).
 * Boshlang'ich cwd uchun:
 *  1. git repo ichida bo'lsa agentd git ildizini yuboradi (`rootKind = 'git'`): shu yo'l bilan loyiha (yaratiladi yoki mavjud);
 *  2. aks holda: aynan shu yo'lli loyiha bor bo'lsa - o'sha;
 *  3. aks holda: shu mashinadagi eng yaqin MA'LUM ota loyiha (pastki papka uchun yangi loyiha ochilmaydi);
 *  4. aks holda: cwd uchun yangi `dir` loyiha.
 */

export interface ProjectCandidate {
  id: string;
  path: string;
}

export type ProjectDecision = { action: 'use'; projectId: string } | { action: 'create'; kind: 'git' | 'dir' };

/** `/` yoki `C:/` kabi ildiz: hamma narsani yutib yuboradi, shuning uchun ota loyiha bo'lolmaydi. */
export function isFsRoot(path: string): boolean {
  return path === '/' || /^[A-Za-z]:\/?$/.test(path) || path === '';
}

const trimSlash = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, '') : p);

/** `child` `ancestor`ning QAT'IY ichida (chegara `/` bo'yicha: `/a/bc` `/a/b` ichida emas). */
export function isStrictlyInside(child: string, ancestor: string): boolean {
  if (isFsRoot(ancestor)) return false;
  const a = trimSlash(ancestor);
  const c = trimSlash(child);
  return c.length > a.length && c.startsWith(`${a}/`);
}

/** Eng yaqin (eng uzun yo'lli) ota loyiha; yo'q bo'lsa null. */
export function nearestAncestor(path: string, candidates: readonly ProjectCandidate[]): ProjectCandidate | null {
  let best: ProjectCandidate | null = null;
  for (const c of candidates) {
    if (!isStrictlyInside(path, c.path)) continue;
    if (best === null || trimSlash(c.path).length > trimSlash(best.path).length) best = c;
  }
  return best;
}

export interface ResolveInput {
  cwd: string;
  /** agentd bergan ildiz turi; eski agentd'da yo'q. */
  rootKind?: 'git' | 'dir' | null | undefined;
  /** Aynan `cwd` yo'lli loyiha (shu mashinada), bo'lsa. */
  exactId: string | null;
  /** Shu mashinadagi, `cwd` ichida joylashgan yo'lli loyihalar (ota nomzodlar). */
  ancestors: readonly ProjectCandidate[];
}

export function decideProject(i: ResolveInput): ProjectDecision {
  if (i.exactId) return { action: 'use', projectId: i.exactId };
  if (i.rootKind === 'git') return { action: 'create', kind: 'git' };
  const anc = nearestAncestor(i.cwd, i.ancestors);
  if (anc) return { action: 'use', projectId: anc.id };
  return { action: 'create', kind: 'dir' };
}

/**
 * Yopishqoqlik: sessiyada loyiha allaqachon belgilangan bo'lsa u qoladi (keyingi cwd o'zgarishlari e'tiborsiz),
 * aks holda yangi aniqlangani (yoki null).
 */
export function stickyProjectId(existing: string | null | undefined, resolved: string | null | undefined): string | null {
  return existing ?? resolved ?? null;
}
