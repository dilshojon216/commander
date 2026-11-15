"use client";

import type { AlertDto } from "@commander/contracts";
import Link from "next/link";
import { useState } from "react";
import { InvestigateControl, investigationSettingsHref } from "@/components/investigations/InvestigateControl";
import { useLiveData } from "@/components/LiveData";
import { ALERT_KIND_ICON, alertHref, alertKindLabel, alertSummary, alertTarget, dismissAlertLocal, remindersText } from "@/lib/alerts-view";
import { ApiCallError, requestJson } from "@/lib/client-api";
import { formatCompact } from "@/lib/format";
import { canInvestigateAlert } from "@/lib/investigation-view";
import { useInvestigations } from "@/lib/use-investigations";
import type { InvestigationDto } from "@commander/contracts";
import { useNow } from "@/lib/use-now";

export interface AlertsCardViewProps {
  alerts: AlertDto[];
  now: number;
  canControl: boolean;
  /** Hozir yopilayotgan ogohlantirish id'si. */
  dismissingId: string | null;
  error: string | null;
  onDismiss: (id: string) => void;
  /** "Claude tekshirsin" (6.4): berilmasa tugma ko'rsatilmaydi. */
  investigate?: { items: InvestigationDto[]; blocked: string | null; reload: () => void };
}

/** "Ogohlantirishlar" kartasi: faqat ko'rinish (props orqali; testlanadi). */
export function AlertsCardView({ alerts, now, canControl, dismissingId, error, onDismiss, investigate }: AlertsCardViewProps) {
  return (
    <section className="card overflow-hidden" aria-label="Ogohlantirishlar" data-testid="alerts-card">
      <div className="flex items-center justify-between px-4 py-3">
        <h2 className="m-0 text-sm font-semibold">
          Ogohlantirishlar <span className="font-normal text-mu">{alerts.length}</span>
        </h2>
        <Link href="/alerts" className="text-xs">
          Tarix va sozlamalar →
        </Link>
      </div>
      {error && (
        <div role="alert" className="mx-4 mb-2 rounded-lg bg-red-bg px-3 py-2 text-xs text-red">
          {error}
        </div>
      )}
      {alerts.length === 0 ? (
        <div className="border-t border-bd px-4 py-3 text-mu" data-testid="alerts-empty">
          Hozircha ogohlantirish yo&apos;q
        </div>
      ) : (
        <ul className="m-0 list-none p-0">
          {alerts.map((a) => (
            <li key={a.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 border-t border-bd px-4 py-3" data-testid="alert-row">
              <span className="pill bg-org-bg text-org" title={alertKindLabel(a.kind)}>
                <span aria-hidden="true">{ALERT_KIND_ICON[a.kind]}</span> {alertKindLabel(a.kind)}
              </span>
              <div className="flex min-w-0 flex-1 basis-[240px] flex-col gap-0.5">
                <Link href={alertHref(a)} className="truncate font-semibold text-tx hover:no-underline">
                  {a.title}
                </Link>
                <span className="break-words text-xs text-mu">{a.detail || alertSummary(a)}</span>
                <span className="text-xs text-mu">
                  <span className="mono">{alertTarget(a)}</span>
                  {a.projectName && a.sessionName ? <span> · {a.sessionName}</span> : null}
                  <span suppressHydrationWarning> · {now ? `${formatCompact(now - Date.parse(a.createdAt))} oldin` : ""}</span>
                  {remindersText(a.remindersSent) && <span> · {remindersText(a.remindersSent)}</span>}
                </span>
              </div>
              {a.autoStopped && (
                <span className="pill bg-red-bg text-red" data-testid="alert-autostopped">
                  avto-to&apos;xtatilgan
                </span>
              )}
              <Link href={alertHref(a)} className="text-xs font-medium text-blue">
                Sessiya →
              </Link>
              {canControl && (
                <button type="button" className="btn" disabled={dismissingId === a.id} onClick={() => onDismiss(a.id)} data-testid="alert-dismiss">
                  {dismissingId === a.id ? "Yopilmoqda..." : "Yopish"}
                </button>
              )}
              {investigate && <InvestigateControl kind="watchdog" subjectId={a.id} items={investigate.items} eligible={canInvestigateAlert(a, now)} blocked={investigate.blocked} onChanged={investigate.reload} settingsHref={investigationSettingsHref(a.machineId)} />}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Umumiy sahifadagi kartani jonli ma'lumotga ulaydi. */
export function AlertsCard() {
  const { alerts, canControl, lockdown } = useLiveData();
  const investigations = useInvestigations({ kind: "watchdog" });
  const now = useNow();
  const [hidden, setHidden] = useState<string[]>([]);
  const [dismissingId, setDismissingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const visible = hidden.reduce((list, id) => dismissAlertLocal(list, id), alerts);

  const onDismiss = (id: string) => {
    setDismissingId(id);
    setError(null);
    requestJson("POST", `/alerts/${id}/dismiss`)
      .then(() => setHidden((h) => [...h, id]))
      .catch((e: unknown) => setError(e instanceof ApiCallError && e.status === 403 ? "Boshqaruv token'i yo'q yoki lockdown yoqiq" : "Yopib bo'lmadi, qayta urinib ko'ring"))
      .finally(() => setDismissingId(null));
  };

  return <AlertsCardView alerts={visible} now={now} canControl={canControl} dismissingId={dismissingId} error={error} onDismiss={onDismiss} investigate={{ items: investigations.items, blocked: lockdown ? "Lockdown yoqiq" : !canControl ? "Boshqaruv token'i yo'q" : null, reload: investigations.reload }} />;
}
