import { verify } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { buildCommandSigString } from '@commander/contracts';
import type { CenterKeyRotation, CommandSigParts } from '@commander/contracts';
import { ed25519PublicKeyFromRaw } from '../identity/common/crypto.util.js';
import { readRotations, rotationsFrom, validChain } from './center-key-rotation.js';
import { loadOrCreateSignerKeys, signCommand } from './command-signer.js';
import type { SignerKeys } from './command-signer.js';
import { COMMANDS_OPTIONS } from './commands.options.js';
import type { CommandsOptions } from './commands.options.js';
import { SignerClient, SignerRejectedError, SignerUnavailableError, parseSignerEndpoint } from './signer-client.js';
import type { SignerInfo } from './signer-client.js';

export interface SignerHealth {
  mode: 'signer' | 'file';
  /** `null` = hali o'lchanmagan. */
  reachable: boolean | null;
  locked: boolean;
  keyPresent: boolean;
  lastOkAt: number | null;
  lastError: string | null;
}

const REFRESH_MS = 30_000;

/**
 * Markazning buyruq imzolash kaliti (Ed25519). Ikki backend:
 *  - `signer` (production, 5.7/H-02): kalit host imzolovchida (macOS Keychain); markaz faqat imzo so'raydi, kalitni ko'rmaydi.
 *    `SIGNER_SOCKET` sozlangan bo'lsa kalit FAYLI hech qachon o'qilmaydi/yaratilmaydi va fallback YO'Q: imzolovchi yetib bo'lmasa
 *    `sign` xato beradi (buyruq yuborilmaydi, fail-closed).
 *  - `file` (dev/testlar): kalit faylda yoki xotirada.
 */
