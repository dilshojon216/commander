/**
 * H-01: lokal autentifikatsiya sozlamalari (sof, testlanadi). Qiymatlar env orqali o'zgaradi, lekin pastki/yuqori chegaralar bor:
 * kimdir env'ni "99999" qilib himoyani ochib qo'ymasin.
 */

export const SESSION_COOKIE = "commander_session";
export const CSRF_HEADER = "x-csrf-token";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

export interface AuthSettings {
  /** Sessiyaning mutlaq umri (sukut 12 soat). */
  absoluteMs: number;
  /** Faoliyatsiz qolish chegarasi (sukut 2 soat). */
  idleMs: number;
  /** Yangi tasdiqdan keyin xavfli amallar uchun "ko'tarilgan" oyna (sukut 5 daqiqa). */
  elevationMs: number;
  /** Bir martalik sozlash kodi umri (10 daqiqa). */
  setupCodeMs: number;
  /** WebAuthn RP ID: faqat `localhost` (IP manzil RP ID bo'la olmaydi). */
  rpId: string;
  /** Ruxsat etilgan WebAuthn origin'lari. */
  origins: string[];
}

function clampNum(raw: string | undefined, def: number, min: number, max: number): number {
  const n = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

export function getAuthSettings(env: Record<string, string | undefined> = process.env): AuthSettings {
  const port = env.DASHBOARD_PORT?.trim() || "4318";
  const rpId = env.DASHBOARD_WEBAUTHN_RP_ID?.trim() || "localhost";
  const origins = (env.DASHBOARD_WEBAUTHN_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    absoluteMs: clampNum(env.DASHBOARD_SESSION_HOURS, 12, 1, 24) * HOUR,
    idleMs: clampNum(env.DASHBOARD_IDLE_MINUTES, 120, 5, 24 * 60) * MINUTE,
    elevationMs: clampNum(env.DASHBOARD_ELEVATION_MINUTES, 5, 1, 30) * MINUTE,
    setupCodeMs: 10 * MINUTE,
    rpId,
    origins: origins.length > 0 ? origins : [`http://${rpId}:${port}`],
  };
}
