/** Chat marshrutlari uchun sof tekshiruvlar (testlanadi). */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID.test(v);
}

/** Eski sahifa kursori: 1..64 belgi, ko'rinadigan ASCII (boshqarish belgilari va bo'shliqsiz). */
export function isValidCursor(v: unknown): v is string {
  return typeof v === "string" && v.length >= 1 && v.length <= 64 && /^[\x21-\x7e]+$/.test(v);
}

export type ChatRouteCheck = { ok: true; sessionId: string; cid: string } | { ok: false; status: 400; error: string };

/** `sessionId` (yo'l) va `cid` (so'rov parametri) uuid bo'lishi shart. */
export function checkChatParams(sessionId: string, cid: string | null): ChatRouteCheck {
  if (!isUuid(sessionId)) return { ok: false, status: 400, error: "invalid_session_id" };
  if (!isUuid(cid)) return { ok: false, status: 400, error: "invalid_cid" };
  return { ok: true, sessionId, cid };
}
