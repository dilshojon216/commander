import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { isWindowsPipePath } from '@commander/contracts/ipc';
import { z } from 'zod';
import type { HookConn } from './approval-manager.js';
import type { MailboxConn } from './mailbox-handler.js';
import { errMsg, type Logger } from './logger.js';
import type { PeerAttestor } from './peer-identity.js';

/**
 * Lokal Unix socket (`~/.commander/agentd.sock`, 0600) yoki Windows named pipe (`\\.\pipe\commander-agentd-<user>`; fayl emas,
 * shuning uchun chmod/stale-fayl/unlink YO'Q; ikkinchi agentd `EADDRINUSE` oladi). Protokol: bitta qatorli JSON so'rov, bitta qatorli JSON javob.
 *   { v: 1, kind: 'hook' | 'statusline' | 'status', payload?: ... }  ->  { ok: boolean, ... }
 * `kind: 'mailbox'` (2.10): so'rov/javob; javob center javobini kutgach keladi (handler muddatlari: hook 3.5 s, vosita 8 s).
 * Mijoz (cc-hook / cc-statusline) yozib `end()` qiladi. `kind: 'permission'` (task 1.7) ISTISNO: ulanish qaror kelgunicha OCHIQ turadi
 * (javob bitta qator, keyin yopiladi); mijoz `end()` QILMASLIGI shart, uzilishi esa "lokal hal bo'ldi" signali.
 */
export const SOCKET_MAX_REQUEST_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 5000;
const MAILBOX_SOCKET_TIMEOUT_MS = 15_000;

export const SocketRequestSchema = z.object({
  v: z.literal(1),
  kind: z.enum(['hook', 'statusline', 'status', 'permission', 'mailbox', 'rotate-key']),
  payload: z.unknown().optional(),
  /** Faqat `permission`: cc-hook kutadigan muddat (ms); agentd chegaralaydi. */
  deadlineMs: z.number().optional(),
});
export type SocketRequest = z.infer<typeof SocketRequestSchema>;

export interface HookServerHandlers {
  onHook(payload: unknown): void;
  onStatusline(payload: unknown): void;
  onPermission(payload: unknown, deadlineMs: unknown, conn: HookConn): void;
  /** Sessiyalararo xabar (2.10): cc-mcp va `cc-hook --inbox*`. Ulanish javobgacha ochiq; handler har doim bir marta javob beradi. */
  onMailbox?(payload: unknown, conn: MailboxConn): void;
  /** `agentd rotate-key` (5.1): qurilma kalitini aylantiradi; javob natijadan keyin keladi. */
  onRotateKey?(): Promise<{ ok: boolean; fingerprint?: string; reason?: string }>;
  status(): Record<string, unknown>;
}

export class HookServer {
  private server: Server | undefined;
  private readonly isPipe: boolean;

  constructor(
    private readonly socketPath: string,
    private readonly handlers: HookServerHandlers,
    private readonly log: Logger,
    /** M-14: peer pid attestatsiyasi (mailbox so'rovlari uchun). Berilmasa `conn.peer` yo'q. */
    private readonly attestor?: PeerAttestor,
  ) {
    this.isPipe = isWindowsPipePath(socketPath);
  }

