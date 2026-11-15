import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import { normalizeProjectPath } from '@commander/contracts/ipc';

/** Windows'da `C:\PROGRA~1` kabi qisqa nomlar va katta-kichik harflarni haqiqiy yozilishga keltiradi; xatoda o'zini qaytaradi. */
function nativeRealpath(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

/**
 * `cwd` -> loyiha ildizi: yuqoriga qarab `.git` (papka yoki worktree/submodule fayli) topilgan birinchi papka
 * (= `git rev-parse --show-toplevel`, lekin jarayon ishga tushirmasdan: git yo'q mashinada ham bir xil ishlaydi). Topilmasa `cwd` o'zi.
 * Natija keshlanadi. Hodisa va usage BIR XIL ildizni yuboradi (center atributsiyasi shunga tayanadi, PLAN "Qarorlar (1.4)").
 *
 * Windows: kirish (`C:\Users\x\p`, `c:/users/x/p`, `C:\Users\X~1\p`) avval `realpath.native` bilan haqiqiy yozilishga, so'ng
 * `normalizeProjectPath` bilan yagona ko'rinishga (`C:/Users/x/p`, `/` ajratgich, katta disk harfi) keltiriladi: bitta loyiha ikkiga bo'linmaydi.
 * POSIX'da hech narsa o'zgarmaydi.
 */
export class ProjectRootResolver {
  private readonly cache = new Map<string, string>();

  constructor(
    private readonly exists: (p: string) => boolean = existsSync,
    private readonly maxEntries = 2000,
    /** Bu papkadagi `.git` (masalan dotfiles repo) ildiz hisoblanmaydi, faqat cwd o'zi bo'lsa. */
    private readonly ignoreAbove: string = homedir(),
    private readonly platform: string = process.platform,
    private readonly canonicalize: (p: string) => string = nativeRealpath,
  ) {}

  /** `resolve(cwd)` natijasi git ildizimi (`.git` bor) yoki oddiy papka. */
  kind(cwd: string): 'git' | 'dir' {
    const root = this.resolve(cwd);
    const join = this.platform === 'win32' ? win32.join : posix.join;
    return this.exists(join(root, '.git')) ? 'git' : 'dir';
  }

  resolve(cwd: string): string {
    const hit = this.cache.get(cwd);
    if (hit !== undefined) return hit;
    const win = this.platform === 'win32';
    const { dirname, join } = win ? win32 : posix;
    const start = win ? this.canonicalize(cwd) : cwd;
    const stop = win ? normalizeProjectPath(this.ignoreAbove, 'win32').toLowerCase() : this.ignoreAbove;
    const same = (a: string, b: string): boolean => (win ? normalizeProjectPath(a, 'win32').toLowerCase() === b : a === b);
    let root = start;
    let dir = start;
    for (let i = 0; i < 64; i++) {
      if ((dir === start || !same(dir, stop)) && this.exists(join(dir, '.git'))) {
        root = dir;
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    const result = normalizeProjectPath(root, this.platform);
    if (this.cache.size >= this.maxEntries) this.cache.clear();
    this.cache.set(cwd, result);
    return result;
  }
}
