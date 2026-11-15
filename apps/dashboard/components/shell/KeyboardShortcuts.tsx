"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { chordTarget, isTypingTarget } from "@/lib/shortcuts";

/** `/` qidiruvni fokuslaydi; `g s|p|o|t|m` sahifalarga o'tkazadi (yozish paytida ishlamaydi). */
export function KeyboardShortcuts() {
  const router = useRouter();
  useEffect(() => {
    let gAt = 0;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
      if (isTypingTarget(e.target)) return;
      if (document.querySelector("[role=dialog][aria-modal=true]")) return;
      const now = Date.now();
      if (e.key === "/") {
        const el = Array.from(document.querySelectorAll<HTMLInputElement>("input[data-search]")).find((x) => x.offsetParent !== null);
        if (el) {
          e.preventDefault();
          el.focus();
          el.select();
        }
        return;
      }
      if (gAt && now - gAt < 1200) {
        gAt = 0;
        const href = chordTarget(e.key);
        if (href) {
          e.preventDefault();
          router.push(href);
        }
        return;
      }
      gAt = e.key === "g" ? now : 0;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);
  return null;
}
