import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import type { Socket } from 'node:net';
import { ServiceUnavailableException } from '@nestjs/common';
import { z } from 'zod';

/**
 * Host imzolovchi (`apps/signer`, macOS Keychain) mijozi (5.7, H-02). Markaz kalitni HECH QACHON ko'rmaydi: faqat imzo so'raydi.
 * Protokol: yangi qator bilan ajratilgan JSON; har ulanishda HMAC handshake (secret = `auth.secret`, imzolovchi har ishga tushishida
 * yangilaydi, shu sabab har so'rovda qayta o'qiladi). Ulanish so'rov boshiga: imzolovchi qayta ishga tushsa ham ish beradi.
 */

/** Imzolovchiga yetib bo'lmadi / handshake o'tmadi / javob kelmadi: buyruqlar FAIL-CLOSED (yuborilmaydi). */
export class SignerUnavailableError extends ServiceUnavailableException {
  readonly signerCode = 'signer_unavailable';
  constructor(detail: string) {
    super({ error: 'signer_unavailable', message: `The command signer is unreachable: ${detail}` });
  }
}

/** Imzolovchi so'rovni rad etdi (siyosat, rate limit, LOCK, kalit yo'q ...). */
export class SignerRejectedError extends ServiceUnavailableException {
  constructor(readonly signerCode: string, detail: string) {
    super({ error: `signer_${signerCode}`, message: `The command signer refused the request (${signerCode}): ${detail}` });
  }
}

export type SignerEndpoint = { kind: 'tcp'; host: string; port: number } | { kind: 'unix'; path: string };

/** `tcp://host:port` yoki mutlaq soket yo'li. */
export function parseSignerEndpoint(spec: string): SignerEndpoint {
  const s = spec.trim();
  if (s.startsWith('/')) return { kind: 'unix', path: s };
  const m = /^tcp:\/\/([A-Za-z0-9.-]+):(\d{1,5})$/.exec(s);
  const port = m ? Number(m[2]) : 0;
  if (!m || port < 1 || port > 65535) throw new Error('SIGNER_SOCKET must be an absolute unix socket path or tcp://host:port');
  return { kind: 'tcp', host: m[1]!, port };
}

const RotationSchema = z.object({
  previousPublicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  newPublicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  issuedAt: z.number().int(),
  expiresAt: z.number().int(),
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
});

const Err = z.object({ ok: z.literal(false), code: z.string(), message: z.string().optional() });
const InfoOk = z.object({
  ok: z.literal(true),
  publicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  fingerprint: z.string().regex(/^[0-9a-f]{16}$/),
  rotations: z.array(RotationSchema),
  locked: z.boolean(),
  bootId: z.string(),
});
const StatusOk = z.object({ ok: z.literal(true), locked: z.boolean(), keyPresent: z.boolean(), bootId: z.string() });
const SignOk = z.object({ ok: z.literal(true), sig: z.string().regex(/^[A-Za-z0-9_-]{86}$/), fingerprint: z.string().regex(/^[0-9a-f]{16}$/) });
const RotateOk = z.object({
  ok: z.literal(true),
  previousFingerprint: z.string().regex(/^[0-9a-f]{16}$/),
  newFingerprint: z.string().regex(/^[0-9a-f]{16}$/),
  newPublicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  rotation: RotationSchema,
});

export type SignerInfo = z.infer<typeof InfoOk>;
export type SignerStatus = z.infer<typeof StatusOk>;
export type SignerSignResult = z.infer<typeof SignOk>;
export type SignerRotateResult = z.infer<typeof RotateOk>;

const MAX_LINE = 64 * 1024;

export class SignerClient {
  constructor(
    private readonly endpoint: SignerEndpoint,
    private readonly authFile: string,
    private readonly timeoutMs: number = 4_000,
  ) {}

  private secret(): Buffer {
    let raw: string;
    try {
      raw = readFileSync(this.authFile, 'utf8').trim();
    } catch {
      throw new SignerUnavailableError('auth secret is not readable (is the signer run dir mounted?)');
    }
    const key = Buffer.from(raw, 'base64url');
    if (key.length !== 32) throw new SignerUnavailableError('auth secret is malformed');
    return key;
  }

