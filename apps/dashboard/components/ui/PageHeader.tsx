"use client";

import type { ReactNode } from "react";
import { useLiveData } from "@/components/LiveData";
import { IconLock, IconSearch, IconSpinner } from "./icons";

/** "Jonli" ko'rsatkichi: SSE + center ko'prigi. Uzilsa "Qayta ulanmoqda…". */
export function LivePill() {
  const { live, error } = useLiveData();
  if (live) {
    return (
      <span className="pill bg-grn-bg text-grn" role="status" data-testid="live-pill">
        <span className="dot live" />
        Jonli
      </span>
    );
  }
  return (
    <span className="pill bg-yel-bg text-yel" role="status" title={error ?? undefined} data-testid="live-pill">
      <IconSpinner />
      Qayta ulanmoqda…
    </span>
  );
}

export function LockdownPill() {
  const { lockdown } = useLiveData();
  return lockdown ? (
    <span className="pill bg-red text-white">
      <IconLock size={12} strokeWidth={1.8} />
      Lockdown yoqiq
    </span>
  ) : (
    <span className="pill bg-gray-bg text-mu">
      <IconLock size={12} strokeWidth={1.8} />
      Lockdown o&apos;chiq
    </span>
  );
}

export function SearchBox({
  value,
  onChange,
  placeholder,
  label,
  width = 220,
  showHint = true,
  height = 32,
  onSubmit,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  label: string;
  width?: number;
  showHint?: boolean;
  height?: 30 | 32;
  onSubmit?: () => void;
}) {
  return (
    <label className="flex items-center gap-2 rounded-[7px] border border-bd bg-s1 px-2.5 text-mu" style={{ height, width, minWidth: 0, maxWidth: "100%" }}>
      <IconSearch size={14} />
      <input
        type="search"
        data-search
        aria-label={label}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSubmit?.();
          if (e.key === "Escape") e.currentTarget.blur();
        }}
        className="min-w-0 flex-1 border-0 bg-transparent text-tx outline-none"
        style={{ font: "inherit" }}
      />
      {showHint && <span className="kbd">/</span>}
    </label>
  );
}

/** Sahifa sarlavhasi (dizayn: 14px 24px, pastki chegara). */
export function PageHeader({ title, count, children, back }: { title: ReactNode; count?: ReactNode; children?: ReactNode; back?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-center gap-3 border-b border-bd px-4 py-3.5 md:px-6">
      {back}
      <h1 className="m-0 flex-[1_1_auto] text-lg font-semibold">
        {title}
        {count !== undefined && <span className="ml-2 text-sm font-normal text-mu">{count}</span>}
      </h1>
      {children}
    </header>
  );
}
