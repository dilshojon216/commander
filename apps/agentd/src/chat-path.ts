import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { ChatErrorCode } from '@commander/contracts';

/**
 * Transcript yo'lini topish va TEKSHIRISH. Center yuborgan `transcriptPath` ishonchsiz kirish deb hisoblanadi:
 * fayl `~/.claude/projects` (yoki `CLAUDE_CONFIG_DIR/projects`) ichida, `<claudeSessionId>.jsonl` nomli oddiy fayl
 * bo'lishi shart (symlink orqali tashqariga chiqish ham rad etiladi: `realpath` dan keyin qayta tekshiriladi).
 * Windows yo'llari: `path` platforma moduli (win32'da registrga befarq, disk harfi/UNC farqi `relative` da ko'rinadi).
 */

export type PathModule = Pick<typeof path, 'relative' | 'isAbsolute' | 'sep' | 'resolve' | 'basename' | 'join'>;

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function claudeProjectsRoot(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const base = env['CLAUDE_CONFIG_DIR'] && env['CLAUDE_CONFIG_DIR'] !== '' ? env['CLAUDE_CONFIG_DIR'] : path.join(home, '.claude');
  return path.join(base, 'projects');
}

/** `target` `root` ning QATI'Y ichida (root'ning o'zi emas) bo'ladimi. */
export function isInside(root: string, target: string, p: PathModule = path): boolean {
  const rel = p.relative(root, target);
  if (rel === '' || p.isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${p.sep}`);
}

export function isValidSessionId(id: string): boolean {
  return SESSION_ID_RE.test(id);
}

export type ResolveResult = { ok: true; path: string } | { ok: false; code: ChatErrorCode };

export interface ResolveOptions {
  root: string;
  claudeSessionId: string;
  /** Center bergan yo'l (ixtiyoriy). */
  hint?: string | undefined;
}

async function verifyFile(rootReal: string, candidate: string, claudeSessionId: string): Promise<ResolveResult> {
  let real: string;
  try {
    real = await realpath(candidate);
  } catch {
    return { ok: false, code: 'not_found' };
  }
  if (!isInside(rootReal, real)) return { ok: false, code: 'forbidden_path' };
  if (path.basename(real) !== `${claudeSessionId}.jsonl`) return { ok: false, code: 'forbidden_path' };
  try {
    if (!(await stat(real)).isFile()) return { ok: false, code: 'forbidden_path' };
  } catch {
    return { ok: false, code: 'not_found' };
  }
  return { ok: true, path: real };
}

export async function resolveTranscript(o: ResolveOptions): Promise<ResolveResult> {
  if (!isValidSessionId(o.claudeSessionId)) return { ok: false, code: 'forbidden_path' };
  let rootReal: string;
  try {
    rootReal = await realpath(o.root);
  } catch {
    return { ok: false, code: 'not_found' };
  }

  if (o.hint !== undefined) {
    // Lug'aviy tekshiruv (fayl tizimiga tegmasdan): tashqi yo'l darhol rad etiladi, qidiruvga qaytilmaydi.
    const abs = path.resolve(o.hint);
    if (!isInside(path.resolve(o.root), abs) && !isInside(rootReal, abs)) return { ok: false, code: 'forbidden_path' };
    const r = await verifyFile(rootReal, abs, o.claudeSessionId);
    if (r.ok || r.code === 'forbidden_path') return r;
    // hint ichkarida, lekin fayl yo'q: qidiruvga o'tamiz
  }

  let dirs: string[];
  try {
    dirs = (await readdir(rootReal, { withFileTypes: true })).filter((d) => d.isDirectory() || d.isSymbolicLink()).map((d) => d.name);
  } catch {
    return { ok: false, code: 'not_found' };
  }
  let best: { path: string; mtime: number } | undefined;
  for (const d of dirs) {
    const r = await verifyFile(rootReal, path.join(rootReal, d, `${o.claudeSessionId}.jsonl`), o.claudeSessionId);
    if (!r.ok) continue;
    const mtime = (await stat(r.path)).mtimeMs;
    if (!best || mtime > best.mtime) best = { path: r.path, mtime };
  }
  return best ? { ok: true, path: best.path } : { ok: false, code: 'not_found' };
}
