/**
 * Navigatsiya qo'riqchisi (sof mantiq). Next client-navigatsiyasi tugamay qolsa (server/ulanish navbati band, WebKit'da
 * transition osilib qolishi) havola bosilganda foydalanuvchi hech narsa ko'rmaydi: URL o'zgarmaydi, xato ham yo'q.
 * Chora: bosishdan `HARD_NAV_AFTER_MS` o'tib ham URL o'zgarmagan bo'lsa, oddiy (to'liq) navigatsiyaga o'tamiz.
 */
export const HARD_NAV_AFTER_MS = 6_000;

export interface ClickLike {
  defaultPrevented?: boolean;
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** Faqat oddiy chap bosish, shu origin'dagi, yangi oynasiz va yuklab olinmaydigan havola kuzatiladi. Qaytadi: maqsad `path+search` yoki null. */
export function trackedTarget(e: ClickLike, a: { href: string; target: string; hasDownload: boolean }, origin: string): string | null {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return null;
  if ((a.target && a.target !== "_self") || a.hasDownload) return null;
  let u: URL;
  try {
    u = new URL(a.href, origin);
  } catch {
    return null;
  }
  if (u.origin !== origin) return null;
  // Faqat hash o'zgarishi navigatsiya emas
  return `${u.pathname}${u.search}`;
}

/** Vaqt o'tdi: foydalanuvchi hali boshlang'ich sahifada va maqsad boshqa bo'lsa — to'liq navigatsiya kerak. */
export function needsHardNavigation(startPath: string, currentPath: string, targetPath: string): boolean {
  return currentPath === startPath && targetPath !== startPath;
}
