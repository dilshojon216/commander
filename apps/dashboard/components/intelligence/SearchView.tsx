"use client";

import { AskPanel } from "@/components/intelligence/AskPanel";
import { SearchPanel } from "@/components/intelligence/SearchPanel";
import { SummarySettingsPanel } from "@/components/intelligence/SummarySettingsPanel";
import { LivePill, PageHeader } from "@/components/ui/PageHeader";

/** "Qidiruv" sahifasi: xulosalar qidiruvi, Commander'dan savol va xulosa sozlamalari. */
export function SearchView() {
  return (
    <>
      <PageHeader title="Qidiruv">
        <LivePill />
      </PageHeader>
      <div className="flex w-full max-w-[1100px] flex-col gap-5 p-4 md:p-6">
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,420px),1fr))] items-start gap-5">
          <SearchPanel />
          <AskPanel />
        </div>
        <SummarySettingsPanel />
      </div>
    </>
  );
}
