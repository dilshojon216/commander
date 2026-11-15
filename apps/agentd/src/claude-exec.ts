import { execFile, type ExecFileOptions } from 'node:child_process';
import { resolveExecutable, safeExecEnv } from './trusted-bin.js';

/**
 * `claude` ni xavfsiz ishga tushirish. POSIX va `claude.exe`: to'g'ridan-to'g'ri `execFile` (shell YO'Q).
 * Windows'da `.cmd`/`.bat` ni Node (CVE-2024-27980 dan keyin) shell'siz ochmaydi (EINVAL), shuning uchun `cmd.exe /d /s /c`
 * orqali, lekin shell-injection'siz: (1) bin yo'li qat'iy tekshiriladi (cmd metabelgilari `" % ^ & | < > ! ( )` va
 * boshqaruv belgilari YO'Q), (2) argumentlar faqat sobit literal (`^[A-Za-z0-9-]+$`), foydalanuvchi kiritishi hech qachon qo'shilmaydi.
 */
const SAFE_BIN = /^[^"%^&|<>!()\r\n\0]+$/;
const SAFE_ARG = /^[A-Za-z0-9-]+$/;

export interface ClaudeCommand {
  file: string;
  args: string[];
  options: Pick<ExecFileOptions, 'windowsVerbatimArguments'>;
}

export function buildClaudeCommand(bin: string, args: readonly string[], platform: string = process.platform, comspec: string | undefined = process.env['ComSpec']): ClaudeCommand {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(bin)) {
    if (!SAFE_BIN.test(bin)) throw new Error('claudeBin yo\'lida xavfli belgilar bor (cmd.exe orqali ishga tushirilmaydi)');
    for (const a of args) if (!SAFE_ARG.test(a)) throw new Error(`claude argumenti sobit literal bo'lishi kerak: ${a}`);
    // cmd /s tashqi juft qo'shtirnoqni olib tashlaydi: `""C:\x y\claude.cmd" agents --json"` -> `"C:\x y\claude.cmd" agents --json`
    return { file: comspec || 'cmd.exe', args: ['/d', '/s', '/c', `""${bin}" ${args.join(' ')}"`], options: { windowsVerbatimArguments: true } };
  }
  return { file: bin, args: [...args], options: {} };
}

export interface RunClaudeOptions {
  timeout: number;
  maxBuffer?: number;
  /** Ishchi papka (masalan `--bg` sessiya shu papkada ochiladi). */
  cwd?: string;
  /** Qo'shimcha muhit o'zgaruvchilari (`process.env` ustiga). */
  env?: Record<string, string>;
}

/** `claude <args>` -> stdout. Xato/timeout -> tashlaydi. */
export function runClaude(binArg: string, args: readonly string[], opts: RunClaudeOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    // M-18: Windows'da bare `claude` child cwd'sida qidirilardi; absolyut yo'l (ishonchli PATH) majburiy. POSIX'da bare nom ham
    // ishonchli PATH orqali absolyutga aylantiriladi, topilmasa oldingi xatti-harakat (PATH, ENOENT).
    const resolved = resolveExecutable(binArg, 'claude');
    if (!resolved && process.platform === 'win32') return reject(new Error('claude not found in the trusted PATH (set an absolute claudeBin)'));
    const bin = resolved ?? binArg;
    let cmd: ClaudeCommand;
    try {
      cmd = buildClaudeCommand(bin, args);
    } catch (e) {
      return reject(e instanceof Error ? e : new Error(String(e)));
    }
    execFile(
      cmd.file,
      cmd.args,
      { timeout: opts.timeout, ...(opts.maxBuffer ? { maxBuffer: opts.maxBuffer } : {}), ...(opts.cwd ? { cwd: opts.cwd } : {}), env: safeExecEnv(process.env, opts.env ?? {}), windowsHide: true, ...cmd.options },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
}
