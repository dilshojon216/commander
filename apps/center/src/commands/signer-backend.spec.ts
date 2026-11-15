import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandSigParts } from '@commander/contracts';
import { FakeSigner } from '../../test/support/fake-signer.js';
import { CommandSignerService } from './command-signer.service.js';
import { DEFAULT_COMMANDS_OPTIONS } from './commands.options.js';
import type { CommandsOptions } from './commands.options.js';
import { SignerClient, SignerRejectedError, SignerUnavailableError, parseSignerEndpoint } from './signer-client.js';

let fake: FakeSigner;
let scratch: string;
beforeEach(async () => {
  fake = new FakeSigner();
  await fake.start();
  scratch = mkdtempSync(join(tmpdir(), 'cmdr-sigbackend-'));
});
afterEach(async () => {
  await fake.close();
  rmSync(scratch, { recursive: true, force: true });
});

const parts = (over: Partial<CommandSigParts> = {}): CommandSigParts => ({
  deviceId: '123e4567-e89b-42d3-a456-426614174000',
  commandId: '223e4567-e89b-42d3-a456-426614174001',
  type: 'project.refresh',
  nonce: 'A'.repeat(43),
  expiresAt: Date.now() + 60_000,
  payloadSha256: 'b'.repeat(64),
  ...over,
});

const options = (over: Partial<CommandsOptions> = {}): CommandsOptions => ({
  ...DEFAULT_COMMANDS_OPTIONS,
  keyFile: join(scratch, 'must-never-be-created', 'command-signing.key'),
  signer: { endpoint: `tcp://127.0.0.1:${fake.port}`, authFile: fake.authFile },
  signerRequired: true,
  ...over,
});

async function service(over: Partial<CommandsOptions> = {}): Promise<CommandSignerService> {
  const s = new CommandSignerService(options(over));
  await s.onModuleInit();
  return s;
}

describe('parseSignerEndpoint', () => {
  it('accepts tcp://host:port and absolute socket paths, rejects the rest', () => {
    expect(parseSignerEndpoint('tcp://host.docker.internal:4320')).toEqual({ kind: 'tcp', host: 'host.docker.internal', port: 4320 });
    expect(parseSignerEndpoint('/run/commander-signer/signer.sock')).toEqual({ kind: 'unix', path: '/run/commander-signer/signer.sock' });
    for (const bad of ['', 'host:4320', 'tcp://host', 'tcp://host:0', 'tcp://host:99999', 'http://x:1', 'relative.sock']) expect(() => parseSignerEndpoint(bad)).toThrow();
  });
});