  async start(): Promise<void> {
    if (!this.isPipe) await this.removeStaleSocket();
    const server = createServer((socket) => this.onConnection(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    if (!this.isPipe) chmodSync(this.socketPath, 0o600);
    server.on('error', (err) => this.log.error('hook socket xatosi', { error: errMsg(err) }));
    this.log.info('hook socket tinglayapti', { path: this.socketPath });
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (this.isPipe) return; // pipe jarayon bilan yo'qoladi
    try {
      if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
    } catch {
      /* allaqachon o'chirilgan */
    }
  }

  private async removeStaleSocket(): Promise<void> {
    if (!existsSync(this.socketPath)) return;
    const alive = await new Promise<boolean>((resolve) => {
      const c = createConnection(this.socketPath);
      const done = (v: boolean): void => {
        c.destroy();
        resolve(v);
      };
      c.once('connect', () => done(true));
      c.once('error', () => done(false));
      setTimeout(() => done(false), 1000).unref();
    });
    if (alive) throw new Error(`boshqa agentd ${this.socketPath} da allaqachon ishlayapti`);
    unlinkSync(this.socketPath);
  }

  private onConnection(socket: Socket): void {
    const chunks: Buffer[] = [];
    let size = 0;
    let handled = false;
    socket.setTimeout(REQUEST_TIMEOUT_MS, () => socket.destroy());
    socket.on('error', () => socket.destroy());

    const handle = (): void => {
      if (handled) return;
      handled = true;
      const reply = this.dispatch(Buffer.concat(chunks).toString('utf8'), socket);
      if (reply) socket.end(JSON.stringify(reply) + '\n');
    };

    socket.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > SOCKET_MAX_REQUEST_BYTES) {
        handled = true;
        socket.end(JSON.stringify({ ok: false, error: 'too_large' }) + '\n');
        return;
      }
      chunks.push(chunk);
      if (chunk.includes(0x0a)) handle();
    });
    socket.on('end', handle);
  }

  /** `undefined` = handler ulanishni o'zi boshqaradi (permission). */
  private dispatch(text: string, socket: Socket): Record<string, unknown> | undefined {
    let req: SocketRequest;
    try {
      req = SocketRequestSchema.parse(JSON.parse(text));
    } catch {
      return { ok: false, error: 'bad_request' };
    }
    try {
      switch (req.kind) {
        case 'hook':
          this.handlers.onHook(req.payload);
          return { ok: true };
        case 'statusline':
          this.handlers.onStatusline(req.payload);
          return { ok: true };
        case 'status':
          return { ok: true, status: this.handlers.status() };
        case 'rotate-key': {
          const handler = this.handlers.onRotateKey;
          if (!handler) return { ok: false, error: 'unsupported' };
          socket.setTimeout(30_000); // key.rotate.result kutish muddati 15 s; bu zaxira
          void handler.call(this.handlers).then(
            (r) => {
              if (!socket.destroyed) socket.end(JSON.stringify(r) + '\n');
            },
            (err: unknown) => {
              this.log.error('rotate-key handler xatosi', { error: errMsg(err) });
              if (!socket.destroyed) socket.end(JSON.stringify({ ok: false, error: 'internal' }) + '\n');
            },
          );
          return undefined;
        }
        case 'mailbox': {
          const handler = this.handlers.onMailbox;
          if (!handler) return { ok: false, error: 'unsupported' };
          socket.setTimeout(MAILBOX_SOCKET_TIMEOUT_MS); // handler o'z muddati bilan javob beradi; bu zaxira
          const attestor = this.attestor;
          // Peer pid'i handler so'raganda (lazy) olinadi; soket fd'si ulanish ochiq turguncha yaroqli (reply'dan keyin emas).
          const peer = attestor ? () => attestor.peerPids(socket) : undefined;
          handler.call(this.handlers, req.payload, {
            reply: (r) => {
              if (!socket.destroyed) socket.end(JSON.stringify(r) + '\n');
            },
            ...(peer ? { peer } : {}),
          });
          return undefined;
        }
        case 'permission': {
          socket.setTimeout(0); // qaror kutish davomida bo'sh turish normal
          const conn: HookConn = {
            reply: (r) => {
              if (!socket.destroyed) socket.end(JSON.stringify(r) + '\n');
            },
            onClose: (cb) => void socket.once('close', cb),
          };
          this.handlers.onPermission(req.payload, req.deadlineMs, conn);
          return undefined;
        }
      }
    } catch (err) {
      this.log.error('socket handler xatosi', { kind: req.kind, error: errMsg(err) });
      return { ok: false, error: 'internal' };
    }
  }
}
