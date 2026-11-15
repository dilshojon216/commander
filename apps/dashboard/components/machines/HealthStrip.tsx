"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useLiveData } from "@/components/LiveData";
import { useHealthSummary } from "@/lib/use-health";
import { STATUS_LABEL, STATUS_PILL, stripAttentionDetails, stripSummary, visibleHealthItems } from "@/lib/health-view";

/** Umumiy sahifadagi ixcham "Server holati" chizig'i: eng yomon holat + e'tibor talab qiladigan mashinalar (sabab bilan). */
export function HealthStrip() {
  const { summary, live } = useHealthSummary();
  const { machines } = useLiveData();
  // Faqat ko'rinadigan mashinalar: yashirin/legacy va markazda yo'q (retired/merged) yozuvlar sanoqqa kirmaydi
  const visible = useMemo(() => (machines.length > 0 ? new Set(machines.map((m) => m.id)) : null), [machines]);
  const items = useMemo(() => visibleHealthItems(summary?.items ?? [], visible).map((i) => ({ ...i, status: live[i.machineId]?.status ?? i.status })), [summary, visible, live]);
  if (!summary || items.length === 0) return null;
  const s = stripSummary(items);
  const details = stripAttentionDetails(items);
  const full = details.map((d) => `${d.name}: ${d.reason}`).join("\n");
  return (
    <Link href="/machines" className="card flex flex-wrap items-center gap-2.5 px-4 py-2.5 text-xs hover:opacity-90" data-testid="health-strip" data-worst={s.worst} title={full || undefined}>
      <span className="font-medium text-mu">Server holati</span>
      <span className={`pill ${STATUS_PILL[s.worst]}`}>{STATUS_LABEL[s.worst]}</span>
      <span className="text-fa" data-testid="health-strip-text">
        {details.length === 0 ? `${s.total} mashina` : `${details.length} / ${s.total} e'tibor talab qiladi: ${details.slice(0, 3).map((d) => `${d.name}: ${d.reason}`).join(" · ")}${details.length > 3 ? ` · +${details.length - 3}` : ""}`}
      </span>
    </Link>
  );
}
