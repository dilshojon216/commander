import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import { APPROVAL_LIMITS } from '@commander/contracts';
import type { ApprovalTarget } from '@commander/contracts';
import { redact } from './redact.js';

/**
 * Fayl vositalari uchun avto-ruxsat qoidalariga (2.13) beriladigan KICHIK maslahat: xom kiritma EMAS.
 * Faqat quyidagi vositalar uchun hisoblanadi; boshqalarda `undefined` (markaz hech qachon avto-ruxsat bermaydi).
 *
 * Qoidalar:
 *  - yo'l `cwd`ga nisbatan hal qilinadi, symlink'lar (mavjud eng yaqin ota-ona orqali) `realpath` bilan ochiladi:
 *    cwd ichidagi symlink tashqariga olib borsa `insideCwd=false`;
 *  - tashqarida/noaniq (NUL, `~`, matn bo'lmagan qiymat, cwd yo'q, redakt o'zgartirgan yo'l): `{path:null, insideCwd:false}`;
 *    tashqi yo'l markazga YUBORILMAYDI;
 *  - natija: posix nisbiy yo'l (`.` = cwd o'zi), <= 1024 belgi.
 */
const PATH_FIELD: Record<string, string> = {
  Edit: 'file_path',
  Write: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
  Read: 'file_path',
  Glob: 'path',
  Grep: 'path',
};
/** Glob/Grep: `path` ixtiyoriy (default cwd). */
const DEFAULT_TO_CWD = new Set(['Glob', 'Grep']);

export interface TargetFs {
  realpath(p: string): string;
}
const realFs: TargetFs = { realpath: (p) => nodeFs.realpathSync(p) };

const OUTSIDE: ApprovalTarget = { path: null, insideCwd: false };

/** Mavjud eng yaqin ota-onani `realpath` qiladi, qolgan (hali yo'q) qismini qo'shadi. */
function resolveReal(abs: string, fs: TargetFs, p: typeof nodePath): string {
  let head = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = fs.realpath(head);
      return tail.length === 0 ? real : p.join(real, ...tail.reverse());
    } catch {
      const parent = p.dirname(head);
      if (parent === head) return abs; // ildizga yetdik: hal qilib bo'lmadi
      tail.push(p.basename(head));
      head = parent;
    }
  }
}

export function computeApprovalTarget(
  toolName: string,
  toolInput: unknown,
  cwd: string | null | undefined,
  deps: { fs?: TargetFs; path?: typeof nodePath } = {},
): ApprovalTarget | undefined {
  const field = PATH_FIELD[toolName];
  if (!field) return undefined;
  const p = deps.path ?? nodePath;
  const fs = deps.fs ?? realFs;
  if (typeof cwd !== 'string' || cwd.length === 0 || !p.isAbsolute(cwd)) return OUTSIDE;

  let raw: unknown = typeof toolInput === 'object' && toolInput !== null ? (toolInput as Record<string, unknown>)[field] : undefined;
  if ((raw === undefined || raw === null) && DEFAULT_TO_CWD.has(toolName)) raw = '.';
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 4096) return OUTSIDE;
  if (raw.includes('\0') || raw.startsWith('~')) return OUTSIDE;

  const absCwd = p.resolve(cwd);
  const abs = p.resolve(absCwd, raw);
  const realCwd = resolveReal(absCwd, fs, p);
  const realAbs = resolveReal(abs, fs, p);
  const rel = p.relative(realCwd, realAbs);
  const inside = rel === '' || (rel !== '..' && !rel.startsWith(`..${p.sep}`) && !p.isAbsolute(rel));
  if (!inside) return OUTSIDE;

  const posix = rel === '' ? '.' : rel.split(p.sep).join('/');
  if (posix.length > APPROVAL_LIMITS.targetPathMaxChars) return OUTSIDE;
  // Yo'l nomida sir shakli bo'lsa (token ko'rinishidagi fayl nomi) avto-ruxsat uchun ishonchsiz: yubormaymiz.
  if (redact(posix) !== posix) return OUTSIDE;
  return { path: posix, insideCwd: true };
}
