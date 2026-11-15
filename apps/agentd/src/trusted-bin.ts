import { statSync } from 'node:fs';
import { isAbsolute, posix, win32 } from 'node:path';

/**
 * Ishonchli ijrochi fayllar (M-18, review 2026-11-14). Windows'da (libuv `uv_spawn`) bare `git`/`gh`/`claude` AVVAL child'ning
 * `cwd`sida qidiriladi: begona repo ildizidagi `git.exe` agentd'ning har snapshot'ida ishga tushadi. Shuning uchun git/gh/claude/tmux
 * agentd ishga tushganda PATH'dan BIR MARTA ABSOLYUT yo'lga aylantiriladi va hamma joyda faqat shu yo'l ishlatiladi
 * (absolyut yo'lda cwd/PATH qidiruvi yo'q). PATH'dan chiqarib tashlanadi: bo'sh/nisbiy yozuvlar (`.`, `bin`), agentd cwd'si va uning
 * ichidagi papkalar, qo'shimcha `excludeDirs` (loyiha ildizlari). Windows'da qo'shimcha `NoDefaultCurrentDirectoryInExePath=1`.
 *
 * Chegara: PATH'ning o'zi (env) ishonchli deb hisoblanadi; PATH ga yozish huquqi bor hujumchi bu qatlamdan o'tadi.
 */

export interface FindBinOptions {
  /** Muhit (`PATH`, `PATHEXT`). */
  env?: NodeJS.ProcessEnv;
  platform?: string;
  /** Joriy ishchi papka: o'zi va ichidagi PATH yozuvlari rad etiladi. */
  cwd?: string;
  /** Qo'shimcha rad etiladigan papkalar (loyiha ildizlari). */
  excludeDirs?: readonly string[];
  /** Testlar uchun: fayl bormi. */
  isFile?: (path: string) => boolean;
}

const defaultIsFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** Windows'da qidiriladigan kengaytmalar (`.exe` birinchi; `.cmd`/`.bat` shim'lar `claude` uchun). */
function winExts(allowShims: boolean): string[] {
  const exts = ['.exe'];
  if (allowShims) exts.push('.cmd', '.bat');
  return exts;
}

function isInside(dir: string, parent: string, platform: string): boolean {
  const p = platform === 'win32' ? win32 : posix;
  const rel = p.relative(parent, dir);
  const norm = platform === 'win32' ? rel.toLowerCase() : rel;
  return norm === '' || (!norm.startsWith('..') && !p.isAbsolute(norm));
}

/** `name` ni ishonchli PATH'dan topadi (absolyut yo'l) yoki `undefined`. */
export function findTrustedBin(name: string, opts: FindBinOptions & { allowShims?: boolean } = {}): string | undefined {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const isFile = opts.isFile ?? defaultIsFile;
  const path = platform === 'win32' ? win32 : posix;
  const cwd = opts.cwd ?? process.cwd();
  const banned = [cwd, ...(opts.excludeDirs ?? [])].filter((d) => d.length > 0);
  const listSep = platform === 'win32' ? ';' : ':';
  const rawPath = (platform === 'win32' ? (env['Path'] ?? env['PATH']) : env['PATH']) ?? '';
  const exts = platform === 'win32' ? winExts(opts.allowShims === true) : [''];
  const seen = new Set<string>();
  for (const entry of rawPath.split(listSep)) {
    const dir = entry.trim().replace(/^"(.*)"$/, '$1');
    if (dir === '' || !path.isAbsolute(dir)) continue; // bo'sh va nisbiy (`.`) yozuvlar cwd degani
    const norm = path.normalize(dir);
    if (seen.has(norm)) continue;
    seen.add(norm);
    if (banned.some((b) => path.isAbsolute(b) && isInside(norm, path.normalize(b), platform) && path.normalize(b) !== path.parse(path.normalize(b)).root)) continue;
    for (const ext of exts) {
      const candidate = path.join(norm, name + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

export type TrustedName = 'git' | 'gh' | 'claude' | 'tmux' | 'docker' | 'journalctl' | 'systemctl';

/** 6.6: launchd/systemd daemon PATH'i qisqa bo'ladi; docker/journalctl/systemctl uchun odatiy tizim papkalari (faqat PATH'da topilmasa). */
const SYSTEM_BIN_DIRS = ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin', '/Applications/Docker.app/Contents/Resources/bin'];
const SYSTEM_BIN_NAMES: readonly TrustedName[] = ['docker', 'journalctl', 'systemctl'];

const cache = new Map<string, string | null>();
let extraExclude: string[] = [];

/** Kesh/istisnolarni tiklash (testlar). */
export function resetTrustedBins(excludeDirs: string[] = []): void {
  cache.clear();
  extraExclude = excludeDirs;
}

/** Ishonchli absolyut yo'l (keshlangan: birinchi chaqiruvda PATH skanerlanadi). Topilmasa `undefined`. */
export function trustedBin(name: TrustedName): string | undefined {
  if (!cache.has(name)) {
    let found = findTrustedBin(name, { excludeDirs: extraExclude, allowShims: name === 'claude' });
    if (!found && process.platform !== 'win32' && SYSTEM_BIN_NAMES.includes(name)) {
      found = findTrustedBin(name, { env: { PATH: SYSTEM_BIN_DIRS.join(':') }, excludeDirs: extraExclude });
    }
    cache.set(name, found ?? null);
  }
  return cache.get(name) ?? undefined;
}

/**
 * Ijro uchun yo'l: absolyut bo'lsa o'zi; bare nom bo'lsa ishonchli yo'l (yo'q bo'lsa `undefined`).
 * Separator'li nisbiy yo'l (`./git`) HECH QACHON qabul qilinmaydi (cwd'ga bog'liq).
 */
export function resolveExecutable(bin: string, name: TrustedName): string | undefined {
  if (isAbsolute(bin) || win32.isAbsolute(bin)) return bin;
  if (bin.includes('/') || bin.includes('\\')) return undefined;
  return trustedBin(name);
}

/** Windows'da child'ning ham cwd'dan exe qidirishini o'chiradi. */
export function safeExecEnv(env: NodeJS.ProcessEnv, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...env, ...extra, NoDefaultCurrentDirectoryInExePath: '1' };
}

