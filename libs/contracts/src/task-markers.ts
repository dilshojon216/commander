/**
 * Vazifa markerlari (task 2.9): promptdan va git branch nomidan FAQAT vazifa id'sini ajratadi.
 * Sof funksiyalar (node importlarisiz): agentd, center va testlar bir xil qoidani ishlatadi.
 *
 * MUHIM (CLAUDE.md qoida 5): prompt matni hech qayerga yuborilmaydi/saqlanmaydi. Bu modul faqat id (qisqa satr)
 * qaytaradi; chaqiruvchi promptning o'zini hodisaga qo'shmasligi shart.
 *
 * Id sintaksisi: `1.4`, `2.9`, `1.1a`, `12` (raqam, ixtiyoriy `.raqam` bo'laklar, ixtiyoriy bitta lotin harfi).
 */

export const TASK_KEY_MAX_LEN = 32;

const ID = String.raw`[0-9]{1,6}(?:\.[0-9]{1,6}){0,4}[A-Za-z]?`;
/** `/task 1.4` (promptning boshida). Id'dan keyin harf/raqam kelsa moslik yo'q (`/task 1.4abc`). */
const SLASH_RE = new RegExp(String.raw`^\s*/task[ \t]+(${ID})(?![A-Za-z0-9]|\.[0-9])`);
/** `#task:1.4` (istalgan joyda; oldidan bo'shliq/tinish belgisi yoki matn boshi). */
const INLINE_RE = new RegExp(String.raw`(?:^|[\s(\[{,;"'])#task:(${ID})(?![A-Za-z0-9]|\.[0-9])`);

/** Promptni skanerlash chegarasi (belgi): juda uzun matnda ham regex tez ishlaydi. */
const MAX_SCAN_CHARS = 200_000;

export function normalizeTaskKey(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Promptdan aniq marker: avval `/task <id>` (boshida), keyin birinchi `#task:<id>`. Topilmasa `null`. */
export function extractTaskMarker(prompt: string | null | undefined): string | null {
  if (!prompt) return null;
  const text = prompt.length > MAX_SCAN_CHARS ? prompt.slice(0, MAX_SCAN_CHARS) : prompt;
  const m = SLASH_RE.exec(text) ?? INLINE_RE.exec(text);
  const id = m?.[1];
  if (!id || id.length > TASK_KEY_MAX_LEN) return null;
  return normalizeTaskKey(id);
}

const ID_DOTTED = String.raw`[0-9]{1,6}(?:\.[0-9]{1,6}){1,4}[A-Za-z]?`;
/** `1.4-nom` / `task-1.4-nom`: nuqtali id VA undan keyin `-nom` majburiy (`release/2.9`, `2024-fix`, `12-abc` vazifa emas). */
const SEGMENT_DOTTED = new RegExp(String.raw`^(?:task[-_])?(${ID_DOTTED})[-_][^/]+$`, 'i');
/** `task/<id>` prefiksidan keyin id yetarli (`task/1.4`, `task/7-foo`): butun son ham vazifa. */
const SEGMENT_AFTER_TASK_PREFIX = new RegExp(String.raw`^(${ID})(?:[-_.][^/]*)?$`, 'i');
/** Bu prefikslar ostidagi raqamlar versiya (reliz), vazifa emas. */
const VERSION_PREFIXES = new Set(['release', 'releases', 'hotfix', 'rel', 'v']);

/**
 * Branch nomidan taxmin: `task/1.4-nom`, `1.4-nom`, `feat/2.9-nom`, `feature/task-2.9-x`. Faqat id; topilmasa `null`.
 * Bu TAXMIN (source='branch'): aniq marker (source='explicit') har doim ustun.
 */
export function taskKeyFromBranch(branch: string | null | undefined): string | null {
  if (!branch) return null;
  const segments = branch.trim().split('/').filter((s) => s.length > 0);
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const prev = i > 0 ? segments[i - 1]!.toLowerCase() : '';
    if (VERSION_PREFIXES.has(prev)) continue;
    const afterTask = prev === 'task' || prev === 'tasks';
    const m = (afterTask ? SEGMENT_AFTER_TASK_PREFIX.exec(seg) : null) ?? SEGMENT_DOTTED.exec(seg);
    const id = m?.[1];
    if (id && id.length <= TASK_KEY_MAX_LEN) return normalizeTaskKey(id);
  }
  return null;
}
