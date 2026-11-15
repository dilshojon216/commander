import { SESSION_COOKIE } from "./settings";

/**
 * Sessiya cookie'si: HttpOnly, SameSite=Strict, Path=/, Domain yo'q (faqat shu host). `Secure` va `__Host-` prefiksi
 * ATAYLAB yo'q: dashboard `http://localhost` / `http://127.0.0.1` da ishlaydi, Safari/WKWebView `Secure` cookie'ni http'da
 * qabul qilmaydi. Host-only + Path=/ + Domain'siz bu `__Host-` talablarining Secure'dan boshqa hammasini bajaradi.
 */
export function sessionSetCookie(sid: string, maxAgeSec: number): string {
  return `${SESSION_COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

export function readSessionCookie(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === SESSION_COOKIE) return part.slice(i + 1).trim() || null;
  }
  return null;
}
