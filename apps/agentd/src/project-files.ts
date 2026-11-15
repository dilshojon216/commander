import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { MdRelPathSchema, PROJECT_OPS_LIMITS, PROJECT_SNAPSHOT_LIMITS, TASKS_MD_FILES } from '@commander/contracts';
import { isInsideSensitive } from './policy.js';
import { redact } from './redact.js';

/**
 * Loyiha md fayllarini o'qish (task 2.1): FAQAT loyiha ildizi ichida, oddiy fayl (symlink emas), bayt chegarasi bilan,
 * redakt qilingan holda (CLAUDE.md qoida 5).
 */

export type MdFileName = 'TODOS.md' | 'CHANGELOG.md' | 'docs/TASKS.md' | 'TASKS.md';

function insideRoot(realRoot: string, realPath: string): boolean {
  const rel = relative(realRoot, realPath);
  return rel !== '' && !rel.startsWith('..') && !rel.split(sep).includes('..') && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel);
}

/**
 * `rel` (ildizga nisbatan, `..`siz) faylni o'qiydi. Fayl yo'q, symlink, ildizdan tashqarida yoki o'qib bo'lmasa `null`.
 * `maxBytes`dan katta fayl kesiladi (oxirgi to'liq bo'lmagan belgi tashlanadi). Natija `redact()` dan o'tgan.
 */
export function readProjectMd(root: string, rel: string, maxBytes: number = PROJECT_SNAPSHOT_LIMITS.maxMdBytes): string | null {
  try {
    const realRoot = realpathSync(root);
    const full = join(realRoot, rel);
    const st = lstatSync(full);
    if (!st.isFile()) return null; // symlink (lstat) va papka rad etiladi
    // Oraliq papka (docs/) symlink bo'lsa, real yo'l ildizdan chiqib ketishi mumkin
    if (!insideRoot(realRoot, realpathSync(full))) return null;
    const size = Math.min(st.size, maxBytes);
    if (size === 0) return '';
    const buf = Buffer.alloc(size);
    const fd = openSync(full, 'r');
    let read = 0;
    try {
      while (read < size) {
        const n = readSync(fd, buf, read, size - read, read);
        if (n <= 0) break;
        read += n;
      }
    } finally {
      closeSync(fd);
    }
    let text = buf.subarray(0, read).toString('utf8');
    if (st.size > maxBytes) text = trimTrailingReplacement(text);
    text = redact(text);
    return text.length > PROJECT_SNAPSHOT_LIMITS.maxMdChars ? text.slice(0, PROJECT_SNAPSHOT_LIMITS.maxMdChars) : text;
  } catch {
    return null;
  }
}

/** `docs/TASKS.md` birinchi, so'ng `TASKS.md`. */
export function readTasksMd(root: string): { path: 'docs/TASKS.md' | 'TASKS.md'; content: string } | null {
  for (const path of ['docs/TASKS.md', 'TASKS.md'] as const) {
    const content = readProjectMd(root, path);
    if (content !== null) return { path, content };
  }
  return null;
}

// --- loyiha ish maydoni (2.15) -----------------------------------------------------------------

/** `.md` ro'yxatida o'tkazib yuboriladigan papkalar (qurilish/bog'liqlik/kesh). Nuqta bilan boshlanuvchilar ham tashlanadi. */
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', 'coverage', 'vendor', 'target', 'venv', '__pycache__', 'pods', 'bower_components', 'deriveddata', 'obj', 'bin',
]);
const MD_LIST_MAX_DEPTH = 3;
const MD_LIST_MAX_VISITS = 20_000;

/**
 * Loyiha ildizidagi `*.md` fayllar (chuqurlik <= 3, node_modules/.git/dist/... siz, symlink'lar kuzatilmaydi), <= 200 yo'l.
 * Tartib: sayoz yo'llar birinchi, keyin alifbo. Yo'llar ildizga nisbatan, `/` bilan.
 */
export function listProjectMd(root: string, maxFiles: number = PROJECT_OPS_LIMITS.maxMdFiles): string[] {
  const found: string[] = [];
  let visits = 0;
  const walk = (dir: string, rel: string, depth: number): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (++visits > MD_LIST_MAX_VISITS) return;
      if (e.isSymbolicLink()) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (depth >= MD_LIST_MAX_DEPTH || e.name.startsWith('.') || SKIP_DIRS.has(e.name.toLowerCase())) continue;
        walk(join(dir, e.name), childRel, depth + 1);
      } else if (e.isFile() && /\.md$/i.test(e.name) && MdRelPathSchema.safeParse(childRel).success) {
        found.push(childRel);
      }
    }
  };
  walk(root, '', 0);
  found.sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : a > b ? 1 : 0));
  return found.slice(0, maxFiles);
}

export interface MdReadResult {
  path: string;
  content: string;
  bytes: number;
  truncated: boolean;
}

export type MdReadError = 'path_invalid' | 'file_not_found';

/**
 * Ildiz ichidagi md faylni o'qiydi (<= 64 KB, redakt): yo'l `MdRelPathSchema` bilan tekshiriladi, oraliq papkalar va fayl
 * symlink bo'lmasligi shart, realpath ildizdan chiqmasligi shart. Aks holda xato kodi.
 */
export function readMdFile(root: string, rel: string, maxBytes: number = PROJECT_OPS_LIMITS.maxReadBytes, sensitive?: readonly string[]): MdReadResult | MdReadError {
  if (!MdRelPathSchema.safeParse(rel).success) return 'path_invalid';
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return 'file_not_found';
  }
  let cur = realRoot;
  for (const seg of rel.split('/')) {
    cur = join(cur, seg);
    try {
      if (lstatSync(cur).isSymbolicLink()) return 'path_invalid';
    } catch {
      return 'file_not_found';
    }
  }
  try {
    const st = lstatSync(cur);
    if (!st.isFile()) return 'path_invalid';
    const realFile = realpathSync(cur);
    if (!insideRoot(realRoot, realFile)) return 'path_invalid';
    // Ildiz `$HOME` bo'lsa (allow-home): ~/.ssh, ~/.claude, ~/.commander ... ichidagi md fayllar ham o'qilmaydi
    if (isInsideSensitive(realFile, undefined, sensitive)) return 'path_invalid';
  } catch {
    return 'file_not_found';
  }
  const text = readProjectMd(realRoot, rel, maxBytes);
  if (text === null) return 'file_not_found';
  const st = lstatSync(cur);
  return { path: rel, content: text, bytes: Math.min(st.size, maxBytes), truncated: st.size > maxBytes };
}

/** TASKS.md xom baytlari sha256'i (redaktdan OLDIN; append optimistik konkurentligi). Fayl yo'q/katta/symlink bo'lsa `null`. */
export function hashTasksFile(root: string, rel: (typeof TASKS_MD_FILES)[number]): string | null {
  try {
    const realRoot = realpathSync(root);
    const full = join(realRoot, rel);
    const st = lstatSync(full);
    if (!st.isFile() || st.size > PROJECT_OPS_LIMITS.maxTasksFileBytes) return null;
    if (!insideRoot(realRoot, realpathSync(full))) return null;
    return createHash('sha256').update(readFileSync(full)).digest('hex');
  } catch {
    return null;
  }
}

/** Oxiridagi U+FFFD (kesilgan UTF-8 qoldig'i) ni olib tashlaydi. Regex `/\uFFFD+$/` ichki ketma-ketliklarda kvadratik edi. */
export function trimTrailingReplacement(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 0xfffd) end--;
  return end === s.length ? s : s.slice(0, end);
}
