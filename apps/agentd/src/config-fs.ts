import { createHash, randomBytes } from 'node:crypto';
import type { Stats } from 'node:fs';
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, rmdirSync, writeSync } from 'node:fs';
import path from 'node:path';
import { checkConfigPath } from '@commander/contracts';
import { isInside } from './policy.js';

/**
 * Sozlamalar sinxronlash uchun xavfsiz fayl amallari (3.7). `root` = Claude konfiguratsiya papkasi (`~/.claude` yoki
 * `CLAUDE_CONFIG_DIR`). Profil yo'llari FAQAT `checkConfigPath` ruxsat ro'yxatidan o'tadi; symlink orqali yozilmaydi/o'qilmaydi.
 */

const isPosix = process.platform !== 'win32';
export const sha256Hex = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

/** Claude konfiguratsiya papkasi (CLAUDE_CONFIG_DIR bor bo'lsa shu). */
export function claudeConfigDir(env: NodeJS.ProcessEnv, homeDir: string): string {
  const e = env['CLAUDE_CONFIG_DIR'];
  return e && e.trim() !== '' ? path.resolve(e) : path.join(homeDir, '.claude');
}

/** Ruxsat ro'yxatidagi nisbiy yo'lni `root` ichidagi mutlaq yo'lga aylantiradi (sof; `lib` = platforma). Yaroqsiz = `null`. */
export function resolveManaged(root: string, rel: string, lib: Pick<typeof path.posix, 'join' | 'relative' | 'isAbsolute' | 'sep'> = path): string | null {
  if (!checkConfigPath(rel).ok) return null;
  const abs = lib.join(root, ...rel.split('/'));
  const r = lib.relative(root, abs);
  if (r === '' || lib.isAbsolute(r) || r === '..' || r.startsWith(`..${lib.sep}`)) return null;
  return abs;
}

export type LocalState =
  | { state: 'missing' }
  | { state: 'file'; sha256: string; size: number; exec: boolean; content: Buffer }
  | { state: 'unsafe'; reason: string };

/** Mahalliy fayl holati. Yo'l komponentlari symlink bo'lsa, fayl oddiy fayl bo'lmasa yoki registrdagina farq qiluvchi nom bo'lsa `unsafe`. */
export function readLocal(root: string, rel: string, maxBytes: number): LocalState {
  const abs = resolveManaged(root, rel);
  if (!abs) return { state: 'unsafe', reason: 'path not allowed' };
  const segs = rel.split('/');
  let cur = root;
  for (let i = 0; i < segs.length; i++) {
    const last = i === segs.length - 1;
    let names: string[];
    try {
      names = readdirSync(cur);
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ENOTDIR' ? { state: 'missing' } : { state: 'unsafe', reason: 'directory not readable' };
    }
    const seg = segs[i]!;
    if (!names.includes(seg)) {
      if (names.some((n) => n.toLowerCase() === seg.toLowerCase())) return { state: 'unsafe', reason: 'a differently-cased entry exists' };
      return { state: 'missing' };
    }
    cur = path.join(cur, seg);
    const st = lstatSync(cur);
    if (st.isSymbolicLink()) return { state: 'unsafe', reason: 'symlink in path' };
    if (!last && !st.isDirectory()) return { state: 'unsafe', reason: 'path component is not a directory' };
    if (last) {
      if (!st.isFile()) return { state: 'unsafe', reason: 'not a regular file' };
      if (st.size > maxBytes) return { state: 'unsafe', reason: 'file too large' };
      const content = readFileSync(cur);
      return { state: 'file', sha256: sha256Hex(content), size: content.length, exec: isPosix && (st.mode & 0o111) !== 0, content };
    }
  }
  return { state: 'missing' };
}

/** `root` ichidagi ota papkalarni yaratadi; mavjud komponent symlink bo'lsa xato. */
function ensureDirs(root: string, relDir: string[]): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  let cur = root;
  for (const seg of relDir) {
    cur = path.join(cur, seg);
    let st: Stats;
    try {
      st = lstatSync(cur);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      mkdirSync(cur, { mode: 0o755 });
      continue;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('unsafe directory component');
  }
  let realRoot: string;
  let realCur: string;
  try {
    realRoot = realpathSync.native(root);
    realCur = realpathSync.native(cur);
  } catch {
    throw new Error('cannot resolve directory');
  }
  if (!isInside(realRoot, realCur, path, process.platform === 'win32' || process.platform === 'darwin')) throw new Error('directory escapes the config root');
}