describe('CommandSignerService (signer backend)', () => {
  it('signs through the signer and verifies the signature; the key file is never read or created', async () => {
    const s = await service();
    expect(s.mode).toBe('signer');
    expect(s.publicKey).toBe(fake.publicKey);
    expect(s.fingerprint).toBe(fake.fingerprint);
    expect(s.keyFilePath).toBeNull();
    const p = parts();
    const sig = await s.sign(p);
    expect(sig).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(fake.signed).toHaveLength(1);
    expect(existsSync(join(scratch, 'must-never-be-created'))).toBe(false);
    s.onModuleDestroy();
  });

  it('refuses to start in signer-required mode without SIGNER_SOCKET (no key-file fallback)', () => {
    expect(() => new CommandSignerService(options({ signer: null }))).toThrow(/SIGNER_REQUIRED/);
  });

  it('fails closed when the signer is unreachable: sign() throws SignerUnavailableError, publicKey keeps the cached value', async () => {
    const s = await service();
    await fake.stop();
    await expect(s.sign(parts())).rejects.toBeInstanceOf(SignerUnavailableError);
    await expect(s.sign(parts())).rejects.toMatchObject({ signerCode: 'signer_unavailable' });
    expect(s.health()).toMatchObject({ mode: 'signer', reachable: false, lastError: 'unreachable' });
    expect(existsSync(join(scratch, 'must-never-be-created'))).toBe(false); // fallback yo'q
    expect(s.publicKey).toBe(fake.publicKey); // kesh: auth.ok uzilmaydi
    s.onModuleDestroy();
  });

  it('starts (fail closed) when the signer is down at boot: sign() fails, publicKey throws, recovers when the signer comes up', async () => {
    const port = fake.port;
    await fake.stop();
    const s = await service({ signer: { endpoint: `tcp://127.0.0.1:${port}`, authFile: fake.authFile } });
    expect(() => s.publicKey).toThrow(SignerUnavailableError);
    await expect(s.sign(parts())).rejects.toBeInstanceOf(SignerUnavailableError);
    await fake.start(port);
    const h = await s.probe();
    expect(h.reachable).toBe(true);
    expect(s.publicKey).toBe(fake.publicKey);
    await expect(s.sign(parts())).resolves.toMatch(/^[A-Za-z0-9_-]{86}$/);
    s.onModuleDestroy();
  });

  it('rejects a signature that does not verify against the signer public key (compromised/buggy signer)', async () => {
    const s = await service();
    fake.corruptSignatures = true;
    await expect(s.sign(parts())).rejects.toMatchObject({ signerCode: 'bad_signature' });
    s.onModuleDestroy();
  });

  it('LOCK: the signer refuses and the error is a SignerRejectedError (locked); health reports locked', async () => {
    const s = await service();
    fake.locked = true;
    await expect(s.sign(parts())).rejects.toBeInstanceOf(SignerRejectedError);
    await expect(s.sign(parts())).rejects.toMatchObject({ signerCode: 'locked' });
    expect((await s.probe()).locked).toBe(true);
    s.onModuleDestroy();
  });

  it('a stale/wrong auth secret never gets a signature (handshake refused)', async () => {
    const s = await service();
    const secretFile = fake.authFile;
    fake.rotateSecret(); // imzolovchi qayta ishga tushdi: markaz har so'rovda qayta o'qiydi -> ishlaydi
    await expect(s.sign(parts())).resolves.toBeTypeOf('string');
    const wrong = new SignerClient({ kind: 'tcp', host: '127.0.0.1', port: fake.port }, join(scratch, 'wrong.secret'));
    await expect(wrong.info()).rejects.toBeInstanceOf(SignerUnavailableError); // fayl yo'q
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(scratch, 'wrong.secret'), `${Buffer.alloc(32, 7).toString('base64url')}\n`);
    await expect(wrong.info()).rejects.toThrow(/handshake refused/);
    void secretFile;
    s.onModuleDestroy();
  });

  it('rotation through the signer: new key is generated inside the signer, old pin gets the announcement chain', async () => {
    const s = await service();
    const before = s.fingerprint;
    const r = await s.rotate(7);
    expect(r.previousFingerprint).toBe(before);
    expect(s.fingerprint).toBe(r.newFingerprint);
    expect(s.fingerprint).not.toBe(before);
    expect(s.rotationsFor(before)).toHaveLength(1);
    expect(s.rotationsFor(s.fingerprint)).toEqual([]);
    expect(s.rotationsFor(undefined)).toEqual([]);
    expect(s.currentRotations()).toHaveLength(1);
    // yangi kalit bilan imzolanadi va tekshiriladi
    await expect(s.sign(parts())).resolves.toBeTypeOf('string');
    // oyna tugagach e'lon qilinmaydi
    expect(s.rotationsFor(before, Date.now() + 8 * 86_400_000)).toEqual([]);
    s.onModuleDestroy();
  });

  it('a key change inside the signer (rotation by another process) is picked up on the next signature', async () => {
    const s = await service();
    const before = s.fingerprint;
    await new SignerClient({ kind: 'tcp', host: '127.0.0.1', port: fake.port }, fake.authFile).rotate(3); // CLI jarayoni
    expect(s.fingerprint).toBe(before);
    await s.sign(parts());
    expect(s.fingerprint).not.toBe(before);
    s.onModuleDestroy();
  });
});

describe('file backend (dev/tests) is unchanged', () => {
  it('signs synchronously from an in-memory key and rotate() is refused', async () => {
    const s = new CommandSignerService({ ...DEFAULT_COMMANDS_OPTIONS, keyFile: null, signer: null, signerRequired: false });
    await s.onModuleInit();
    expect(s.mode).toBe('file');
    await expect(s.sign(parts())).resolves.toMatch(/^[A-Za-z0-9_-]{86}$/);
    await expect(s.rotate(7)).rejects.toThrow(/signer mode/);
    expect((await s.probe()).mode).toBe('file');
  });
});
