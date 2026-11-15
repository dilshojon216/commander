"use client";

import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Modal oyna: Esc yopadi, Tab oyna ichida aylanadi, ochilganda birinchi elementga fokus, yopilganda oldingisiga qaytadi.
 * Fon bosilsa yopiladi (`dismissOnBackdrop`).
 */
export function Dialog({
  labelledBy,
  onClose,
  children,
  maxWidth = 560,
  top = 60,
  dismissOnBackdrop = true,
}: {
  labelledBy: string;
  onClose: () => void;
  children: ReactNode;
  maxWidth?: number;
  top?: number;
  dismissOnBackdrop?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    return () => prev?.focus?.();
  }, []);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;
    const els = Array.from(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    if (els.length === 0) return;
    const first = els[0];
    const last = els[els.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-scrim p-4" style={{ paddingTop: top }} onMouseDown={(e) => dismissOnBackdrop && e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        onKeyDown={onKeyDown}
        className="flex w-full flex-col rounded-[14px] border border-bd bg-s1 shadow-[0_24px_60px_rgba(0,0,0,.4)]"
        style={{ maxWidth }}
      >
        {children}
      </div>
    </div>
  );
}
