"use client";

import { ListAlertsResponseSchema, WatchdogSettingsSchema } from "@commander/contracts";
import type { AlertDto, WatchdogSettings } from "@commander/contracts";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { WatchdogSettingsForm } from "@/components/alerts/WatchdogSettingsForm";
import { InvestigateControl, investigationSettingsHref } from "@/components/investigations/InvestigateControl";
import { useLiveData } from "@/components/LiveData";
import { LivePill, PageHeader } from "@/components/ui/PageHeader";
import { ApiErrorBar, EmptyState } from "@/components/ui/States";
import { ALERT_KIND_ICON, alertHref, alertKindLabel, alertStateLabel, alertSummary, alertTarget, remindersText } from "@/lib/alerts-view";
import { ApiCallError, getJson, requestJson } from "@/lib/client-api";
import { formatDateTime } from "@/lib/format";
import { canInvestigateAlert } from "@/lib/investigation-view";
import { useInvestigations } from "@/lib/use-investigations";
import { useNow } from "@/lib/use-now";

/** "Ogohlantirishlar" sahifasi: tarix (state=all) va watchdog sozlamalari. */
export function AlertsView() {
  const { alerts: openAlerts, projects, canControl, lockdown } = useLiveData();
  const investigations = useInvestigations({ kind: "watchdog" });
  const now = useNow();
  const [history, setHistory] = useState<AlertDto[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [settings, setSettings] = useState<WatchdogSettings | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  // Jonli ochiq ro'yxat o'zgarganda (yangi/yopilgan) tarixni qayta o'qiymiz
  const openKey = openAlerts.map((a) => `${a.id}:${a.updatedAt}`).join(",");
  useEffect(() => {
    const ctl = new AbortController();
    getJson("/alerts?state=all&limit=100", ListAlertsResponseSchema, ctl.signal)
      .then((r) => {
        setHistory(r.items);
        setHistoryError(null);
      })
      .catch((e: unknown) => {
        if (!ctl.signal.aborted) setHistoryError(e instanceof Error ? e.message : "Tarixni olib bo'lmadi");
      });
    return () => ctl.abort();
  }, [openKey]);

  useEffect(() => {
    const ctl = new AbortController();
    getJson("/watchdog/settings", WatchdogSettingsSchema, ctl.signal)
      .then(setSettings)
      .catch((e: unknown) => {
        if (!ctl.signal.aborted) setSettingsError(e instanceof Error ? e.message : "Sozlamalarni olib bo'lmadi");
      });
    return () => ctl.abort();
  }, []);

  const save = useCallback(async (s: WatchdogSettings) => {
    try {
      await requestJson("PUT", "/watchdog/settings", s);
    } catch (e) {
      if (e instanceof ApiCallError && (e.status === 403 || e.status === 401)) throw new Error("Ruxsat yo'q: boshqaruv token'i yoki lockdown");
      throw new Error("Saqlab bo'lmadi, qayta urinib ko'ring");
    }
    setSettings(s);
  }, []);

  const projectOptions = useMemo(() => (projects?.items ?? []).map((p) => ({ id: p.id, name: p.name })), [projects]);

  return (
    <>
      <PageHeader title="Ogohlantirishlar" count={history ? history.length : undefined}>
        <LivePill />
      </PageHeader>
      <div className="flex w-full max-w-[1100px] flex-col gap-5 p-4 md:p-6">
        <ApiErrorBar error={historyError ?? settingsError} />

        <section className="flex flex-col gap-2.5" aria-label="Tarix">
          <h2 className="m-0 text-sm font-semibold">Tarix</h2>
          {history === null && !historyError && <span className="text-mu">Yuklanmoqda...</span>}
          {history !== null && history.length === 0 && <EmptyState title="Ogohlantirish yo'q">Watchdog hozircha hech narsa topmadi.</EmptyState>}
          {history !== null && history.length > 0 && (
            <div className="card overflow-hidden" data-testid="alerts-history">
              {history.map((a) => (
                <div key={a.id}>
                <Link href={alertHref(a)} className="row flex-wrap" style={{ padding: "12px 16px" }}>
                  <span className="pill bg-s3">
                    <span aria-hidden="true">{ALERT_KIND_ICON[a.kind]}</span> {alertKindLabel(a.kind)}
                  </span>
                  <span className={`pill ${a.state === "open" ? "bg-org-bg text-org" : "bg-gray-bg text-mu"}`}>{alertStateLabel(a)}</span>
                  <span className="min-w-0 flex-1 basis-[200px]">
                    <span className="font-semibold">{a.title}</span> <span className="text-mu">· {alertTarget(a)}</span>
                    <span className="block text-xs text-mu">{alertSummary(a)}</span>
                  </span>
                  {a.autoStopped && <span className="pill bg-red-bg text-red">avto-to&apos;xtatilgan</span>}
                  {remindersText(a.remindersSent) && <span className="text-xs text-mu">{remindersText(a.remindersSent)}</span>}
                  <span className="mono text-xs text-mu" suppressHydrationWarning>
                    {formatDateTime(a.createdAt)}
                  </span>
                </Link>
                <div className="px-4 pb-3">
                  <InvestigateControl kind="watchdog" subjectId={a.id} items={investigations.items} eligible={canInvestigateAlert(a, now)} blocked={lockdown ? "Lockdown yoqiq" : !canControl ? "Boshqaruv token'i yo'q" : null} onChanged={investigations.reload} settingsHref={investigationSettingsHref(a.machineId)} />
                </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="flex flex-col gap-2.5" aria-label="Sozlamalar">
          <h2 className="m-0 text-sm font-semibold">Watchdog sozlamalari</h2>
          {settings ? (
            <WatchdogSettingsForm initial={settings} projects={projectOptions} canControl={canControl} onSave={save} />
          ) : (
            !settingsError && <span className="text-mu">Yuklanmoqda...</span>
          )}
        </section>
      </div>
    </>
  );
}
