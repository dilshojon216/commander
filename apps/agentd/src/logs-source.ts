import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { LOG_LIMITS, LOG_NAME_RE, LOG_SINCE_RE } from '@commander/contracts';
import type { LogSource } from '@commander/contracts';
import { isInside, realPathOps, sensitiveDirs } from './policy.js';
import type { PathOps } from './policy.js';
import { redact } from './redact.js';

/**
 * Log ko'ruvchi (6.6) sof yordamchilari: nom/ro'yxat tekshiruvi, `since` aylantirish, fayl yo'li ruxsati, qator redaksiyasi.
 * Hech narsa shell orqali ishlamaydi; nomlar faqat CLI'dan olingan ro'yxatdagi aniq mosliklar bo'lgandagina argumentga tushadi.
 */

// --- nomlar -------------------------------------------------------------------------------------

/** `docker ps -a --format {{.Names}}` chiqishi -> yaroqli nomlar (har qator alohida; regex'ga mos kelmaganlari tashlanadi). */
export function parseDockerNames(out: string): string[] {
  const names = new Set<string>();
  for (const raw of out.split('\n')) {
    const n = raw.trim();
    if (LOG_NAME_RE.test(n)) names.add(n);
  }
  return [...names];
}

const UNIT_RE = /^[A-Za-z0-9:_.@-]{1,200}\.[a-z]{2,16}$/;

/** `systemctl list-units --plain --no-legend` chiqishi -> unit nomlari (birinchi ustun; belgi/bullet o'tkazib yuboriladi). */
export function parseUnitNames(out: string): string[] {
  const units = new Set<string>();
  for (const raw of out.split('\n')) {
    const tokens = raw.trim().split(/\s+/).slice(0, 2);
    const hit = tokens.find((t) => UNIT_RE.test(t));
    if (hit) units.add(hit);
  }
  return [...units];
}

/** Foydalanuvchi `nginx` yoki `nginx.service` desa ham ro'yxatdagi aniq unit nomini topadi (aks holda `undefined`). */
export function matchUnit(name: string, units: readonly string[]): string | undefined {
  if (!LOG_NAME_RE.test(name)) return undefined;
  const candidates = name.includes('.') ? [name] : [`${name}.service`];
  return candidates.find((c) => units.includes(c));
}

// --- since ---------------------------------------------------------------------------------------