/** Atomik yozuv: shu papkada vaqtinchalik fayl + fsync + rename. Symlink orqali yozilmaydi (nishon symlink bo'lsa xato). */
export function writeManagedAtomic(root: string, rel: string, content: Buffer, exec: boolean): void {
  const abs = resolveManaged(root, rel);
  if (!abs) throw new Error('path not allowed');
  const segs = rel.split('/');
  ensureDirs(root, segs.slice(0, -1));
  try {
    if (lstatSync(abs).isSymbolicLink()) throw new Error('target is a symlink');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const tmp = path.join(path.dirname(abs), `.${segs[segs.length - 1]}.commander-${randomBytes(6).toString('hex')}.tmp`);
  const fd = openSync(tmp, 'wx', exec && isPosix ? 0o755 : 0o644);
  try {
    writeSync(fd, content);
    try {
      fsyncSync(fd);
    } catch {
      /* ba'zi fayl tizimlarida fsync yo'q */
    }
  } finally {
    closeSync(fd);
  }
  try {
    if (isPosix) chmodSync(tmp, exec ? 0o755 : 0o644);
    renameSync(tmp, abs);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** Boshqariladigan faylni o'chiradi (symlink bo'lsa rad); bo'sh qolgan `skills/...` papkalarini olib tashlaydi. */
export function deleteManaged(root: string, rel: string): void {
  const abs = resolveManaged(root, rel);
  if (!abs) throw new Error('path not allowed');
  const st = lstatSync(abs);
  if (st.isSymbolicLink() || !st.isFile()) throw new Error('target is not a regular file');
  rmSync(abs);
  const segs = rel.split('/');
  if (segs[0] === 'skills') {
    for (let i = segs.length - 1; i >= 2; i--) {
      const dir = path.join(root, ...segs.slice(0, i));
      try {
        if (readdirSync(dir).length > 0) break;
        rmdirSync(dir);
      } catch {
        break;
      }
    }
  }
}

// --- capture uchun ro'yxat ---------------------------------------------------------------------

export interface Candidate {
  rel: string;
  abs: string;
  size: number;
  exec: boolean;
}

const MAX_WALK_ENTRIES = 5000;

/**
 * Boshqariladigan to'plamni (CLAUDE.md, agents/*.md, commands/*.md, skills/**) sanaydi. Symlink'lar o'tkazib yuboriladi va
 * `skipped` ga yoziladi (tashqariga o'qimaymiz). Tartib barqaror (saralangan).
 */
export function listCandidates(root: string): { items: Candidate[]; skipped: Array<{ path: string; reason: string }> } {
  const items: Candidate[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  let visited = 0;

  const visitFile = (rel: string, abs: string, st: Stats, quietIfUnmanaged: boolean): void => {
    if (st.isSymbolicLink()) {
      skipped.push({ path: rel, reason: 'symlink (not followed)' });
      return;
    }
    if (!st.isFile()) return;
    const c = checkConfigPath(rel);
    if (!c.ok) {
      if (!quietIfUnmanaged) skipped.push({ path: rel, reason: c.reason });
      return;
    }
    items.push({ rel, abs, size: st.size, exec: isPosix && (st.mode & 0o111) !== 0 });
  };
  const walk = (relDir: string, depth: number): void => {
    if (depth > 7) return;
    const absDir = path.join(root, ...relDir.split('/'));
    let names: string[];
    try {
      names = readdirSync(absDir).sort();
    } catch {
      return;
    }
    for (const n of names) {
      if (++visited > MAX_WALK_ENTRIES) return;
      const rel = `${relDir}/${n}`;
      const abs = path.join(absDir, n);
      let st: Stats;
      try {
        st = lstatSync(abs);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        skipped.push({ path: rel, reason: 'symlink (not followed)' });
      } else if (st.isDirectory()) {
        if (relDir.startsWith('skills')) walk(rel, depth + 1);
      } else visitFile(rel, abs, st, !relDir.startsWith('skills'));
    }
  };

  try {
    const st = lstatSync(path.join(root, 'CLAUDE.md'));
    visitFile('CLAUDE.md', path.join(root, 'CLAUDE.md'), st, true);
  } catch {
    /* yo'q */
  }
  walk('agents', 0);
  walk('commands', 0);
  walk('skills', 0);
  items.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return { items, skipped };
}

/** Ixtiyoriy mutlaq yo'lga atomik yozuv (settings.json, manifest, zaxira). Nishon symlink bo'lsa xato. Mavjud fayl rejimi saqlanadi (`mode` faqat yangi fayl uchun). */
export function writeFileAtomic(abs: string, content: Buffer | string, mode: number): void {
  mkdirSync(path.dirname(abs), { recursive: true, mode: 0o700 });
  let fileMode = mode;
  try {
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) throw new Error('target is a symlink');
    fileMode = st.mode & 0o777;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const tmp = `${abs}.commander-${randomBytes(6).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'wx', fileMode);
  try {
    writeSync(fd, typeof content === 'string' ? Buffer.from(content, 'utf8') : content);
    try {
      fsyncSync(fd);
    } catch {
      /* fsync yo'q */
    }
  } finally {
    closeSync(fd);
  }
  try {
    if (isPosix) chmodSync(tmp, fileMode);
    renameSync(tmp, abs);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}
