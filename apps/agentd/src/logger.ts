/**
 * Oddiy strukturali logger (stderr). Kalitlar, tokenlar va enrollment kodi HECH QACHON logga yozilmaydi:
 * chaqiruvchi faqat xavfsiz maydonlarni uzatadi.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(context: string): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  context?: string;
  write?: (line: string) => void;
  now?: () => Date;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const level = opts.level ?? parseLevel(process.env['AGENTD_LOG_LEVEL']);
  const write = opts.write ?? ((line: string) => void process.stderr.write(line + '\n'));
  const now = opts.now ?? (() => new Date());
  const context = opts.context ?? 'agentd';

  const emit = (lvl: LogLevel, msg: string, fields?: Record<string, unknown>): void => {
    if (ORDER[lvl] < ORDER[level]) return;
    const extra = fields && Object.keys(fields).length > 0 ? ' ' + safeJson(fields) : '';
    write(`${now().toISOString()} ${lvl.toUpperCase()} [${context}] ${msg}${extra}`);
  };

  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (ctx) => createLogger({ level, context: `${context}:${ctx}`, write, now }),
  };
}

export function parseLevel(value: string | undefined): LogLevel {
  return value === 'debug' || value === 'warn' || value === 'error' ? value : 'info';
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '"[unserializable]"';
  }
}

/** Xato obyektidan faqat xabar (stack emas, ichida sir bo'lishi mumkin emas, lekin shovqin ham yo'q). */
export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const silentLogger: Logger = createLogger({ level: 'error', write: () => undefined });