const REL_UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** `since` -> epoch ms (nisbiy bo'lsa `now` dan orqaga). Yaroqsiz -> `undefined`. */
export function parseSince(since: string, now: number): number | undefined {
  if (!LOG_SINCE_RE.test(since)) return undefined;
  const rel = /^(\d{1,4})([smhd])$/.exec(since);
  if (rel) return now - Number(rel[1]) * REL_UNIT_MS[rel[2]!]!;
  const iso = since.replace(' ', 'T');
  const hasZone = /Z$/.test(iso);
  // sana-vaqt (zonasiz) UTC deb olinadi (aniq va qurilmaga bog'liq emas)
  const ms = Date.parse(hasZone ? iso : `${iso.length === 10 ? `${iso}T00:00:00` : iso.length === 16 ? `${iso}:00` : iso}Z`);
  return Number.isNaN(ms) ? undefined : ms;
}

export function dockerSince(ms: number): string {
  return new Date(ms).toISOString();
}
export function journalSince(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

// --- fayl yo'li ----------------------------------------------------------------------------------

/** Standart ruxsat etilgan log ildizi: macOS `~/Library/Logs/commander` (Commander'ning o'z loglari). */
export function defaultLogRoots(home: string, platform: string): string[] {
  return platform === 'darwin' ? [join(home, 'Library', 'Logs', 'commander')] : [];
}

export function effectiveLogRoots(policyRoots: readonly string[], home: string, platform: string): string[] {
  return [...new Set([...policyRoots, ...defaultLogRoots(home, platform)])];
}

export type LogFileCheck =
  | { ok: true; real: string }
  | { ok: false; code: 'logs_not_allowed' | 'file_not_found' | 'path_invalid'; message: string };

const defaultIsRegularFile = (p: string): boolean => {
  try {
    return lstatSync(p).isFile();
  } catch {
    return false;
  }
};

/**
 * Fayl ruxsati: mutlaq yo'l, realpath'dan (symlink/`..` hal bo'lgach) keyin oddiy fayl bo'lishi, maxfiy papka (`~/.ssh`, `~/.claude` ...)
 * bo'lmasligi va ruxsat etilgan log ildizlaridan birining ICHIDA bo'lishi shart. Ildizlar ham realpath qilinadi (mavjud bo'lmagani
 * o'tkazib yuboriladi). Ildizlar ro'yxati bo'sh bo'lsa hech narsaga ruxsat yo'q.
 */
export function checkLogFile(
  file: string,
  roots: readonly string[],
  ops: PathOps = realPathOps,
  sensitive: readonly string[] = sensitiveDirs(),
  isRegularFile: (real: string) => boolean = defaultIsRegularFile,
): LogFileCheck {
  if (file.includes('\0') || !ops.lib.isAbsolute(file)) return { ok: false, code: 'path_invalid', message: 'the log path must be absolute' };
  let real: string;
  try {
    real = ops.realpath(file);
  } catch {
    return { ok: false, code: 'file_not_found', message: 'the log file does not exist' };
  }
  for (const s of sensitive) {
    let rs = s;
    try {
      rs = ops.realpath(s);
    } catch {
      /* mavjud emas: matn bo'yicha */
    }
    if (isInside(rs, real, ops.lib, ops.caseInsensitive)) return { ok: false, code: 'logs_not_allowed', message: 'the file is inside a protected directory' };
  }
  const inside = roots.some((root) => {
    try {
      return isInside(ops.realpath(root), real, ops.lib, ops.caseInsensitive);
    } catch {
      return false;
    }
  });
  if (!inside) return { ok: false, code: 'logs_not_allowed', message: 'the file is outside the allowed log roots of the local policy (agentd policy allow-log-root)' };
  if (!isRegularFile(real)) return { ok: false, code: 'path_invalid', message: 'the path is not a regular file' };
  return { ok: true, real };
}

// --- qatorlar ------------------------------------------------------------------------------------

const ANSI = /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001b]{0,200}(?:\u0007|\u001b\\)|[@-Z\\-_])/g;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
const PEM_BEGIN = /-----BEGIN [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----/;
const PEM_END = /-----END [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----/;
/** Redaksiyadan OLDIN qator shu uzunlikda kesiladi (juda uzun qator regex'larni sekinlashtirmasin). Yakuniy chegara `lineMaxChars` undan kichik. */
const PRE_CUT = 16_000;
const TRUNC_MARK = '…[truncated]';
/** PEM kaliti tugamasa shuncha qatordan keyin "ichida" holati tozalanadi. */
const MAX_KEY_LINES = 400;

/**
 * Qator redaktori (holatli). `redact()` bitta qator ichidagi sirlarni maskalaydi; ko'p qatorli PEM kaliti uchun qo'shimcha holat:
 * `BEGIN ... PRIVATE KEY` dan `END` gacha bo'lgan qatorlar chiqarilmaydi (bo'laklar/chunk chegarasidan oshsa ham oqib ketmaydi).
 * ANSI/boshqaruv belgilari olib tashlanadi. Redaksiyadan KEYIN kesiladi (yarim token ochiq qolmasin).
 */
export class LogRedactor {
  private inKey = false;
  private keyLines = 0;

  lines(raw: readonly string[]): string[] {
    const out: string[] = [];
    for (const r of raw) {
      let line = r.length > PRE_CUT ? r.slice(0, PRE_CUT) : r;
      line = line.replace(ANSI, '').replace(CONTROL, '');
      if (this.inKey) {
        this.keyLines++;
        if (PEM_END.test(line) || this.keyLines > MAX_KEY_LINES) this.inKey = false;
        continue;
      }
      if (PEM_BEGIN.test(line) && !PEM_END.test(line)) {
        this.inKey = true;
        this.keyLines = 0;
      }
      let red = redact(line);
      if (red.length > LOG_LIMITS.lineMaxChars) red = red.slice(0, LOG_LIMITS.lineMaxChars) + TRUNC_MARK;
      out.push(red);
    }
    return out;
  }
}

/** Bayt oqimi -> qatorlar (UTF-8 chegarasi saqlanadi; tugallanmagan qator keyingi bo'lakka o'tadi, juda uzuni majburan kesiladi). */
export class LineSplitter {
  private readonly dec = new StringDecoder('utf8');
  private rest = '';

  constructor(private readonly maxPartial = 64 * 1024) {}

  push(chunk: Buffer): string[] {
    const text = this.rest + this.dec.write(chunk);
    const parts = text.split('\n');
    this.rest = parts.pop() ?? '';
    const out = parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
    if (this.rest.length > this.maxPartial) {
      out.push(this.rest);
      this.rest = '';
    }
    return out;
  }

  end(): string[] {
    const tail = this.rest + this.dec.end();
    this.rest = '';
    return tail.length > 0 ? [tail] : [];
  }
}

/** Bufer matnidan oxirgi `n` qator (fayl "tail"); `complete=false` bo'lsa birinchi (to'liq bo'lmasligi mumkin) qator tashlanadi. */
export function lastLines(text: string, n: number, complete: boolean): string[] {
  const parts = text.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  if (!complete && parts.length > 0) parts.shift();
  return parts.slice(-n).map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** Chunk uchun bayt hajmi. */
export const lineBytes = (l: string): number => Buffer.byteLength(l, 'utf8') + 1;

/** Manba -> inson tushunadigan nom (log/audit uchun; fayl yo'li ham nom hisoblanadi, matn emas). */
export const describeSource = (s: LogSource, name: string): string => `${s}:${name.slice(0, 200)}`;
