"use client";

import type { InvestigationDto, InvestigationSubjectKind } from "@commander/contracts";
import Link from "next/link";
import { useState } from "react";
import { ApiCallError } from "@/lib/client-api";
import { INVESTIGATION_STATE_LABEL, INVESTIGATION_STATE_TONE, SETTINGS_ANCHOR, investigationNote, investigationSessionHref, investigationsFor, isActiveInvestigation, startErrorView } from "@/lib/investigation-view";
import type { StartErrorView } from "@/lib/investigation-view";
import { startInvestigation } from "@/lib/use-investigations";

export interface InvestigationBadgesProps {
  items: InvestigationDto[];
  /** Eng ko'pi nechta oxirgi tekshiruv ko'rsatiladi. */
  max?: number;
}

/** Tekshiruv holati nishonlari: holat, sessiya havolasi va (xato bo'lsa) yo'riqnoma. Faqat ko'rinish (testlanadi). */
export function InvestigationBadges({ items, max = 3 }: InvestigationBadgesProps) {
  if (items.length === 0) return null;
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0" data-testid="investigation-list">
      {items.slice(0, max).map((i) => {
        const href = investigationSessionHref(i);
        const note = investigationNote(i);
        return (
          <li key={i.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs" data-testid="investigation" data-state={i.state}>
            <span className={`pill ${INVESTIGATION_STATE_TONE[i.state]}`}>{INVESTIGATION_STATE_LABEL[i.state]}</span>
            {href ? (
              <Link href={href} className="font-medium text-blue" data-testid="investigation-link">
                Sessiyani ochish →
              </Link>
            ) : null}
            <span className="mono text-fa" suppressHydrationWarning>
              {new Date(i.createdAt).toLocaleString("uz-UZ", { dateStyle: "short", timeStyle: "short" })}
            </span>
            {note ? <span className="basis-full text-red">{note}</span> : null}
          </li>
        );
      })}
    </ul>
  );
}

export interface InvestigateControlProps {
  kind: InvestigationSubjectKind;
  /** `health_incidents.id` yoki `watchdog_alerts.id`. */
  subjectId: string;
  /** Mashina/umumiy ro'yxatdagi barcha tekshiruvlar (shu hodisaga tegishlisi ajratiladi). */
  items: InvestigationDto[];
  /** Tugma ko'rinadimi (`canInvestigateIncident/Alert`). */
  eligible: boolean;
  /** Boshlash taqiqlangan bo'lsa sabab (token yo'q, lockdown). */
  blocked: string | null;
  /** Mavjud tekshiruvlarni qayta o'qish. */
  onChanged: () => void;
  /** Ops papka sozlamalari formasi sahifasi (mashina sahifasi `#investigation-settings`). */
  settingsHref: string;
}

/** "🔍 Claude tekshirsin": mavjud elevation oqimi (apiFetch qayta tasdiq so'raydi), holat nishonlari va xato tushuntirishlari. */
export function InvestigateControl({ kind, subjectId, items, eligible, blocked, onChanged, settingsHref }: InvestigateControlProps) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<StartErrorView | null>(null);
  const mine = investigationsFor(items, kind, subjectId);
  const active = mine.some(isActiveInvestigation);
  if (!eligible && mine.length === 0) return null;

  async function start() {
    setBusy(true);
    setErr(null);
    try {
      await startInvestigation(kind, subjectId);
    } catch (e) {
      setErr(e instanceof ApiCallError ? startErrorView(e.status, e.body) : startErrorView(0, null));
    } finally {
      setBusy(false);
      onChanged();
    }
  }

  return (
    <div className="flex w-full flex-col gap-1.5" data-testid="investigate-control">
      {eligible ? (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn" disabled={busy || active || blocked !== null} title={blocked ?? (active ? "Tekshiruv davom etmoqda" : "Shu mashinada plan rejimida (faqat o'qish) sessiya ochadi")} onClick={() => void start()} data-testid="investigate-button">
            {busy ? "Yuborilmoqda…" : "🔍 Claude tekshirsin"}
          </button>
          {blocked ? <span className="text-xs text-mu">{blocked}</span> : null}
        </div>
      ) : null}
      {err ? (
        <div role="alert" className="rounded-lg bg-org-bg px-3 py-2 text-xs text-org" data-testid="investigate-error">
          {err.text}{" "}
          {err.needsSettings ? (
            <Link href={settingsHref} className="font-medium text-blue">
              Sozlamalar formasi →
            </Link>
          ) : null}
        </div>
      ) : null}
      <InvestigationBadges items={mine} />
    </div>
  );
}

export const investigationSettingsHref = (machineId: string): string => `/machines/${machineId}#${SETTINGS_ANCHOR}`;