  private mac(secret: Buffer, role: 'client' | 'server', sNonce: string, cNonce: string): Buffer {
    return createHmac('sha256', secret).update(`COMMANDER-SIGNER-V1:${role}\n${sNonce}\n${cNonce}`, 'utf8').digest();
  }

  /** Bitta so'rov: ulanish, handshake, so'rov, javob, yopish. Har qanday transport xatosi `SignerUnavailableError`. */
  private exchange(request: Record<string, unknown>): Promise<unknown> {
    const secret = this.secret();
    return new Promise<unknown>((resolve, reject) => {
      const sock: Socket = this.endpoint.kind === 'tcp' ? connect({ host: this.endpoint.host, port: this.endpoint.port }) : connect({ path: this.endpoint.path });
      let buf = '';
      let stage: 'challenge' | 'ready' | 'response' = 'challenge';
      let sNonce = '';
      const cNonce = randomBytes(32).toString('base64url');
      let settled = false;
      const done = (err: Error | null, value?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sock.destroy();
        if (err) reject(err);
        else resolve(value);
      };
      const timer = setTimeout(() => done(new SignerUnavailableError('timed out')), this.timeoutMs);
      sock.setEncoding('utf8');
      sock.on('error', (e: NodeJS.ErrnoException) => done(new SignerUnavailableError(e.code ?? e.message)));
      sock.on('close', () => done(new SignerUnavailableError('connection closed')));
      sock.on('data', (chunk: string) => {
        buf += chunk;
        if (buf.length > MAX_LINE) return done(new SignerUnavailableError('response too large'));
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(line) as Record<string, unknown>;
          } catch {
            return done(new SignerUnavailableError('malformed response'));
          }
          if (stage === 'challenge') {
            if (msg['t'] !== 'challenge' || typeof msg['nonce'] !== 'string') return done(new SignerUnavailableError('unexpected greeting'));
            sNonce = msg['nonce'];
            stage = 'ready';
            sock.write(`${JSON.stringify({ v: 1, t: 'auth', nonce: cNonce, mac: this.mac(secret, 'client', sNonce, cNonce).toString('base64url') })}\n`);
          } else if (stage === 'ready') {
            if (msg['t'] === 'error') return done(new SignerUnavailableError('handshake refused (stale or wrong auth secret)'));
            const got = typeof msg['mac'] === 'string' ? Buffer.from(msg['mac'], 'base64url') : Buffer.alloc(0);
            const want = this.mac(secret, 'server', sNonce, cNonce);
            if (msg['t'] !== 'ready' || got.length !== want.length || !timingSafeEqual(got, want)) return done(new SignerUnavailableError('signer failed to prove the shared secret'));
            stage = 'response';
            sock.write(`${JSON.stringify(request)}\n`);
          } else {
            return done(null, msg);
          }
        }
      });
    });
  }

  private async call<T extends z.ZodType>(op: string, params: Record<string, unknown>, schema: T): Promise<z.infer<T>> {
    const raw = await this.exchange({ op, ...params });
    const err = Err.safeParse(raw);
    if (err.success) throw new SignerRejectedError(err.data.code, err.data.message ?? '');
    const ok = schema.safeParse(raw);
    if (!ok.success) throw new SignerUnavailableError('unexpected response shape');
    return ok.data;
  }

  info(): Promise<SignerInfo> {
    return this.call('info', {}, InfoOk);
  }

  status(): Promise<SignerStatus> {
    return this.call('status', {}, StatusOk);
  }

  signCommand(p: { deviceId: string; commandId: string; type: string; nonce: string; expiresAt: number; payloadSha256: string }): Promise<SignerSignResult> {
    return this.call('sign_command', p, SignOk);
  }

  rotate(overlapDays: number): Promise<SignerRotateResult> {
    return this.call('rotate', { overlapDays }, RotateOk);
  }
}
