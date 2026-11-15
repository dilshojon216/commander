import { execFile } from 'node:child_process';

/** Tashqi buyruq ijrochisi (shell yo'q, argument massivi). Testlarda almashtiriladi; xato = reject. */
export type HealthExec = (file: string, args: string[], opts?: { timeoutMs?: number }) => Promise<string>;

export class ExecError extends Error {
  constructor(
    message: string,
    readonly code: 'not_found' | 'timeout' | 'failed',
    /** stderr (faqat qisqa, sirlarsiz holatda log uchun emas: kod tarmoqqa yubormaydi). */
    readonly stderr: string = '',
  ) {
    super(message);
    this.name = 'ExecError';
  }
}

export const DEFAULT_EXEC_TIMEOUT_MS = 8_000;

/** `execFile` asosidagi ijrochi: 4 MiB chiqish, taymaut, Windows'da konsol oynasisiz. */
export const nodeExec: HealthExec = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: opts?.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        const e = err as NodeJS.ErrnoException & { killed?: boolean };
        if (e.code === 'ENOENT') return reject(new ExecError(`${file}: not found`, 'not_found'));
        if (e.killed) return reject(new ExecError(`${file}: timeout`, 'timeout'));
        reject(new ExecError(`${file}: exit ${String(e.code ?? '?')}`, 'failed', String(stderr).slice(0, 300)));
      },
    );
  });
