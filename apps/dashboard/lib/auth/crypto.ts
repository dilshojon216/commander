import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Sozlash kodi ko'rinishi: `ABCD-EFGH` (8 belgi, 32 harfli alifbo, 0/O/1/I yo'q). */
export const SETUP_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const SETUP_CODE_LEN = 8;

export function normalizeSetupCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}
export function isWellFormedSetupCode(raw: string): boolean {
  const n = normalizeSetupCode(raw);
  return n.length === SETUP_CODE_LEN && [...n].every((c) => SETUP_ALPHABET.includes(c));
}
