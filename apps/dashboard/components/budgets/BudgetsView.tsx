"use client";

import type { BudgetScopeKind, BudgetStatus } from "@commander/contracts";
import { useMemo, useState } from "react";
import { BudgetBar } from "@/components/budgets/BudgetBar";
import { useLiveData } from "@/components/LiveData";
import { Dialog } from "@/components/ui/Dialog";
import { LivePill, PageHeader } from "@/components/ui/PageHeader";
import { ApiErrorBar, EmptyState } from "@/components/ui/States";
import { ApiCallError } from "@/lib/client-api";
import { buildOverrideBody, buildPutBody, buildRemoveBody, findBudget, projectBudgetKey } from "@/lib/budgets-view";
import { machineLabel } from "@/lib/machines";
import { useBudgets, overrideBudget, putBudget } from "@/lib/use-budgets";
import { useNow } from "@/lib/use-now";

const errText = (e: unknown): string => (e instanceof ApiCallError && (e.status === 401 || e.status === 403) ? "Ruxsat yo'q: boshqaruv token'i, lockdown yoki qayta tasdiqlash kerak." : "Saqlab bo'lmadi, qayta urinib ko'ring.");

/** Byudjet sozlamalari: ob'ekt (loyiha/mashina), kunlik chegara, avto-to'xtatish, "bugun uchun +X". */
export function BudgetsView() {
  const { projects, machines, canControl, lockdown } = useLiveData();
  const { data, error, reload } = useBudgets();
  const now = useNow();
  const [kind, setKind] = useState<BudgetScopeKind>("project");
  const [key, setKey] = useState("");
  const [amount, setAmount] = useState("");
  const [autoStop, setAutoStop] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [fail, setFail] = useState<string | null>(null);
  const [overrideFor, setOverrideFor] = useState<BudgetStatus | null>(null);

  const options = useMemo(() => {
    if (kind === "machine") return machines.map((m) => ({ key: m.id, label: machineLabel(m) }));
    const seen = new Map<string, string>();
    for (const p of projects?.items ?? []) {
      const k = projectBudgetKey(p);
      if (!seen.has(k)) seen.set(k, p.name);
    }
    return [...seen].map(([k, label]) => ({ key: k, label })).sort((a, b) => a.label.localeCompare(b.label));
  }, [kind, machines, projects]);

  const can = canControl && !lockdown;
  const existing = data && key ? findBudget(data.items, kind, key) : null;

  async function save() {
    const { body, error: e } = buildPutBody(kind, key, amount, autoStop);
    if (!body) return setFail(e);
    setBusy(true);
    setFail(null);
    setMsg(null);
    try {
      await putBudget(body);
      setMsg("Saqlandi");
      reload();
    } catch (err) {
      setFail(errText(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(s: BudgetStatus) {
    setBusy(true);
    setFail(null);
    try {
      await putBudget(buildRemoveBody(s.scopeKind, s.scopeKey));
      reload();
    } catch (err) {
      setFail(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title="Byudjetlar" count="Kunlik token chegarasi">
        <LivePill />
      </PageHeader>
      <div className="flex w-full max-w-[1100px] flex-col gap-4 p-4 md:p-6">
        <ApiErrorBar error={error} />
        <p className="m-0 text-xs text-mu">
          Birlik: <b>vaznli token</b> (input×1 + output×5 + cache yozish×1.25 + cache o&apos;qish×0.1: limit kalibrlashi bilan bir xil). Kun Toshkent vaqti bilan 00:00 da yangilanadi. 80% da ogohlantirish, 100% da yangi sessiya, navbat va orkestratsiya rad etiladi; ishlayotgan sessiyalar o&apos;zi to&apos;xtamaydi (avto-to&apos;xtatish yoqilmasa).
        </p>

        <section className="card flex flex-col gap-3 p-4" aria-label="Byudjet qo'shish" data-testid="budget-form">
          <h2 className="m-0 text-sm font-semibold">Byudjet belgilash</h2>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="lbl">Ob&apos;ekt turi</span>
              <select className="field" value={kind} onChange={(e) => { setKind(e.target.value as BudgetScopeKind); setKey(""); }} data-testid="budget-kind">
                <option value="project">Loyiha</option>
                <option value="machine">Mashina</option>
              </select>
            </label>
            <label className="flex min-w-[220px] flex-1 flex-col gap-1.5">
              <span className="lbl">{kind === "project" ? "Loyiha" : "Mashina"}</span>
              <select className="field" value={key} onChange={(e) => setKey(e.target.value)} data-testid="budget-key">
                <option value="">Tanlang…</option>
                {options.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="lbl">Kunlik chegara</span>
              <input className="field" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="masalan 5m, 250k" spellCheck={false} autoComplete="off" data-testid="budget-amount" />
            </label>
          </div>
          <label className="flex items-start gap-2 text-xs">
            <input type="checkbox" checked={autoStop} onChange={(e) => setAutoStop(e.target.checked)} data-testid="budget-autostop" />
            <span>
              Chegara tugaganda ishlayotgan sessiyalarni <b>avtomatik to&apos;xtatish</b>. Ehtiyot bo&apos;ling: bajarilayotgan ish yarim yo&apos;lda uziladi. O&apos;chiq bo&apos;lsa faqat Telegram&apos;da &quot;To&apos;xtatish&quot; tugmali ogohlantirish keladi.
            </span>
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn btn-pri" disabled={!can || busy} onClick={() => void save()} data-testid="budget-save">
              {busy ? "Saqlanmoqda…" : existing ? "Yangilash" : "Saqlash"}
            </button>
            {!can ? <span className="text-xs text-mu">Boshqaruv token&apos;i kerak (lockdown o&apos;chiq bo&apos;lsin).</span> : null}
            {msg ? <span className="text-xs text-grn">{msg}</span> : null}
            <span className="text-xs text-mu">Saqlash yangi tasdiq (Touch ID/parol) talab qiladi.</span>
          </div>
          {fail ? (
            <div role="alert" className="text-xs text-red" data-testid="budget-error">
              {fail}
            </div>
          ) : null}
        </section>

        <section className="card flex flex-col gap-4 p-4" aria-label="Byudjetlar ro'yxati">
          <h2 className="m-0 text-sm font-semibold">Joriy byudjetlar</h2>
          {!data || data.items.length === 0 ? (
            <EmptyState title="Byudjet belgilanmagan">Yuqoridagi forma orqali loyiha yoki mashina uchun kunlik chegara qo&apos;ying.</EmptyState>
          ) : (
            data.items.map((s) => (
              <div key={`${s.scopeKind}:${s.scopeKey}`} className="flex flex-col gap-2 border-b border-bd pb-3 last:border-0 last:pb-0">
                <BudgetBar status={s} label={`${s.scopeKind === "project" ? "Loyiha" : "Mashina"}: ${s.label}`} resetsAt={data.resetsAt} now={now} />
                <div className="flex gap-2">
                  <button type="button" className="btn" disabled={!can || busy} onClick={() => setOverrideFor(s)}>
                    Bugun uchun +X
                  </button>
                  <button type="button" className="btn" disabled={!can || busy} onClick={() => void remove(s)}>
                    Olib tashlash
                  </button>
                </div>
              </div>
            ))
          )}
        </section>
      </div>
      {overrideFor ? <OverrideDialog status={overrideFor} onClose={() => setOverrideFor(null)} onDone={() => { setOverrideFor(null); reload(); }} /> : null}
    </>
  );
}

/** "Bugun uchun +X": faqat bugun amal qiladi (yarim kechada nolga tushadi); audit qilinadi. */
export function OverrideDialog({ status, onClose, onDone }: { status: BudgetStatus; onClose: () => void; onDone: () => void }) {
  const [extra, setExtra] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function go() {
    const { body, error: e } = buildOverrideBody(status.scopeKind, status.scopeKey, extra);
    if (!body) return setError(e);
    setBusy(true);
    setError(null);
    try {
      await overrideBudget(body);
      onDone();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog labelledBy="ov-title" onClose={onClose}>
      <div className="flex flex-col gap-3 px-5 py-4" data-testid="override-dialog">
        <h2 id="ov-title" className="m-0 text-base font-semibold">
          Bugun uchun qo&apos;shimcha: {status.label}
        </h2>
        <p className="m-0 text-xs text-mu">Chegara faqat bugun (Toshkent vaqti bilan yarim kechagacha) oshadi. Amal audit jurnaliga yoziladi va yangi tasdiq talab qiladi.</p>
        <input className="field" value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="masalan 500k yoki 2m" autoComplete="off" spellCheck={false} data-testid="override-amount" />
        {error ? (
          <div role="alert" className="text-xs text-red">
            {error}
          </div>
        ) : null}
        <div className="flex gap-2">
          <button type="button" className="btn btn-pri" disabled={busy} onClick={() => void go()} data-testid="override-submit">
            {busy ? "Yuborilmoqda…" : "Oshirish"}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Bekor qilish
          </button>
        </div>
      </div>
    </Dialog>
  );
}
