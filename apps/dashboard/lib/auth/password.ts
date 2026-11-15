import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";

/**
 * Parol xeshi: scrypt (N=2^16, r=8, p=1, ~64 MB). Format: `scrypt$N$r$p$<salt b64>$<hash b64>`.
 * CLI (`scripts/auth-cli.mjs`) bir xil formatda yozadi; mosligi testda tekshiriladi.
 */
const N = 1 << 16;
const R = 8;
const P = 1;
const KEYLEN = 32;
const MAXMEM = 192 * 1024 * 1024;

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password.normalize("NFKC"), salt, KEYLEN, { N: n, r, p, maxmem: MAXMEM }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p) || n < 1 << 14 || n > 1 << 18 || r < 1 || r > 16 || p < 1 || p > 4) return false;
  const salt = Buffer.from(parts[4], "base64");
  const expected = Buffer.from(parts[5], "base64");
  if (expected.length !== KEYLEN || salt.length < 8) return false;
  try {
    const key = await derive(password, salt, n, r, p);
    return timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}
