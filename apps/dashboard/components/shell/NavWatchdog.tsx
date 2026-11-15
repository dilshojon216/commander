"use client";

import { useEffect } from "react";
import { HARD_NAV_AFTER_MS, needsHardNavigation, trackedTarget } from "@/lib/nav-watchdog";

/**
 * Havola bosilgach URL `HARD_NAV_AFTER_MS` ichida o'zgarmasa, sahifani to'liq yuklaydi (jim "osilib qolish"dan qutqaradi).
 * Faqat oxirgi bosish kuzatiladi; foydalanuvchi boshqa joyga o'tsa taymer bekor bo'ladi.
 */
export function NavWatchdog() {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const here = () => `${window.location.pathname}${window.location.search}`;
    const onClick = (e: MouseEvent) => {
      const el = e.target instanceof Element ? e.target.closest("a[href]") : null;
      if (!(el instanceof HTMLAnchorElement)) return;
      const target = trackedTarget(e, { href: el.href, target: el.target, hasDownload: el.hasAttribute("download") }, window.location.origin);
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (target === null) return;
      const start = here();
      timer = setTimeout(() => {
        timer = undefined;
        if (needsHardNavigation(start, here(), target)) window.location.assign(target);
      }, HARD_NAV_AFTER_MS);
    };
    // Bubble bosqichida: Next Link o'z ishini tugatgach ham, tugatmagan bo'lsa ham ishlaydi
    document.addEventListener("click", onClick);
    return () => {
      document.removeEventListener("click", onClick);
      if (timer) clearTimeout(timer);
    };
  }, []);
  return null;
}
