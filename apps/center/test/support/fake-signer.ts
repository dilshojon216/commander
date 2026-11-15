import { createHash, createHmac, createPublicKey, generateKeyPairSync, randomBytes, sign, timingSafeEqual } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCenterKeyRotationString, buildCommandSigString } from '@commander/contracts';

/**
 * Sinov uchun soxta imzolovchi (apps/signer protokoli: HMAC handshake + info/status/sign_command/rotate). Haqiqiy Swift
 * imzolovchi bilan moslik `signer-binary.spec.ts` da (binary mavjud bo'lsa) tekshiriladi.
 */
export class FakeSigner {
  readonly dir = mkdtempSync(join(tmpdir(), 'cmdr-fakesigner-'));
  readonly authFile = join(this.dir, 'auth.secret');
  private secret = randomBytes(32);
  private key: KeyObject = generateKeyPairSync('ed25519').privateKey;
  private server: Server | null = null;
  private readonly conns = new Set<Socket>();
  port = 0;
  locked = false;
  /** `true`: noto'g'ri imzo qaytaradi (markaz tekshiruvi tutishi shart). */
  corruptSignatures = false;
  rotations: Array<Record<string, unknown>> = [];
  readonly signed: Array<Record<string, unknown>> = [];

  get publicKey(): string {
    return rawPublic(this.key);
  }

  get fingerprint(): string {
    return createHash('sha256').update(Buffer.from(this.publicKey, 'base64url')).digest('hex').slice(0, 16);
  }

  async start(port = 0): Promise<void> {
    writeFileSync(this.authFile, `${this.secret.toString('base64url')}\n`, { mode: 0o600 });
    this.server = createServer((sock) => {
      this.conns.add(sock);
      sock.on('close', () => this.conns.delete(sock));
      sock.setEncoding('utf8');
      const sNonce = randomBytes(32).toString('base64url');
      let stage: 'auth' | 'req' = 'auth';
      let buf = '';
      const mac = (role: string, cNonce: string): Buffer => createHmac('sha256', this.secret).update(`COMMANDER-SIGNER-V1:${role}\n${sNonce}\n${cNonce}`).digest();
      sock.write(`${JSON.stringify({ v: 1, t: 'challenge', nonce: sNonce })}\n`);
      let cNonce = '';
      sock.on('error', () => undefined);
      sock.on('data', (d: string) => {
        buf += d;
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          const msg = JSON.parse(line) as Record<string, unknown>;
          if (stage === 'auth') {
            cNonce = String(msg['nonce']);
            const got = Buffer.from(String(msg['mac']), 'base64url');
            const want = mac('client', cNonce);
            if (got.length !== want.length || !timingSafeEqual(got, want)) {
              sock.end(`${JSON.stringify({ v: 1, t: 'error', code: 'auth_failed' })}\n`);
              return;
            }
            stage = 'req';
            sock.write(`${JSON.stringify({ v: 1, t: 'ready', mac: mac('server', cNonce).toString('base64url') })}\n`);
          } else {
            sock.write(`${JSON.stringify(this.handle(msg))}\n`);
          }
        }
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(port, '127.0.0.1', resolve));
    this.port = (this.server.address() as { port: number }).port;
  }

  /** Imzolovchi "o'chdi": port yopiladi (markazda ulanish rad etiladi). */
  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (s) await new Promise<void>((resolve) => { s.close(() => resolve()); for (const c of this.conns) c.destroy(); });
  }

  async close(): Promise<void> {
    await this.stop();
    rmSync(this.dir, { recursive: true, force: true });
  }

  /** Imzolovchi qayta ishga tushdi: auth secret yangilanadi (markaz har so'rovda qayta o'qiydi). */
  rotateSecret(): void {
    this.secret = randomBytes(32);
    writeFileSync(this.authFile, `${this.secret.toString('base64url')}\n`, { mode: 0o600 });
  }

  private handle(m: Record<string, unknown>): Record<string, unknown> {
    const id = m['id'];
    const ok = (o: Record<string, unknown>): Record<string, unknown> => ({ ok: true, ...(id ? { id } : {}), ...o });
    const err = (code: string, message = ''): Record<string, unknown> => ({ ok: false, code, message, ...(id ? { id } : {}) });
    switch (m['op']) {
      case 'info':
        return ok({ publicKey: this.publicKey, fingerprint: this.fingerprint, rotations: this.rotations, locked: this.locked, bootId: 'fake' });
      case 'status':
        return ok({ locked: this.locked, keyPresent: true, bootId: 'fake' });
      case 'sign_command': {
        if (this.locked) return err('locked', 'lock file present');
        this.signed.push(m);
        const s = buildCommandSigString({ deviceId: String(m['deviceId']), commandId: String(m['commandId']), type: m['type'] as never, nonce: String(m['nonce']), expiresAt: Number(m['expiresAt']), payloadSha256: String(m['payloadSha256']) });
        const sig = sign(null, Buffer.from(this.corruptSignatures ? `${s}x` : s, 'utf8'), this.key).toString('base64url');
        return ok({ sig, fingerprint: this.fingerprint });
      }
      case 'rotate': {
        if (this.locked) return err('locked');
        const days = Number(m['overlapDays']);
        const prevPub = this.publicKey;
        const prevFp = this.fingerprint;
        const next = generateKeyPairSync('ed25519').privateKey;
        const newPub = rawPublic(next);
        const now = Date.now();
        const parts = { previousPublicKey: prevPub, newPublicKey: newPub, issuedAt: now, expiresAt: now + days * 86_400_000 };
        const rotation = { ...parts, signature: sign(null, Buffer.from(buildCenterKeyRotationString(parts), 'utf8'), this.key).toString('base64url') };
        this.rotations = [...this.rotations, rotation];
        this.key = next;
        return ok({ previousFingerprint: prevFp, newFingerprint: this.fingerprint, newPublicKey: newPub, rotation });
      }
      default:
        return err('bad_request', 'unknown op');
    }
  }
}

function rawPublic(priv: KeyObject): string {
  const x = createPublicKey(priv).export({ format: 'jwk' }).x;
  if (typeof x !== 'string') throw new Error('jwk export failed');
  return x;
}
