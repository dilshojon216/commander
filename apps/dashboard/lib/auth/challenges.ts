import { randomToken, sha256Hex } from "./crypto";
import { loadChallenges, saveChallenges } from "./store";
import type { ChallengePurpose, ChallengeRecord } from "./store";

/** Bir martalik, qisqa muddatli (2 daqiqa) challenge'lar. Ishlatilgach darhol o'chadi (replay yo'q). */
export const CHALLENGE_TTL_MS = 2 * 60_000;
const MAX_CHALLENGES = 50;

export function putChallenge(rec: Omit<ChallengeRecord, "expiresAt">, now: number, ttl = CHALLENGE_TTL_MS): string {
  const all = loadChallenges();
  for (const [k, v] of Object.entries(all)) if (v.expiresAt <= now) delete all[k];
  const id = randomToken(24);
  all[sha256Hex(id)] = { ...rec, expiresAt: now + ttl };
  const keys = Object.keys(all);
  if (keys.length > MAX_CHALLENGES) for (const k of keys.sort((a, b) => all[a].expiresAt - all[b].expiresAt).slice(0, keys.length - MAX_CHALLENGES)) delete all[k];
  saveChallenges(all);
  return id;
}

/** Challenge'ni oladi VA o'chiradi (muvaffaqiyatsiz urinishdan keyin ham qayta ishlatib bo'lmaydi). */
export function takeChallenge(id: string | undefined, purpose: ChallengePurpose, now: number, sessionHash?: string): ChallengeRecord | null {
  if (!id || id.length > 128) return null;
  const all = loadChallenges();
  const key = sha256Hex(id);
  const rec = all[key];
  if (!rec) return null;
  delete all[key];
  saveChallenges(all);
  if (rec.expiresAt <= now || rec.purpose !== purpose) return null;
  if ((rec.sessionHash ?? "") !== (sessionHash ?? "")) return null;
  return rec;
}
