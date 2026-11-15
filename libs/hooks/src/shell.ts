import { existsSync } from 'node:fs';
import { win32 } from 'node:path';

/**
 * Foydalanuvchining status line buyrug'i qaysi shell'da bajariladi.
 *  - POSIX: `/bin/sh -c` (avvalgidek).
 *  - Windows: Claude Code hook va statusLine buyruqlarini Git Bash orqali ishga tushiradi (2026-11-13 da win-pc'da
 *    tekshirilgan: `$BASH_VERSION` o'rnatilgan, `%COMSPEC%` kengaymagan). Foydalanuvchi buyrug'i bash sintaksisida yozilgani uchun
 *    biz ham AYNAN Git Bash'ni topamiz: `CLAUDE_CODE_GIT_BASH_PATH`, keyin Git'ning standart joylari.
 *    `C:\Windows\System32\bash.exe` (WSL) HECH QACHON ishlatilmaydi. Topilmasa `null` (chaqiruvchi cmd.exe'ga qaytadi).
 */
export interface ShellSpec {
  file: string;
  /** Buyruq matnidan OLDIN beriladigan argumentlar (`-c`). */
  args: string[];
}

export function resolveShell(
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = existsSync,
): ShellSpec | null {
  if (platform !== 'win32') return { file: '/bin/sh', args: ['-c'] };
  const candidates = [
    env['CLAUDE_CODE_GIT_BASH_PATH'],
    ...[env['ProgramFiles'], env['ProgramFiles(x86)'], env['ProgramW6432']].map((d) => (d ? win32.join(d, 'Git', 'bin', 'bash.exe') : undefined)),
    env['LOCALAPPDATA'] ? win32.join(env['LOCALAPPDATA'], 'Programs', 'Git', 'bin', 'bash.exe') : undefined,
  ];
  for (const c of candidates) {
    if (c && !/[\\/]system32[\\/]/i.test(c) && exists(c)) return { file: c, args: ['-c'] };
  }
  return null;
}
