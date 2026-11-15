"use client";

import type { PutPaceSettingsBody } from "@commander/contracts";
import Link from "next/link";
import { useState } from "react";
import { useLiveData } from "@/components/LiveData";
import { LivePill, PageHeader } from "@/components/ui/PageHeader";
import { ApiErrorBar } from "@/components/ui/States";
import { ApiCallError } from "@/lib/client-api";
import { settingsErrorText } from "@/lib/general-settings-view";
import { overridePace, putPaceSettings, putStepUpExemption, usePaceSettings, useStepUpExemption } from "@/lib/use-general-settings";
import { PaceSettingsCard } from "./PaceSettingsCard";
import { RemoteControlStateCard } from "./RemoteControlStateCard";
import { StepUpExemptionCard } from "./StepUpExemptionCard";

const errOf = (e: unknown): string => (e instanceof ApiCallError ? settingsErrorText(e.status, e.body) : settingsErrorText(null, null));

/** Egasi sozlamalari: haftalik limit tezligi (6.12), Telegram step-up istisnosi, masofaviy boshqaruv holati (faqat o'qish). */
export function GeneralSettingsView() {
  const { machines, canControl, lockdown } = useLiveData();
  const pace = usePaceSettings();
  const stepUp = useStepUpExemption();
  const [paceBusy, setPaceBusy] = useState(false);
  const [paceMsg, setPaceMsg] = useState<string | null>(null);
  const [paceFail, setPaceFail] = useState<string | null>(null);
  const [stepBusy, setStepBusy] = useState(false);
  const [stepMsg, setStepMsg] = useState<string | null>(null);
  const [stepFail, setStepFail] = useState<string | null>(null);

  async function savePace(body: PutPaceSettingsBody) {
    setPaceBusy(true);
    setPaceFail(null);
    setPaceMsg(null);
    try {
      pace.set(await putPaceSettings(body));
      setPaceMsg("Saqlandi");
    } catch (e) {
      setPaceFail(errOf(e));
    } finally {
      setPaceBusy(false);
    }
  }

  async function override(reset: boolean) {
    setPaceBusy(true);
    setPaceFail(null);
    setPaceMsg(null);
    try {
      pace.set(await overridePace(reset ? { reset: true } : {}));
      setPaceMsg(reset ? "Ruxsat bekor qilindi" : "Bugun uchun ruxsat berildi");
    } catch (e) {
      setPaceFail(errOf(e));
    } finally {
      setPaceBusy(false);
    }
  }

  async function changeStepUp(exempt: boolean) {
    setStepBusy(true);
    setStepFail(null);
    setStepMsg(null);
    try {
      stepUp.set(await putStepUpExemption(exempt));
      setStepMsg(exempt ? "Yoqildi: dashboard amallari Telegram tasdig'isiz" : "O'chirildi: Telegram tasdig'i qaytdi");
    } catch (e) {
      setStepFail(errOf(e));
    } finally {
      setStepBusy(false);
    }
  }

  const canWrite = canControl && !lockdown;
  return (
    <>
      <PageHeader title="Umumiy sozlamalar" count="Egasi sozlamalari">
        <LivePill />
      </PageHeader>
      <div className="flex w-full max-w-[1100px] flex-col gap-4 p-4 md:p-6">
        <ApiErrorBar error={pace.error ?? stepUp.error} />
        <p className="m-0 text-xs text-mu">
          Mashinalar bilan fayl sinxronlash (agent, skill, hook) alohida sahifada:{" "}
          <Link href="/settings-sync" className="text-blue underline" data-testid="settings-sync-link">
            Sozlamalarni sinxronlash
          </Link>
          .
        </p>
        <PaceSettingsCard res={pace.data} canWrite={canWrite} busy={paceBusy} message={paceMsg} failure={paceFail} onSave={(b) => void savePace(b)} onOverride={(r) => void override(r)} />
        <StepUpExemptionCard res={stepUp.data} canWrite={canControl} lockdown={lockdown} busy={stepBusy} message={stepMsg} failure={stepFail} onChange={(x) => void changeStepUp(x)} />
        <RemoteControlStateCard machines={machines} />
      </div>
    </>
  );
}
