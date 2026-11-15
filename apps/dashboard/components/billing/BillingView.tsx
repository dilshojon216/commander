"use client";

import { useState } from "react";
import { PageHeader } from "@/components/ui/PageHeader";
import { defaultPeriod } from "@/lib/billing-view";
import type { PeriodForm } from "@/lib/billing-view";
import { ClientReportPanel } from "./ClientReportPanel";
import { ClientsPanel } from "./ClientsPanel";
import { TimesheetPanel } from "./TimesheetPanel";
import { useBillingClients } from "./useBilling";

const TABS = [
  { id: "timesheet", label: "Hisob-kitob" },
  { id: "clients", label: "Mijozlar" },
  { id: "report", label: "Mijoz hisoboti" },
] as const;
type Tab = (typeof TABS)[number]["id"];

/** "Hisob-kitob" sahifasi (6.7 timesheet/xarajat, 6.8 mijoz hisoboti). */
export function BillingView() {
  const api = useBillingClients();
  const [tab, setTab] = useState<Tab>("timesheet");
  const [period, setPeriod] = useState<PeriodForm>(() => defaultPeriod());

  return (
    <>
      <PageHeader title="Hisob-kitob" count={`${api.clients.length} mijoz`} />
      <div className="flex flex-col gap-3.5 px-4 py-5 md:px-6">
        <div className="flex gap-1" role="tablist" aria-label="Bo'limlar">
          {TABS.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={`seg ${tab === t.id ? "on" : ""}`} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        {tab === "timesheet" && <TimesheetPanel clients={api.clients} period={period} onPeriod={setPeriod} />}
        {tab === "clients" && <ClientsPanel api={api} />}
        {tab === "report" && <ClientReportPanel clients={api.clients} projects={api.projects} period={period} onPeriod={setPeriod} />}
      </div>
    </>
  );
}
