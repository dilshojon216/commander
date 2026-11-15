import { createConnection } from 'node:net';

export { resolveSocketPath } from './socket-path.js';

/**
 * agentd lokal socket'iga (Windows'da named pipe) bitta so'rov yuborish (qatorli JSON). Hech qachon tashlamaydi: har xato `null` (fail-safe).
 * Bog'liqliksiz va tez yuklanadi (faqat node:net).
 */
export interface SendOptions {
  /** Umumiy muddat (ulanish + yozish + javob). */
  timeoutMs: number;
  /** `true`: agentd javobini kutadi va qaytaradi; `false`: yozib bo'lgach tugatadi. */
  waitReply: boolean;
}

export function sendToAgentd(socketPath: string, request: unknown, opts: SendOptions): Promise<unknown> {
  return new Promise((resolve) => {
    let settled = false;
    let out = '';
    const sock = createConnection(socketPath);
    const finish = (value: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), opts.timeoutMs);
    sock.on('error', () => finish(null));
    sock.on('connect', () => {
      sock.write(JSON.stringify(request) + '\n', (err) => {
        if (err) return finish(null);
        if (!opts.waitReply) finish(true);
      });
    });
    sock.on('data', (d: Buffer) => {
      out += d.toString('utf8');
      if (out.includes('\n')) finish(parseReply(out));
    });
    sock.on('end', () => finish(parseReply(out)));
    sock.on('close', () => finish(parseReply(out)));
  });
}

function parseReply(text: string): unknown {
  try {
    return JSON.parse(text.trim());
  } catch {
    return null;
  }
}

/** stdin'ni to'liq o'qiydi (chegara + muddat bilan). Xatoda bo'sh satr. */
export function readStdin(stream: NodeJS.ReadableStream, maxBytes: number, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const timer = setTimeout(finish, timeoutMs);
    stream.on('data', (c: Buffer | string) => {
      const b = typeof c === 'string' ? Buffer.from(c) : c;
      size += b.length;
      if (size > maxBytes) return finish();
      chunks.push(b);
    });
    stream.on('end', finish);
    stream.on('error', finish);
  });
}
