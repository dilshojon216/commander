"use client";

import type { QueueItemDto } from "@commander/contracts";
import Link from "next/link";
import { useMemo, useState } from "react";
import { InputGuard } from "@/components/ApprovalCard";
import { useLiveData } from "@/components/LiveData";
import { IconPlus } from "@/components/ui/icons";
import { LivePill, PageHeader } from "@/components/ui/PageHeader";
import { ApiErrorBar, EmptyState } from "@/components/ui/States";
import { formatDateTime } from "@/lib/format";
import { machineLabel } from "@/lib/machines";
import { describeQueueItem, sortQueue } from "@/lib/queue-view";
import type { QueueTone } from "@/lib/queue-view";
import { QueueFormDialog } from "./QueueFormDialog";
import { useQueue } from "./useQueue";

const TONE: Record<QueueTone, string> = {
  blue: "bg-blue-bg text-blue",
  yel: "bg-yel-bg text-yel",
  grn: "bg-grn-bg text-grn",
  red: "bg-red-bg text-red",
  gray: "bg-gray-bg text-mu",
};

/** "Navbat" sahifasi: faol elementlar (hozir ishga tushirish / bekor / tahrir) va tarix; yaratish formasi. */
export function QueueView() {
  const q = useQueue();
  const { machines, lockdown, canControl } = useLiveData();
  const [form, setForm] = useState<{ editing: QueueItemDto | null } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const { active, history } = useMemo(() => sortQueue(q.items), [q.items]);
  const machineName = useMemo(() => new Map(machines.map((m) => [m.id, machineLabel(m)])), [machines]);
  const blocked = lockdown ? "Lockdown yoqiq" : !canControl ? "Boshqaruv tokeni sozlanmagan" : null;

  async function run(fn: () => Promise<string | null>) {
    setActionError(null);
    const err = await fn();
    if (err) setActionError(err);
  }

  return (
    <>
      <PageHeader title="Navbat" count={`${active.length} faol`}>
        <LivePill />
        <button type="button" className="btn btn-pri" disabled={!!blocked} title={blocked ?? undefined} onClick={() => setForm({ editing: null })}>
          <IconPlus size={14} /> Navbatga qo&apos;shish
        </button>
      </PageHeader>
      <div className="flex flex-col gap-3.5 px-4 py-5 md:px-6">
        <ApiErrorBar error={q.error} />
        {actionError && (
          <div role="alert" className="rounded-md bg-red-bg px-3 py-2 text-red">
            {actionError}
          </div>
        )}
        {q.loaded && active.length === 0 && history.length === 0 ? (
          <EmptyState title="Navbat bo'sh">Vazifalarni limit yangilanganda, tunda yoki takroriy (cron) ishga tushirish uchun navbatga qo&apos;shing.</EmptyState>
        ) : (
          <>
            <Section title="Faol" empty="Faol element yo'q">
              {active.map((it) => (
                <QueueRow key={it.id} it={it} machine={machineName.get(it.machineId) ?? it.machineSlug} blocked={blocked} onRun={() => run(() => q.runNow(it.id))} onCancel={() => run(() => q.cancel(it.id))} onEdit={() => setForm({ editing: it })} onRemove={() => run(() => q.remove(it.id))} />
              ))}
            </Section>
            {history.length > 0 && (
              <Section title="Tarix" empty="">
                {history.map((it) => (
                  <QueueRow key={it.id} it={it} machine={machineName.get(it.machineId) ?? it.machineSlug} blocked={blocked} onRun={() => run(() => q.runNow(it.id))} onCancel={() => run(() => q.cancel(it.id))} onEdit={() => setForm({ editing: it })} onRemove={() => run(() => q.remove(it.id))} />
                ))}
              </Section>
            )}
          </>
        )}
      </div>
      {form && <QueueFormDialog api={q} editing={form.editing} onClose={() => setForm(null)} />}
    </>
  );
}

function Section({ title, empty, children }: { title: string; empty: string; children: React.ReactNode[] }) {
  return (
    <section className="flex flex-col gap-2" aria-label={title}>
      <span className="lbl">{title}</span>
      {children.length === 0 ? <span className="text-xs text-fa">{empty}</span> : children}
    </section>
  );
}

export function QueueRow({ it, machine, blocked, onRun, onCancel, onEdit, onRemove }: { it: QueueItemDto; machine: string; blocked: string | null; onRun: () => void; onCancel: () => void; onEdit: () => void; onRemove: () => void }) {
  const v = describeQueueItem(it);
  return (
    <article className="card flex flex-col gap-2 p-3.5" data-testid="queue-item" data-status={it.status}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`pill ${TONE[v.tone]}`}>{v.statusText}</span>
        <span className="mono font-medium">{machine}</span>
        <span className="text-mu">· {v.triggerText}</span>
        {v.nextText && <span className="text-mu">· keyingisi {v.nextText}</span>}
        {v.recurring && it.runCount > 0 && <span className="text-xs text-mu">· {it.runCount} marta ishga tushgan{it.lastRunAt ? `, oxirgisi ${formatDateTime(it.lastRunAt)}` : ""}</span>}
        <span className="flex-1" />
        {v.sessionHref && (
          <Link href={v.sessionHref} className="btn">
            Sessiya →
          </Link>
        )}
        {v.canRunNow && (
          <button type="button" className="btn" disabled={!!blocked} title={blocked ?? "Triggerni kutmasdan hozir ishga tushirish"} onClick={onRun}>
            Hozir ishga tushir
          </button>
        )}
        {v.canEdit && (
          <button type="button" className="btn" disabled={!!blocked} title={blocked ?? undefined} onClick={onEdit}>
            Tahrirlash
          </button>
        )}
        {v.canCancel && (
          <button type="button" className="btn" disabled={!!blocked} title={blocked ?? undefined} onClick={onCancel}>
            Bekor qilish
          </button>
        )}
        {v.canDelete && (
          <button type="button" className="btn" disabled={!!blocked} title={blocked ?? undefined} onClick={onRemove}>
            O&apos;chirish
          </button>
        )}
      </div>
      <div className="mono truncate text-xs text-mu" title={it.cwd}>
        {it.cwd}
        {it.model ? ` · ${it.model}` : ""} · {it.permissionMode}
        {it.taskKey ? ` · #${it.taskKey}` : ""}
      </div>
      <div className="text-xs" data-testid="queue-preview">
        {it.promptPreview}
        {it.promptLength > it.promptPreview.length ? ` … (+${it.promptLength - it.promptPreview.length} belgi: to'liq matn navbatda shifrlangan; yuqorida faqat boshi)` : ""}
      </div>
      <InputGuard detail={it.promptPreview} full={false} />
      {v.reasonText && <div className="text-xs text-yel">{v.reasonText}</div>}
    </article>
  );
}
