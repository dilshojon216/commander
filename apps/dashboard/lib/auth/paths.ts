/** Autentifikatsiyasiz ochiq yo'llar (sof, testlanadi). Boshqa hamma narsa sessiya talab qiladi. */
export function isPublicPath(pathname: string): boolean {
  return pathname === "/login" || pathname === "/api/auth" || pathname.startsWith("/api/auth/");
}

/** `?next=` faqat shu origin ichidagi yo'l bo'lishi mumkin (open redirect yo'q). */
export function safeNextPath(raw: string | null | undefined): string {
  if (!raw || raw.length > 512) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\") || /[\u0000-\u001f]/.test(raw)) return "/";
  if (isPublicPath(raw.split("?")[0])) return "/";
  return raw;
}
