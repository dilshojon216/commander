"use client";

import { ListSessionsResponseV1Schema } from "@commander/contracts";
import type { SessionDto, SessionStatus } from "@commander/contracts";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useLiveData } from "@/components/LiveData";
import { NewSessionButton } from "@/components/shell/NewSessionButton";
import { LivePill, PageHeader, SearchBox } from "@/components/ui/PageHeader";
import { ApiErrorBar, EmptyState } from "@/components/ui/States";
import { StatusPill } from "@/components/ui/StatusPill";
import { TaskPill } from "@/components/TaskPill";
import { getJson } from "@/lib/client-api";
import { formatCompact } from "@/lib/format";
import { machineLabel, shortMachineName } from "@/lib/machines";
import { upsertById } from "@/lib/push";
import { sortSessionList } from "@/lib/session-list";
import { filterSessions, isStaleIdle, sessionColumns } from "@/lib/sessions-view";
import { STATUS_META, displayStatus } from "@/lib/status";
import { useNow } from "@/lib/use-now";

type Chip = { id: "all" | SessionStatus; label: string; color: string };

const CHIPS: Chip[] = [
  { id: "all", label: "Hammasi", color: "var(--mu)" },
  { id: "awaiting_approval", label: "Ruxsat kutmoqda", color: "var(--org)" },
  { id: "waiting", label: "Javob kutmoqda", color: "var(--yel)" },
  { id: "working", label: "Ishlamoqda", color: "var(--blue)" },
  { id: "idle", label: "Bo'sh", color: "var(--mu)" },
  { id: "done", label: "Tugatdi", color: "var(--grn)" },
];
const ENDED_CHIP: Chip = { id: "ended", label: "Yopilgan", color: "var(--fa)" };

/** Bitta qator uchun havola katagi: faqat birinchisi fokuslanadi (ekran o'qiydigan takrorlanmasin). */
function Cell({ href, first, className = "", children }: { href: string; first?: boolean; className?: string; children: React.ReactNode }) {
  return (
    <Link href={href} className={`cell ${className}`} tabIndex={first ? undefined : -1} aria-hidden={first ? undefined : true}>
      {children}
    </Link>
  );
}

