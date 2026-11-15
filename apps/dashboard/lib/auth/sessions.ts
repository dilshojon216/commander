import { randomToken, sha256Hex, safeEqual } from "./crypto";
import { loadSessions, saveSessions } from "./store";
import type { AuthMethod, SessionRecord } from "./store";
import type { AuthSettings } from "./settings";

/** Faoliyat yozuvi har 30 soniyadan tez yozilmaydi (diskka yuk). */
const TOUCH_GRANULARITY_MS = 30_000;
const MAX_SESSIONS = 20;

export interface SessionView {
  /** Xesh (diskdagi kalit); xom identifikator HECH QACHON saqlanmaydi. */
  hash: string;
  csrf: string;
  method: AuthMethod;
  createdAt: number;
  elevatedUntil: number;
  expiresAt: number;
}

export type Lookup = { ok: true; session: SessionView } | { ok: false };

function isLive(rec: SessionRecord, now: number, s: AuthSettings): boolean {
  return now - rec.createdAt < s.absoluteMs && now - rec.lastSeen < s.idleMs;
}

function view(hash: string, rec: SessionRecord, s: AuthSettings): SessionView {
  return { hash, csrf: rec.csrf, method: rec.method, createdAt: rec.createdAt, elevatedUntil: rec.elevatedUntil, expiresAt: Math.min(rec.createdAt + s.absoluteMs, rec.lastSeen + s.idleMs) };
}

/** Yangi sessiya. Kirish o'zi yangi tasdiq (Touch ID/parol), shuning uchun darhol "ko'tarilgan" oyna beriladi. */
export function createSession(method: AuthMethod, now: number, s: AuthSettings): { sid: string; session: SessionView } {
  const sessions = loadSessions();
  for (const [h, rec] of Object.entries(sessions)) if (!isLive(rec, now, s)) delete sessions[h];
  const sid = randomToken(32);
  const hash = sha256Hex(sid);
  const rec: SessionRecord = { createdAt: now, lastSeen: now, elevatedUntil: now + s.elevationMs, csrf: randomToken(32), method };
  sessions[hash] = rec;
  const hashes = Object.keys(sessions);
  if (hashes.length > MAX_SESSIONS) {
    hashes.sort((a, b) => sessions[a].lastSeen - sessions[b].lastSeen);
    for (const h of hashes.slice(0, hashes.length - MAX_SESSIONS)) delete sessions[h];
  }
  saveSessions(sessions);
  return { sid, session: view(hash, rec, s) };
}

/** `touch` = haqiqiy foydalanuvchi faoliyati (idle taymerini yangilaydi). Fon so'rovlari (GET poll, SSE) touch QILMAYDI. */
export function lookupSession(sid: string | undefined | null, now: number, s: AuthSettings, opts: { touch: boolean }): Lookup {
  if (!sid || sid.length < 20 || sid.length > 128) return { ok: false };
  const hash = sha256Hex(sid);
  const sessions = loadSessions();
  const rec = sessions[hash];
  if (!rec) return { ok: false };
  if (!isLive(rec, now, s)) {
    delete sessions[hash];
    saveSessions(sessions);
    return { ok: false };
  }
  if (opts.touch && now - rec.lastSeen >= TOUCH_GRANULARITY_MS) {
    rec.lastSeen = now;
    saveSessions(sessions);
  }
  return { ok: true, session: view(hash, rec, s) };
}

export function elevateSession(hash: string, now: number, s: AuthSettings): number | null {
  const sessions = loadSessions();
  const rec = sessions[hash];
  if (!rec || !isLive(rec, now, s)) return null;
  rec.elevatedUntil = now + s.elevationMs;
  rec.lastSeen = now;
  saveSessions(sessions);
  return rec.elevatedUntil;
}

export function destroySession(sid: string | undefined | null): void {
  if (!sid) return;
  const sessions = loadSessions();
  const hash = sha256Hex(sid);
  if (sessions[hash]) {
    delete sessions[hash];
    saveSessions(sessions);
  }
}

export function destroyAllSessions(): void {
  saveSessions({});
}

export function isElevated(session: Pick<SessionView, "elevatedUntil">, now: number): boolean {
  return now < session.elevatedUntil;
}

export function csrfMatches(session: Pick<SessionView, "csrf">, header: string | null): boolean {
  return !!header && safeEqual(session.csrf, header);
}
