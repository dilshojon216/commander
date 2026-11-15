import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COMMAND_LIMITS, COMMAND_TYPES, buildCenterKeyRotationString, buildCommandSigString } from '@commander/contracts';

/**
 * Swift imzolovchi (apps/signer) siyosati libs/contracts bilan sinxron bo'lishi shart: aks holda yangi buyruq turi qo'shilganda
 * imzolovchi uni rad etadi (fail-closed, lekin jim buzilish). Golden vector: Swift testidagi satr va imzo shu yerda ham tekshiriladi.
 */
const swift = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../signer/Sources/SignerCore/Policy.swift'), 'utf8');

describe('apps/signer policy drift guard', () => {
  it('Swift commandTypes equals contracts COMMAND_TYPES (same set)', () => {
    const block = /commandTypes: \[String\] = \[([\s\S]*?)\]/.exec(swift)?.[1] ?? '';
    const swiftTypes = [...block.matchAll(/"([a-z_.]+)"/g)].map((m) => m[1]!);
    expect([...swiftTypes].sort()).toEqual([...COMMAND_TYPES].sort());
  });

  it('Swift signature version and max TTL cover the center dispatch TTL', () => {
    expect(swift).toContain('static let version = "COMMANDER-CMD-V1"');
    const ttl = Number(/maxTtlMs: Int64 = ([0-9_]+)/.exec(swift)?.[1]?.replace(/_/g, ''));
    expect(ttl).toBeGreaterThanOrEqual(COMMAND_LIMITS.dispatchTtlMs);
  });

  it('canonical strings: contracts builders match the Swift join order (golden vector shared with PolicyTests.swift)', () => {
    const parts = {
      deviceId: '123E4567-E89B-42D3-A456-426614174000',
      commandId: '223e4567-e89b-42d3-a456-426614174001',
      type: 'project.refresh' as const,
      nonce: 'A'.repeat(43),
      expiresAt: 1_900_000_000_000,
      payloadSha256: 'B'.repeat(64),
    };
    expect(buildCommandSigString(parts)).toBe(
      ['COMMANDER-CMD-V1', '123e4567-e89b-42d3-a456-426614174000', parts.commandId, 'project.refresh', 'A'.repeat(43), '1900000000000', 'b'.repeat(64)].join('\n'),
    );
    expect(buildCenterKeyRotationString({ previousPublicKey: 'p', newPublicKey: 'n', issuedAt: 1, expiresAt: 2 })).toBe('COMMANDER-CENTER-KEY-ROTATION-V1\np\nn\n1\n2');
    expect(swift).toContain('"COMMANDER-CENTER-KEY-ROTATION-V1"');
  });

  it('Swift golden signature (made by Node, verified in Swift tests) verifies in Node under the same key', () => {
    const seed = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
    const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
    const msg = buildCommandSigString({ deviceId: '123e4567-e89b-42d3-a456-426614174000', commandId: '223e4567-e89b-42d3-a456-426614174001', type: 'project.refresh', nonce: 'A'.repeat(43), expiresAt: 1_900_000_000_000, payloadSha256: 'b'.repeat(64) });
    const golden = 'kdHAsgpxDaZLVOSlC4sQ8GyAi4Qu3FMXVF-l7CzBMTeT3KjQmAfo76rdKkSyuWTu4oRCl9B6jtkPSew2Mi1kDQ';
    expect(verify(null, Buffer.from(msg), createPublicKey(key), Buffer.from(golden, 'base64url'))).toBe(true);
    expect(sign(null, Buffer.from(msg), key).toString('base64url')).toBe(golden); // Node deterministik
    const testsSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../signer/Tests/SignerCoreTests/Fixtures.swift'), 'utf8');
    expect(testsSrc).toContain(golden);
  });
});
