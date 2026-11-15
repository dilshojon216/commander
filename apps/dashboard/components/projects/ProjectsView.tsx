"use client";

import { ListProjectsResponseSchema, ProjectPartsResponseSchema, ProjectTasksResponseSchema } from "@commander/contracts";
import type { ProjectDto, TasksSummary } from "@commander/contracts";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { OpenSessionIconButton } from "@/components/control/OpenSessionButton";
import { useLiveData } from "@/components/LiveData";
import { LivePill, PageHeader, SearchBox } from "@/components/ui/PageHeader";
import { ApiErrorBar, EmptyState } from "@/components/ui/States";
import { formatCount, formatLastUsed, formatTokens, formatTokensOrDash } from "@/lib/format";
import { getJson } from "@/lib/client-api";
import { useLive } from "@/lib/live-client";
import { machineNameMap } from "@/lib/machines";
import { combinedPlanSummary } from "@/lib/parts-view";
import { ARCHIVE_HINT, archivedToggleLabel, showArchivedToggle, sortProjects, withLastActivity } from "@/lib/projects-view";
import type { ProjectSortKey } from "@/lib/projects-view";
import { useNow } from "@/lib/use-now";
import { useArchiveProject } from "./useArchiveProject";

/** Sessiya davomida saqlanadigan reja xulosalari (loyiha id -> done/total). */
const summaryCache = new Map<string, TasksSummary | null>();
/** Ko'p qismli loyihalar: xulosa qismlar yig'indisi; `project.updated` (faqat ildiz xulosasi) uni bosib ketmasin. */
const multiPart = new Set<string>();

function useTaskSummaries(ids: string[]): Record<string, TasksSummary | null> {
  const [map, setMap] = useState<Record<string, TasksSummary | null>>(() => Object.fromEntries(summaryCache));
  const key = ids.join(",");
  useEffect(() => {
    const ctl = new AbortController();
    const todo = key ? key.split(",").filter((id) => !summaryCache.has(id)) : [];
    let next = 0;
    const worker = async () => {
      while (next < todo.length && !ctl.signal.aborted) {
        const id = todo[next++];
        try {
          // Avval qismlar: ko'p qismli loyihada reja ildizda emas, qismlarda (ildiz xulosasi "—" chiqardi)
          const parts = await getJson(`/projects/${id}/parts`, ProjectPartsResponseSchema, ctl.signal).catch((e: unknown) => {
            if (ctl.signal.aborted) throw e;
            return null;
          });
          if (parts && parts.parts.some((p) => p.part !== "")) {
            multiPart.add(id);
            summaryCache.set(id, combinedPlanSummary(parts.parts));
          } else {
            const r = await getJson(`/projects/${id}/tasks`, ProjectTasksResponseSchema, ctl.signal);
            summaryCache.set(id, r.tasksMd && r.summary.total > 0 ? r.summary : null);
          }
        } catch {
          if (ctl.signal.aborted) return;
          continue;
        }
        setMap(Object.fromEntries(summaryCache));
      }
    };
    void Promise.all([worker(), worker(), worker(), worker()]);
    return () => ctl.abort();
  }, [key]);
  // Jonli: project.updated reja xulosasini yangilaydi
  useLive(
    (type, payload) => {
      if (type !== "project.updated" || typeof payload !== "object" || payload === null) return;
      const p = (payload as { project?: { id?: string; tasks?: TasksSummary | null } }).project;
      if (p?.id && p.tasks !== undefined && !multiPart.has(p.id)) {
        summaryCache.set(p.id, p.tasks && p.tasks.total > 0 ? p.tasks : null);
        setMap(Object.fromEntries(summaryCache));
      }
    },
    () => undefined,
  );
  return map;
}

const COLS: { key: ProjectSortKey; label: string; right: boolean }[] = [
  { key: "name", label: "Loyiha", right: false },
  { key: "machine", label: "Mashina", right: false },
  { key: "today", label: "Bugun", right: true },
  { key: "all", label: "Jami", right: true },
  { key: "req", label: "So'rov (bugun)", right: true },
  { key: "open", label: "Ochiq sessiya", right: true },
  { key: "last", label: "Oxirgi", right: true },
];

/** Jadvalga qo'shimcha (saralanmaydigan) ustun. */
const PLAN_COL = "Reja";

