import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, openSync, readFileSync, writeSync } from 'node:fs';
import type { AgentdPaths } from './paths.js';

const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;

/**
 * OTLP mashina tokeni (M-20): `~/.commander/otlp-token` (0600, 32 tasodifiy bayt, base64url). Yo'q bo'lsa `wx` bilan YARATILADI
 * (ops skripti va agentd bir vaqtda yaratsa ham bittasi yutadi, ikkinchisi o'qiydi). Claude Code'ga
 * `OTEL_EXPORTER_OTLP_HEADERS=x-commander-token=<token>` sifatida settings.json `env` orqali beriladi. Bu foydalanuvchining o'zi
 * uchun sir EMAS (settings.json o'qiladi); maqsad: boshqa lokal jarayon/veb sahifa soxta usage yoza olmasin.
 */
export function loadOrCreateOtlpToken(paths: Pick<AgentdPaths, 'otlpTokenFile'>): string {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const existing = readFileSync(paths.otlpTokenFile, 'utf8').trim();
      if (TOKEN_RE.test(existing)) return existing;
      throw new Error('otlp-token fayli yaroqsiz');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const token = randomBytes(32).toString('base64url');
    try {
      const fd = openSync(paths.otlpTokenFile, 'wx', 0o600);
      try {
        writeSync(fd, `${token}\n`);
      } finally {
        closeSync(fd);
      }
      try {
        chmodSync(paths.otlpTokenFile, 0o600);
      } catch {
        /* Windows */
      }
      return token;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err; // boshqa jarayon yaratdi: qayta o'qiymiz
    }
  }
  throw new Error('otlp-token yaratib bo\'lmadi');
}
