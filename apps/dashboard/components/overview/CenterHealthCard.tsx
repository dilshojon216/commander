"use client";

import type { CenterHealthResponse } from "@commander/contracts";
import { CHECK_LABEL, CHECK_STATUS_LABEL, CHECK_STATUS_PILL, formatUptime, sortChecks, summarize } from "@/lib/center-health-view";
import { formatDateTime } from "@/lib/format";
import { useCenterHealth } from "@/lib/use-center-health";

/** Taqdimot qismi (testlanadi): holat ma'lumoti kiradi, kartochka chiqadi. */
export function CenterHealthView({ health }: { health: CenterHealthResponse }) {
  const s = summarize(health);
  const open = health.incidents.filter((i) => i.resolvedAt === null);
  return (
    <section className="card overflow-hidden" aria-label="Markaz holati" data-testid="center-health" data-worst={s.worst}>
      <div className="flex flex-wrap items-center gap-2.5 px-4 py-3">
        <h2 className="m-0 text-sm font-semibold">Markaz holati</h2>
        <span className={`pill ${CHECK_STATUS_PILL[s.worst]}`}>{CHECK_STATUS_LABEL[s.worst]}</span>
        <span className="text-xs text-fa">
          ishlash vaqti {formatUptime(health.uptimeSec)}
          {s.machinesOffline > 0 ? ` · ${s.machinesOffline} mashina aloqada emas` : ""}
        </span>
      </div>
      <ul className="m-0 grid list-none gap-px border-t border-bd bg-bd p-0 sm:grid-cols-2 lg:grid-cols-3">
        {sortChecks(health.checks).map((c) => (
          <li key={c.kind} className="flex flex-col gap-1 bg-bg px-4 py-2.5" data-check={c.kind} data-status={c.status}>
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium">{CHECK_LABEL[c.kind]}</span>
              <span className={`pill ${CHECK_STATUS_PILL[c.status]}`}>{CHECK_STATUS_LABEL[c.status]}</span>
            </div>
            <span className="text-xs text-mu">{c.summary}</span>
          </li>
        ))}
      </ul>
      {open.length > 0 ? (
        <div className="border-t border-bd px-4 py-2.5 text-xs text-mu" data-testid="center-incidents">
          <span className="font-medium">Ochiq hodisalar:</span>{" "}
          {open.map((i) => `${CHECK_LABEL[i.kind]} (${formatDateTime(i.openedAt)})`).join(", ")}
        </div>
      ) : null}
    </section>
  );
}

/** Umumiy sahifadagi "Markaz holati" kartasi (5.5). Ma'lumot kelmaguncha (yoki xato bo'lsa) hech narsa ko'rsatilmaydi. */
export function CenterHealthCard() {
  const { health } = useCenterHealth();
  if (!health) return null;
  return <CenterHealthView health={health} />;
}
