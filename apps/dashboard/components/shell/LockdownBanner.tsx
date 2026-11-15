"use client";

import { useLiveData } from "@/components/LiveData";
import { IconLock } from "@/components/ui/icons";

/** Lockdown yoqiq bo'lsa sticky qizil banner (dizayn). O'chirish tugmasi: dashboard'dan mumkin emas. */
export function LockdownBanner() {
  const { lockdown, lockdownSince } = useLiveData();
  if (!lockdown) return null;
  return (
    <div role="alert" className="sticky top-0 z-20 flex items-center gap-2.5 bg-red px-4 py-2.5 font-semibold text-white md:px-6">
      <IconLock strokeWidth={1.8} />
      <span className="flex-1">
        Lockdown yoqiq: masofadan faqat rad etish mumkin
        {lockdownSince && <span className="ml-2 font-normal opacity-80">({lockdownSince.slice(0, 16).replace("T", " ")} UTC dan beri)</span>}
      </span>
      <button
        type="button"
        disabled
        title="Lockdown'ni dashboard'dan o'chirib bo'lmaydi: faqat admin buyrug'i orqali"
        className="btn h-7 border-white/40 bg-white/15 text-white"
      >
        O&apos;chirish
      </button>
    </div>
  );
}