export function SessionsView({ initialQuery }: { initialQuery: string }) {
  const { sessions: active, machines, error } = useLiveData();
  const now = useNow();
  const [status, setStatus] = useState<"all" | SessionStatus>("all");
  const [machineId, setMachineId] = useState("");
  const [project, setProject] = useState("");
  const [text, setText] = useState(initialQuery);
  const [showEnded, setShowEnded] = useState(false);
  const [all, setAll] = useState<SessionDto[] | null>(null);
  const [allError, setAllError] = useState<string | null>(null);

  // "Tugaganlarini ham ko'rsat": yakunlangan sessiyalar ham (bir marta olinadi, faol ro'yxat jonli ustiga yoziladi)
  useEffect(() => {
    if (!showEnded) return;
    const ctl = new AbortController();
    getJson("/sessions?limit=500", ListSessionsResponseV1Schema, ctl.signal)
      .then((r) => {
        setAll(r.items);
        setAllError(null);
      })
      .catch((e: unknown) => {
        if (!ctl.signal.aborted) setAllError(e instanceof Error ? e.message : "Xatolik");
      });
    return () => ctl.abort();
  }, [showEnded]);

  const source = useMemo(() => {
    if (!showEnded || !all) return active;
    const hidden = new Set<string>();
    const knownMachines = new Set(machines.map((m) => m.id));
    for (const s of all) if (!knownMachines.has(s.machineId)) hidden.add(s.machineId);
    let list = all.filter((s) => !hidden.has(s.machineId));
    for (const s of active) list = upsertById(list, s);
    return list;
  }, [showEnded, all, active, machines]);

  const base = useMemo(() => {
    const filtered = filterSessions(source, { machineId: machineId || null, status: null, text, showAll: showEnded }, new Set(), now);
    return filtered.filter((s) => !project || s.projectName === project);
  }, [source, machineId, text, showEnded, project, now]);

  const rows = useMemo(() => sortSessionList(base.filter((s) => status === "all" || s.status === status)), [base, status]);
  const cols = useMemo(() => sessionColumns(rows), [rows]);
  const chips = showEnded ? [...CHIPS, ENDED_CHIP] : CHIPS;
  const count = (id: Chip["id"]) => (id === "all" ? base.length : base.filter((s) => s.status === id).length);
  const projectNames = useMemo(() => [...new Set(source.map((s) => s.projectName))].sort((a, b) => a.localeCompare(b)), [source]);

  return (
    <>
      <PageHeader title="Sessiyalar" count={`${rows.length} ta`}>
        <LivePill />
        <NewSessionButton />
      </PageHeader>

      <div className="flex w-full flex-col gap-3.5 px-4 py-5 md:px-6">
        <ApiErrorBar error={error ?? allError} />
        <div className="flex flex-wrap items-center gap-2">
          {chips.map((c) => (
            <button key={c.id} type="button" className={`chip ${status === c.id ? "on" : ""}`} aria-pressed={status === c.id} onClick={() => setStatus(c.id)}>
              <span className="dot" style={{ color: c.color }} />
              {c.label} <span className="mono text-mu">{count(c.id)}</span>
            </button>
          ))}
          <span className="flex-1" />
          <label className="flex items-center gap-1.5 text-xs text-mu">
            Mashina
            <select className="sel" value={machineId} onChange={(e) => setMachineId(e.target.value)}>
              <option value="">Hammasi</option>
              {machines.map((m) => (
                <option key={m.id} value={m.id}>
                  {machineLabel(m)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-xs text-mu">
            Loyiha
            <select className="sel" value={project} onChange={(e) => setProject(e.target.value)}>
              <option value="">Hammasi</option>
              {projectNames.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <SearchBox value={text} onChange={setText} placeholder="Qidiruv" label="Sessiyalarni qidirish" height={30} />
          <label className="flex items-center gap-1.5 text-xs text-mu">
            <input type="checkbox" checked={showEnded} onChange={(e) => setShowEnded(e.target.checked)} />
            Tugaganlarini ham ko&apos;rsat
          </label>
        </div>

        {rows.length === 0 ? (
          <EmptyState title={source.length === 0 ? "Sessiya yo'q" : "Mos sessiya topilmadi"} action={source.length === 0 ? <NewSessionButton /> : undefined}>
            {source.length === 0 ? "Hozir hech bir mashinada Claude ishlamayapti." : "Filtrlarni o'zgartirib ko'ring."}
          </EmptyState>
        ) : (
          <div className="card overflow-x-auto">
            <table className="dtable">
              <thead>
                <tr>
                  <th scope="col">Holat</th>
                  <th scope="col">Loyiha</th>
                  <th scope="col">Mashina</th>
                  <th scope="col">Model</th>
                  <th scope="col">Holatda</th>
                  {cols.message && (
                    <th scope="col" style={{ width: "40%" }}>
                      Oxirgi xabar
                    </th>
                  )}
                  {cols.approvals && <th scope="col">Ruxsat</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => {
                  const ds = displayStatus(s);
                  const href = `/sessions/${s.id}`;
                  const old = isStaleIdle(s, now);
                  return (
                    <tr key={s.id} data-testid="session-row" data-stale-idle={old ? "true" : undefined} style={{ opacity: old ? 0.5 : ds === "stale" ? 0.55 : STATUS_META[ds].dim ? 0.7 : 1 }}>
                      <td>
                        <Cell href={href} first>
                          {old ? (
                            <span className="pill bg-gray-bg text-mu" title="6 soatdan ortiq ko'rinmagan bo'sh sessiya">
                              Eskirgan
                            </span>
                          ) : (
                            <StatusPill status={ds} />
                          )}
                        </Cell>
                      </td>
                      <td>
                        <Cell href={href} className="font-semibold">
                          {s.projectName} <TaskPill session={s} />
                        </Cell>
                      </td>
                      <td>
                        <Cell href={href} className="mono text-mu">
                          {shortMachineName(s.machineName)} {ds === "stale" && <span className="text-org">⚠</span>}
                        </Cell>
                      </td>
                      <td>
                        <Cell href={href} className="mono text-xs text-mu">
                          {s.model ?? "—"}
                        </Cell>
                      </td>
                      <td>
                        <Cell href={href} className="mono text-mu">
                          <span suppressHydrationWarning>{now ? formatCompact(now - Date.parse(s.statusSince)) : ""}</span>
                        </Cell>
                      </td>
                      {cols.message && (
                        <td>
                          <Cell href={href} className="max-w-[460px] truncate text-mu">
                            {s.message?.trim() || "—"}
                          </Cell>
                        </td>
                      )}
                      {cols.approvals && (
                        <td>
                          <Cell href={href}>
                            {s.pendingApprovals > 0 && (
                              <span className="pill bg-org text-white" style={{ height: 20 }} aria-label={`${s.pendingApprovals} ta ruxsat so'rovi`}>
                                {s.pendingApprovals}
                              </span>
                            )}
                          </Cell>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <span className="text-xs text-mu">
          Qatorni bosing: sessiya sahifasi ochiladi. <span className="kbd">g</span> <span className="kbd">s</span> bilan istalgan joydan shu sahifaga o&apos;tasiz.
        </span>
      </div>
    </>
  );
}
