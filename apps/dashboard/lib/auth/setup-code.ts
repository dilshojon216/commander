import { randomInt } from "node:crypto";
import { isWellFormedSetupCode, normalizeSetupCode, safeEqual, SETUP_ALPHABET, SETUP_CODE_LEN, sha256Hex } from "./crypto";
import { loadSetup, saveSetup } from "./store";
import type { SetupState } from "./store";

/** Kod noto'g'ri kiritilsa shuncha urinishdan keyin kod yaroqsiz bo'ladi (egasi yangisini chiqaradi). */
export const SETUP_MAX_ATTEMPTS = 5;

export function generateSetupCode(): string {
  let s = "";
  for (let i = 0; i < SETUP_CODE_LEN; i++) s += SETUP_ALPHABET[randomInt(SETUP_ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

export function makeSetupState(code: string, now: number, ttlMs: number): SetupState {
  return { codeHash: sha256Hex(normalizeSetupCode(code)), expiresAt: now + ttlMs, attempts: 0, createdAt: now };
}

export type SetupCheck = "ok" | "invalid" | "expired" | "none" | "locked";

/** Kodni tekshiradi (bir martalik uchun `consumeSetupCode` ni ishlating). Noto'g'ri urinish hisoblanadi. */
export function checkSetupCode(raw: string, now: number): SetupCheck {
  const st = loadSetup();
  if (!st) return "none";
  if (now >= st.expiresAt) {
    saveSetup(null);
    return "expired";
  }
  if (st.attempts >= SETUP_MAX_ATTEMPTS) {
    saveSetup(null);
    return "locked";
  }
  const ok = isWellFormedSetupCode(raw) && safeEqual(st.codeHash, sha256Hex(normalizeSetupCode(raw)));
  if (!ok) {
    st.attempts += 1;
    saveSetup(st.attempts >= SETUP_MAX_ATTEMPTS ? null : st);
    return "invalid";
  }
  return "ok";
}

/** Bir martalik: muvaffaqiyatli tekshiruvdan keyin o'chiriladi. */
export function consumeSetupCode(raw: string, now: number): SetupCheck {
  const r = checkSetupCode(raw, now);
  if (r === "ok") saveSetup(null);
  return r;
}

export function setupPending(now: number): boolean {
  const st = loadSetup();
  return !!st && now < st.expiresAt && st.attempts < SETUP_MAX_ATTEMPTS;
}