/** 6.16: arxivlangan loyihalar (faqat "Arxivlanganlar" ko'rinishi ochiq bo'lganda o'qiladi). */
function useArchivedProjects(enabled: boolean) {
  const [items, setItems] = useState<ProjectDto[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [rev, setRev] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const ctl = new AbortController();
    getJson("/projects?archived=1&limit=500", ListProjectsResponseSchema, ctl.signal)
      .then((r) => {
        setItems(r.items);
        setErr(null);
      })
      .catch((e: unknown) => {
        if (!ctl.signal.aborted) setErr(e instanceof Error ? e.message : "Arxivni o'qib bo'lmadi");
      });
    return () => ctl.abort();
  }, [enabled, rev]);
  return { items, err, reload: useCallback(() => setRev((n) => n + 1), []) };
}

export function ProjectsView() {
  const { projects, machines, sessions, error } = useLiveData();
  const now = useNow();
  const [sort, setSort] = useState<{ key: ProjectSortKey; dir: 1 | -1 }>({ key: "today", dir: -1 });
  const [q, setQ] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const archived = useArchivedProjects(showArchived);
  const archiver = useArchiveProject(archived.reload);
  const archivedCount = projects?.archived.count ?? 0;
  const source = showArchived ? archived.items : (projects?.items ?? []);

  const names = useMemo(() => machineNameMap(machines), [machines]);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const items = withLastActivity(source, sessions).filter((p) => !needle || `${p.name} ${p.path}`.toLowerCase().includes(needle));
    return sortProjects(items, sort.key, sort.dir, (p) => names.get(p.machineId) ?? "");
  }, [source, sessions, q, sort, names]);

  const summaries = useTaskSummaries(useMemo(() => source.map((p) => p.id), [source]));
  const machineCount = new Set(source.map((p) => p.machineId)).size;

  return (
    <>
      <PageHeader title={showArchived ? "Arxivlangan loyihalar" : "Loyihalar"} count={projects ? `${showArchived ? archived.items.length : projects.items.length} ta · ${machineCount} mashinada` : undefined}>
        {projects && showArchivedToggle(archivedCount, showArchived) && (
          <button type="button" className="btn" data-testid="archived-toggle" aria-pressed={showArchived} onClick={() => setShowArchived((v) => !v)}>
            {archivedToggleLabel(archivedCount, showArchived)}
          </button>
        )}
        <SearchBox value={q} onChange={setQ} placeholder="Loyiha qidirish" label="Loyiha qidirish" width={240} showHint />
        <LivePill />
      </PageHeader>
      <div className="flex flex-col gap-3 px-4 py-5 md:px-6">
        <ApiErrorBar error={error ?? archived.err ?? archiver.error} />
        {showArchived && (
          <span className="text-xs text-mu" data-testid="archived-hint">
            Arxivlangan loyihalar ro&apos;yxatlardan yashirilgan; tarix va tokenlar saqlanadi. &quot;Qaytarish&quot; bilan faol ro&apos;yxatga chiqariladi.
          </span>
        )}
        {rows.length === 0 ? (
          <EmptyState title={source.length > 0 ? "Mos loyiha topilmadi" : showArchived ? "Arxivlangan loyiha yo'q" : "Loyiha yo'q"}>
            {source.length > 0 ? "Qidiruvni o'zgartiring." : showArchived ? "Loyihani arxivlash uchun jadvaldagi \"Arxivlash\" tugmasidan foydalaning." : "Claude Code sessiyasi boshlanganda loyihalar shu yerda paydo bo'ladi."}
          </EmptyState>
        ) : (
          <div className="card overflow-x-auto">
            <table className="dtable">
              <thead>
                <tr>
                  {COLS.map((c) => {
                    const on = sort.key === c.key;
                    return (
                      <th key={c.key} scope="col" className={`sortable ${c.right ? "r" : ""}`} aria-sort={on ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
                        <button type="button" className={on ? "on" : ""} onClick={() => setSort({ key: c.key, dir: on ? (sort.dir === 1 ? -1 : 1) : c.key === "name" || c.key === "machine" ? 1 : -1 })}>
                          {c.label} <span aria-hidden="true">{on ? (sort.dir < 0 ? "↓" : "↑") : ""}</span>
                        </button>
                      </th>
                    );
                  })}
                  <th scope="col" className="r">
                    {PLAN_COL}
                  </th>
                  <th scope="col" className="r">
                    <span className="sr-only">Amallar</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const href = `/projects/${p.id}`;
                  return (
                    <tr key={p.id} data-testid="project-row">
                      <td>
                        <Link href={href} className="cell">
                          <span className="font-semibold">{p.name}</span>
                          <span className="pill mono ml-1.5 bg-s3 text-mu" style={{ height: 18, fontSize: 10 }}>
                            {p.kind}
                          </span>
                        </Link>
                      </td>
                      <td>
                        <Link href={href} className="cell mono text-mu" tabIndex={-1} aria-hidden="true">
                          {names.get(p.machineId) ?? "?"}
                        </Link>
                      </td>
                      <td className="r">
                        <Link href={href} className="cell mono" tabIndex={-1} aria-hidden="true" title={`${formatCount(p.today.totalTokens)} token`}>
                          {formatTokensOrDash(p.today.totalTokens)}
                        </Link>
                      </td>
                      <td className="r">
                        <Link href={href} className="cell mono text-mu" tabIndex={-1} aria-hidden="true" title={`${formatCount(p.allTime.totalTokens)} token`}>
                          {formatTokensOrDash(p.allTime.totalTokens)}
                        </Link>
                      </td>
                      <td className="r">
                        <Link href={href} className="cell mono text-mu" tabIndex={-1} aria-hidden="true">
                          {p.today.requests || "—"}
                        </Link>
                      </td>
                      <td className="r">
                        <Link href={href} className="cell" tabIndex={-1} aria-hidden="true">
                          <span className={`pill ${p.openSessions ? "bg-blue-bg text-blue" : "text-mu"}`} style={{ height: 20 }}>
                            {p.openSessions}
                          </span>
                        </Link>
                      </td>
                      <td className="r">
                        <Link href={href} className="cell mono text-mu" tabIndex={-1} aria-hidden="true">
                          <span suppressHydrationWarning>{now ? formatLastUsed(p.lastUsedAt, now) : "…"}</span>
                        </Link>
                      </td>
                      <td className="r">
                        <Link href={href} className="cell mono text-mu" tabIndex={-1} aria-hidden="true" data-testid="plan-cell">
                          <PlanCell summary={summaries[p.id]} />
                        </Link>
                      </td>
                      <td className="r" style={{ padding: "0 14px", whiteSpace: "nowrap" }}>
                        {!showArchived && <OpenSessionIconButton machineId={p.machineId} cwd={p.path} name={p.name} />}
                        <button
                          type="button"
                          className="btn ml-1.5 h-7 px-2 text-xs"
                          data-testid={showArchived ? "unarchive-btn" : "archive-btn"}
                          disabled={!archiver.canControl || archiver.busyId === p.id}
                          title={archiver.canControl ? (showArchived ? `${p.name}: faol ro'yxatga qaytarish` : `${p.name}: ${ARCHIVE_HINT}`) : "COMMANDER_CONTROL_TOKEN sozlanmagan: dashboard boshqaruvi o'chiq"}
                          aria-label={`${p.name}: ${showArchived ? "qaytarish" : "arxivlash"}`}
                          onClick={() => void archiver.run(p.id, !showArchived)}
                        >
                          {showArchived ? "Qaytarish" : "Arxivlash"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {projects && projects.unattributed.allTime.totalTokens > 0 && (
          <span className="text-xs text-mu">
            Loyihasiz (cwd noma&apos;lum): bugun {formatTokens(projects.unattributed.today.totalTokens)}, jami {formatTokens(projects.unattributed.allTime.totalTokens)}.
          </span>
        )}
      </div>
    </>
  );
}

/** Reja progressi: "22/45" + ingichka chiziq (reja bo'lmasa "—"). */
function PlanCell({ summary }: { summary: TasksSummary | null | undefined }) {
  if (!summary) return <>—</>;
  const pct = summary.total ? (summary.done / summary.total) * 100 : 0;
  return (
    <span className="inline-flex items-center gap-2" title={`${summary.done} bajarildi, ${summary.doing} jarayonda, ${summary.todo} qoldi`}>
      <span className="h-1.5 w-14 overflow-hidden rounded bg-s3">
        <span className="block h-1.5 bg-grn" style={{ width: `${pct}%` }} />
      </span>
      {summary.done}/{summary.total}
    </span>
  );
}
