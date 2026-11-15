import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createPrivateKey, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCenterKeyRotationString, buildCommandSigString } from '@commander/contracts';
import { ed25519PublicKeyFromRaw } from '../identity/common/crypto.util.js';
import { CommandSignerService } from './command-signer.service.js';
import { DEFAULT_COMMANDS_OPTIONS } from './commands.options.js';
import { SignerRejectedError } from './signer-client.js';

/**
 * TS mijoz <-> HAQIQIY Swift imzolovchi (protokol mosligi). Binary quriladigan bo'lmasa o'tkazib yuboriladi:
 *   (cd apps/signer && swift build)   -> .build/debug/commander-signer
 * Kalit Keychain o'rniga fayl (COMMANDER_SIGNER_TEST_KEYSTORE): faqat testlar uchun, production binary'si ham shuni qo'llab-quvvatlaydi
 * lekin muhit o'zgaruvchisisiz Keychain'dan boshqasini ishlatmaydi.
 */
const bin = join(dirname(fileURLToPath(import.meta.url)), '../../../signer/.build/debug/commander-signer');
const available = existsSync(bin);

describe.skipIf(!available)('real commander-signer binary', () => {
  let dir: string;
  let proc: ChildProcess;
  let port: number;
  let svc: CommandSignerService;
  const env = (): NodeJS.ProcessEnv => ({ ...process.env, COMMANDER_SIGNER_TEST_KEYSTORE: join(dir, 'test-key.bin') });
  const run = (args: string[], input?: string): Promise<{ code: number; out: string }> =>
    new Promise((resolve) => {
      const p = spawn(bin, args, { env: env() });
      let out = '';
      p.stdout.on('data', (d: Buffer) => (out += d.toString()));
      p.stderr.on('data', (d: Buffer) => (out += d.toString()));
      p.on('close', (code) => resolve({ code: code ?? -1, out }));
      // Rad etadigan buyruqlar (export/delete) stdin'ni o'qimay darhol chiqadi: yuklamada yozuv jarayon
      // chiqqandan keyin yetib boradi va EPIPE beradi. Bu kutilgan holat — natija chiqish kodi bilan tekshiriladi (6.19).
      p.stdin.on('error', () => undefined);
      if (input !== undefined) p.stdin.end(input);
    });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cmdr-signer-bin-'));
    const pair = generateKeyPairSync('ed25519');
    const pem = pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const x = createPublicKey(pair.privateKey).export({ format: 'jwk' }).x as string;
    const { createHash } = await import('node:crypto');
    const fp = createHash('sha256').update(Buffer.from(x, 'base64url')).digest('hex').slice(0, 16);
    const bad = await run(['import', '--pem-stdin', '--expect-fingerprint', '0000000000000000', '--state-dir', dir], pem);
    expect(bad.code).not.toBe(0); // fingerprint mos emas: hech narsa saqlanmaydi
    expect(bad.out).not.toContain('PRIVATE');
    const imp = await run(['import', '--pem-stdin', '--expect-fingerprint', fp, '--state-dir', dir], pem);
    expect(imp.code).toBe(0);
    expect(imp.out).toContain(fp);
    port = 20_000 + Math.floor(Math.random() * 20_000);
    proc = spawn(bin, ['serve', '--state-dir', dir, '--tcp-port', String(port)], { env: env() });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('signer did not start')), 8000);
      proc.stderr!.on('data', (d: Buffer) => { if (d.toString().includes('ready')) { clearTimeout(t); resolve(); } });
    });
    svc = new CommandSignerService({ ...DEFAULT_COMMANDS_OPTIONS, keyFile: null, signer: { endpoint: `tcp://127.0.0.1:${port}`, authFile: join(dir, 'run', 'auth.secret') }, signerRequired: true });
    await svc.onModuleInit();
    expect(svc.fingerprint).toBe(fp);
  });
  afterAll(async () => {
    svc?.onModuleDestroy();
    if (proc) await new Promise<void>((resolve) => { proc.once('close', () => resolve()); proc.kill('SIGTERM'); });
    execFileSync('chflags', ['-R', 'nouappend', dir]); // audit log UF_APPEND bayrog'i (append-only) o'chirishni to'sadi
    rmSync(dir, { recursive: true, force: true });
  });

  const parts = (type: string = 'project.refresh') => ({
    deviceId: '123e4567-e89b-42d3-a456-426614174000',
    commandId: '223e4567-e89b-42d3-a456-426614174001',
    type: type as 'project.refresh',
    nonce: 'A'.repeat(43),
    expiresAt: Date.now() + 60_000,
    payloadSha256: 'b'.repeat(64),
  });

  it('signs a well-formed command; Node verifies the Swift signature; the audit log chain is valid and has no secrets', async () => {
    const p = parts();
    const sig = await svc.sign(p);
    expect(verify(null, Buffer.from(buildCommandSigString(p), 'utf8'), ed25519PublicKeyFromRaw(Buffer.from(svc.publicKey, 'base64url')), Buffer.from(sig, 'base64url'))).toBe(true);
    const log = readFileSync(join(dir, 'log', 'signatures.log'), 'utf8');
    expect(log).toContain(p.commandId);
    expect(log).toContain('project.refresh');
    expect(log).not.toContain(sig);
    expect((await run(['verify-log', '--state-dir', dir])).code).toBe(0);
  });

  it('refuses unknown command types and malformed fields (policy), and logs the denial', async () => {
    await expect(svc.sign(parts('shell.exec'))).rejects.toMatchObject({ signerCode: 'policy_violation' });
    await expect(svc.sign({ ...parts(), nonce: 'short' })).rejects.toBeInstanceOf(SignerRejectedError);
    await expect(svc.sign({ ...parts(), expiresAt: Date.now() + 10 * 60_000 })).rejects.toMatchObject({ signerCode: 'policy_violation' });
    expect(readFileSync(join(dir, 'log', 'signatures.log'), 'utf8')).toContain('denied:policy_violation');
  });

  it('lock file is the kill switch: signing refused while present, works again after unlock', async () => {
    expect((await run(['lock', '--state-dir', dir])).code).toBe(0);
    await expect(svc.sign(parts())).rejects.toMatchObject({ signerCode: 'locked' });
    expect((await svc.probe()).locked).toBe(true);
    expect((await run(['unlock', '--state-dir', dir])).code).toBe(0);
    await expect(svc.sign(parts())).resolves.toBeTypeOf('string');
  });

  it('rotation inside the signer: announcement signed by the old key verifies in Node, new key signs', async () => {
    const before = { pub: svc.publicKey, fp: svc.fingerprint };
    const r = await svc.rotate(7);
    expect(r.previousFingerprint).toBe(before.fp);
    const chain = svc.currentRotations();
    expect(chain).toHaveLength(1);
    const rot = chain[0]!;
    expect(rot.previousPublicKey).toBe(before.pub);
    expect(verify(null, Buffer.from(buildCenterKeyRotationString(rot), 'utf8'), ed25519PublicKeyFromRaw(Buffer.from(rot.previousPublicKey, 'base64url')), Buffer.from(rot.signature, 'base64url'))).toBe(true);
    const p = parts();
    const sig = await svc.sign(p);
    expect(verify(null, Buffer.from(buildCommandSigString(p), 'utf8'), ed25519PublicKeyFromRaw(Buffer.from(rot.newPublicKey, 'base64url')), Buffer.from(sig, 'base64url'))).toBe(true);
    expect(svc.rotationsFor(before.fp)).toHaveLength(1);
    expect((await run(['verify-log', '--state-dir', dir])).code).toBe(0);
  });

  it('a wrong auth secret is refused by the real server', async () => {
    const wrong = join(dir, 'wrong.secret');
    writeFileSync(wrong, `${Buffer.alloc(32, 9).toString('base64url')}\n`);
    const s = new CommandSignerService({ ...DEFAULT_COMMANDS_OPTIONS, keyFile: null, signer: { endpoint: `tcp://127.0.0.1:${port}`, authFile: wrong }, signerRequired: true });
    await s.onModuleInit();
    await expect(s.sign(parts())).rejects.toMatchObject({ signerCode: 'signer_unavailable' });
    s.onModuleDestroy();
    void createPrivateKey;
  });

  it('export/restore/delete refuse to run non-interactively (owner confirmation needs a terminal)', async () => {
    const out = join(dir, 'b.json');
    expect((await run(['export-backup', '--out', out, '--state-dir', dir], '')).code).not.toBe(0);
    expect(existsSync(out)).toBe(false);
    expect((await run(['delete-key', '--confirm-fingerprint', svc.fingerprint, '--state-dir', dir], '')).code).not.toBe(0);
    expect((await svc.sign(parts()).then(() => true))).toBe(true); // hali ishlaydi
  });
});