@Injectable()
export class CommandSignerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CommandSignerService.name);
  private keys: SignerKeys | null = null;
  private readonly client: SignerClient | null;
  private info: SignerInfo | null = null;
  private timer: NodeJS.Timeout | null = null;
  private state: Omit<SignerHealth, 'mode'> = { reachable: null, locked: false, keyPresent: true, lastOkAt: null, lastError: null };

  constructor(@Inject(COMMANDS_OPTIONS) private readonly options: CommandsOptions) {
    this.client = options.signer ? new SignerClient(parseSignerEndpoint(options.signer.endpoint), options.signer.authFile) : null;
    if (!this.client && options.signerRequired) {
      throw new Error('SIGNER_REQUIRED is set but SIGNER_SOCKET is not configured: refusing to fall back to a key file');
    }
  }

  get mode(): 'signer' | 'file' {
    return this.client ? 'signer' : 'file';
  }

  async onModuleInit(): Promise<void> {
    if (!this.client) {
      this.keys = loadOrCreateSignerKeys(this.options.keyFile);
      this.logger.log(`Command signing key ready (fingerprint ${this.keys.fingerprint}${this.options.keyFile ? '' : ', ephemeral'})`);
      return;
    }
    await this.refresh().catch((err: unknown) => this.logger.error(`Command signer is not reachable at startup (commands fail closed until it is): ${err instanceof Error ? err.message : String(err)}`));
    if (this.info) this.logger.log(`Command signer ready (fingerprint ${this.info.fingerprint}, host signer, key not in this container)`);
    this.timer = setInterval(() => void this.refresh().catch(() => undefined), REFRESH_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Imzolovchidan joriy public key + e'lonlarni yangilaydi (holatni ham). Xato bo'lsa eski kesh saqlanadi, lekin `reachable=false`. */
  private async refresh(): Promise<void> {
    if (!this.client) return;
    try {
      const info = await this.client.info();
      if (this.info && this.info.fingerprint !== info.fingerprint) this.logger.warn(`Command signer key changed: ${this.info.fingerprint} -> ${info.fingerprint}`);
      this.info = info;
      this.state = { reachable: true, locked: info.locked, keyPresent: true, lastOkAt: Date.now(), lastError: null };
    } catch (err) {
      this.markFailure(err);
      throw err;
    }
  }

  private markFailure(err: unknown): void {
    const code = err instanceof SignerRejectedError ? err.signerCode : 'unreachable';
    const keyMissing = err instanceof SignerRejectedError && (err.signerCode === 'key_missing' || err.signerCode === 'key_unavailable');
    this.state = {
      ...this.state,
      reachable: err instanceof SignerRejectedError ? true : false,
      keyPresent: !keyMissing,
      lastError: code,
    };
  }

  private current(): { publicKeyRaw: string; fingerprint: string } {
    if (this.keys) return { publicKeyRaw: this.keys.publicKeyRaw, fingerprint: this.keys.fingerprint };
    if (this.info) return { publicKeyRaw: this.info.publicKey, fingerprint: this.info.fingerprint };
    throw new SignerUnavailableError('no public key cached yet (signer has never answered)');
  }

  /** Xom 32 bayt public key (base64url): `auth.ok.centerPublicKey` va enrollment javobi. Signer yetib bo'lmasa (kesh yo'q) xato. */
  get publicKey(): string {
    return this.current().publicKeyRaw;
  }

  get fingerprint(): string {
    return this.current().fingerprint;
  }

  /** Kalit fayli (`null` = xotirada yoki SIGNER rejimi: fayl umuman ishlatilmaydi). */
  get keyFilePath(): string | null {
    return this.client ? null : this.options.keyFile;
  }

  /** `center-key rotate` boshqa jarayonda bajarilgach (NOTIFY) kalit va e'lonlarni qayta yuklaydi (5.1). */
  reload(): Promise<void> {
    if (this.client) return this.refresh();
    this.keys = loadOrCreateSignerKeys(this.options.keyFile);
    this.logger.log(`Command signing key reloaded (fingerprint ${this.keys.fingerprint})`);
    return Promise.resolve();
  }

  /**
   * agentning pin fingerprint'idan boshlab imzolangan aylantirish e'lonlari (ustma-ust tushish oynasida). Bo'sh = pin joriy kalit
   * yoki noma'lum (qo'lda `agentd center-key reset` kerak).
   */
  rotationsFor(pinnedFingerprint: string | undefined, now: number = Date.now()): CenterKeyRotation[] {
    if (!pinnedFingerprint) return [];
    if (this.client) {
      if (!this.info || pinnedFingerprint === this.info.fingerprint) return [];
      return rotationsFrom(validChain(this.info.rotations.filter((r) => r.expiresAt > now), this.info.publicKey), pinnedFingerprint);
    }
    if (!this.options.keyFile || !this.keys || pinnedFingerprint === this.keys.fingerprint) return [];
    return rotationsFrom(validChain(readRotations(this.options.keyFile, now), this.keys.publicKeyRaw), pinnedFingerprint);
  }

  /** Ustma-ust tushish oynasidagi e'lonlar (admin `center-key show`). */
  currentRotations(now: number = Date.now()): CenterKeyRotation[] {
    if (this.client) return this.info ? validChain(this.info.rotations.filter((r) => r.expiresAt > now), this.info.publicKey) : [];
    return this.options.keyFile && this.keys ? validChain(readRotations(this.options.keyFile, now), this.keys.publicKeyRaw) : [];
  }

  /** `command.dispatch` imzosi. Signer rejimida: imzolovchi so'raladi, javob kesh'dagi public key bilan TEKSHIRILADI. */
  async sign(parts: CommandSigParts): Promise<string> {
    if (!this.client) return signCommand(this.keys!.privateKey, parts);
    const request = { deviceId: parts.deviceId, commandId: parts.commandId, type: parts.type, nonce: parts.nonce, expiresAt: parts.expiresAt, payloadSha256: parts.payloadSha256 };
    let res;
    try {
      res = await this.client.signCommand(request);
    } catch (err) {
      this.markFailure(err);
      throw err;
    }
    if (!this.info || this.info.fingerprint !== res.fingerprint) await this.refresh().catch(() => undefined); // kalit aylantirilgan bo'lishi mumkin
    if (!this.info || this.info.fingerprint !== res.fingerprint || !this.verifies(parts, res.sig, this.info.publicKey)) {
      throw new SignerRejectedError('bad_signature', 'the returned signature does not verify against the signer public key');
    }
    this.state = { ...this.state, reachable: true, lastOkAt: Date.now(), lastError: null };
    return res.sig;
  }

  private verifies(parts: CommandSigParts, sig: string, publicKeyRaw: string): boolean {
    try {
      return verify(null, Buffer.from(buildCommandSigString(parts), 'utf8'), ed25519PublicKeyFromRaw(Buffer.from(publicKeyRaw, 'base64url')), Buffer.from(sig, 'base64url'));
    } catch {
      return false;
    }
  }

  /** `center-key rotate` (signer rejimi): yangi kalit IMZOLOVCHI ICHIDA yaratiladi; e'lon eski kalit bilan imzolanadi. */
  async rotate(overlapDays: number): Promise<{ previousFingerprint: string; newFingerprint: string; expiresAt: number }> {
    if (!this.client) throw new Error('rotate() is only available in signer mode; file mode rotates the key file (center-key-rotation.ts)');
    const r = await this.client.rotate(overlapDays);
    await this.refresh();
    return { previousFingerprint: r.previousFingerprint, newFingerprint: r.newFingerprint, expiresAt: r.rotation.expiresAt };
  }

  /** Salomatlik tekshiruvi uchun jonli o'lchash (center-health tick). Fayl rejimida o'lchanmaydi (`mode: 'file'`). */
  async probe(): Promise<SignerHealth> {
    if (!this.client) return { mode: 'file', reachable: null, locked: false, keyPresent: true, lastOkAt: null, lastError: null };
    try {
      const st = await this.client.status();
      if (!this.info) await this.refresh().catch(() => undefined);
      this.state = { reachable: true, locked: st.locked, keyPresent: st.keyPresent, lastOkAt: Date.now(), lastError: st.keyPresent ? null : 'key_missing' };
    } catch (err) {
      this.markFailure(err);
    }
    return this.health();
  }

  health(): SignerHealth {
    return { mode: this.mode, ...this.state };
  }
}
