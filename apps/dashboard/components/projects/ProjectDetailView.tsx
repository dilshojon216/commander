"use client";

import { ProjectDetailDtoSchema, ProjectPartsResponseSchema, ProjectTasksResponseSchema, UsageResponseSchema } from "@commander/contracts";
import type { ProjectDetailDto, ProjectPartsResponse, ProjectTasksResponse, SessionDto, UsageResponse } from "@commander/contracts";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BudgetCard } from "@/components/budgets/BudgetBar";
import { BarChart } from "@/components/charts/BarChart";
import { CommitList } from "@/components/CommitList";
import { useLiveData } from "@/components/LiveData";
import { MarkdownView } from "@/components/MarkdownView";
import { OpenSessionButton } from "@/components/control/OpenSessionButton";
import { ResumeButton } from "@/components/control/ResumeButton";
import { SessionQuickActions } from "@/components/control/SessionQuickActions";
import { TaskPill } from "@/components/TaskPill";
import { useMessagingGroups } from "@/components/work/useMessaging";
import { findProjectGroup } from "@/lib/messaging-view";
import { IconBack } from "@/components/ui/icons";
import { LivePill } from "@/components/ui/PageHeader";
import { StatusPill } from "@/components/ui/StatusPill";
import { shortenPath } from "@/lib/chat-format";
import { dailyValues } from "@/lib/chart-data";
import { findBudget, projectBudgetKey } from "@/lib/budgets-view";
import { getJson } from "@/lib/client-api";
import { useBudgets } from "@/lib/use-budgets";
import { ARCHIVE_HINT, archiveActionLabel } from "@/lib/projects-view";
import { useArchiveProject } from "./useArchiveProject";
import { formatCompact, formatCost, formatCount, formatDayLabel, formatLastUsed, formatRelative, formatTokens } from "@/lib/format";
import { shortMachineName } from "@/lib/machines";
import { upsertById } from "@/lib/push";
import { sortSessionList } from "@/lib/session-list";
import { displayStatus } from "@/lib/status";
import { buildTasksView } from "@/lib/tasks-view";
import { useLiveSync } from "@/lib/use-live-sync";
import { useNow } from "@/lib/use-now";
import { PartsProgressCard } from "./PartsProgressCard";
import { TasksSection } from "./TasksSection";
import { partsTotals } from "@/lib/parts-view";
import { GitSection } from "@/components/git/GitSection";
import { DecisionsSection } from "@/components/intelligence/DecisionsSection";
import { CheckpointsSection } from "@/components/checkpoints/CheckpointsSection";
import { DeploySection } from "@/components/deploy/DeploySection";
import { useProjectGit } from "@/components/git/useGit";

interface Props {
  initialDetail: ProjectDetailDto;
  initialTasks: ProjectTasksResponse | null;
  machineName: string;
  initialSessions: SessionDto[];
  sessionsError: string | null;
}

interface Snapshot {
  detail: ProjectDetailDto;
  tasks: ProjectTasksResponse | null;
}

export function ProjectDetailView({ initialDetail, initialTasks, machineName, initialSessions, sessionsError }: Props) {
  const { projects, sessions: liveSessions } = useLiveData();
  const now = useNow();
  const id = initialDetail.project.id;
  const [detail, setDetail] = useState(initialDetail);
  const [tasks, setTasks] = useState(initialTasks);
  const tickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 6.15: qismlar (monorepo). Ko'p qismli loyihada ildiz TASKS.md/TODOS.md yo'q: ularning o'rniga qismlar progressi ko'rsatiladi.
  const [parts, setParts] = useState<ProjectPartsResponse | null>(null);
  const [partsRev, setPartsRev] = useState(0);
  const [tab, setTab] = useState<"overview" | "decisions" | "deploy" | "checkpoints">("overview");

  const fetchTasks = useCallback((signal?: AbortSignal) => getJson(`/projects/${id}/tasks`, ProjectTasksResponseSchema, signal), [id]);
  const fetchSnapshot = useCallback(
    async (signal: AbortSignal): Promise<Snapshot> => {
      const [d, t] = await Promise.all([getJson(`/projects/${id}`, ProjectDetailDtoSchema, signal), fetchTasks(signal).catch(() => null)]);
      return { detail: d, tasks: t };
    },
    [id, fetchTasks],
  );

  // Jonli: project.updated (snapshot o'zgardi) -> qayta o'qish; usage.tick (shu loyiha) -> vazifa statistikasini 8 s da bir marta yangilash
  useLiveSync<Snapshot>({
    fetchSnapshot,
    onSnapshot: (d) => {
      setDetail(d.detail);
      setTasks(d.tasks);
    },
    onError: () => undefined,
    onPush: (e) => {
      if (e.type === "project.updated" && e.project.id === id) {
        setPartsRev((r) => r + 1);
        fetchSnapshot(new AbortController().signal)
          .then((d) => {
            setDetail(d.detail);
            setTasks(d.tasks);
          })
          .catch(() => undefined);
      } else if (e.type === "usage.tick" && e.tick.byProject.some((b) => b.projectId === id) && !tickTimer.current) {
        tickTimer.current = setTimeout(() => {
          tickTimer.current = null;
          fetchTasks()
            .then(setTasks)
            .catch(() => undefined);
        }, 8000);
      }
    },
  });
  useEffect(
    () => () => {
      if (tickTimer.current) clearTimeout(tickTimer.current);
    },
    [],
  );

  useEffect(() => {
    const ctl = new AbortController();
    getJson(`/projects/${id}/parts`, ProjectPartsResponseSchema, ctl.signal)
      .then(setParts)
      .catch(() => undefined);
    return () => ctl.abort();
  }, [id, partsRev]);
  const partsTotal = useMemo(() => (parts ? partsTotals(parts.parts) : null), [parts]);
  const multiPart = partsTotal !== null && partsTotal.partCount > 0;

  const project = projects?.items.find((p) => p.id === id) ?? detail.project;
  // 6.16: arxivlangan loyiha faol ro'yxatda yo'q (detail baribir ishlaydi); holat amaldan keyin darrov yangilanadi
  const [archivedAt, setArchivedAt] = useState<string | null>(detail.project.archivedAt);
  const archiver = useArchiveProject();
  const toggleArchive = async () => {
    const archive = archivedAt === null;
    if (await archiver.run(id, archive)) setArchivedAt(archive ? new Date().toISOString() : null);
  };
  const budgets = useBudgets().data;
  const projectBudgets = budgets ? [findBudget(budgets.items, "project", projectBudgetKey(project)), findBudget(budgets.items, "machine", project.machineId)].filter((b): b is NonNullable<typeof b> => b !== null) : [];
  const messaging = useMessagingGroups();
  const unread = messaging.data ? (findProjectGroup(messaging.data.groups, project)?.unread ?? 0) : 0;

  const sessions = useMemo(() => {
    let list = initialSessions;
    for (const s of liveSessions) if (s.projectId === project.id) list = upsertById(list, s);
    return sortSessionList(list).slice(0, 50);
  }, [initialSessions, liveSessions, project.id]);

  const [chart, setChart] = useState<UsageResponse | null>(null);
  const [chartError, setChartError] = useState<string | null>(null);
  useEffect(() => {
    const ctl = new AbortController();
    const to = Date.now();
    const qs = new URLSearchParams({ bucket: "1d", groupBy: "none", project: project.id, from: new Date(to - 30 * 86_400_000).toISOString(), to: new Date(to).toISOString() });
    getJson(`/usage?${qs}`, UsageResponseSchema, ctl.signal)
      .then((r) => {
        setChart(r);
        setChartError(null);
      })
      .catch((e: unknown) => {
        if (!ctl.signal.aborted) setChartError(e instanceof Error ? e.message : "Xatolik");
      });
    return () => ctl.abort();
  }, [project.id]);

  const daily = useMemo(() => (chart ? dailyValues(chart) : null), [chart]);
  const total30 = chart?.series[0]?.total ?? null;
  const tasksView = useMemo(() => (tasks ? buildTasksView(tasks, now) : null), [tasks, now]);
  const git = detail.git;
  const { git: gitState } = useProjectGit(id);
  const lastCommit = detail.commits[0] ?? null;

  const kpis: { l: string; v: string; s: string }[] = [
    { l: "Bugun", v: formatTokens(project.today.totalTokens), s: `${formatCount(project.today.requests)} so'rov${project.today.costUsd === null ? "" : ` · ≈ ${formatCost(project.today.costUsd)}`}` },
    { l: "30 kun", v: total30 ? formatTokens(total30.totalTokens) : "…", s: total30 ? `${formatCount(total30.requests)} so'rov` : chartError ? "olinmadi" : "yuklanmoqda" },
    { l: "Jami", v: formatTokens(project.allTime.totalTokens), s: `${formatCount(project.allTime.requests)} so'rov` },
    { l: "Ochiq sessiya", v: String(project.openSessions), s: machineName },
    multiPart && partsTotal.total > 0
      ? { l: "Reja", v: `${partsTotal.pct ?? 0}%`, s: `${partsTotal.done} / ${partsTotal.total} vazifa · ${partsTotal.partCount} qism` }
      : tasksView && tasksView.total > 0
      ? { l: "Reja", v: `${Math.round(tasksView.donePct)}%`, s: `${tasksView.done} / ${tasksView.total} vazifa` }
      : lastCommit
        ? { l: "Oxirgi commit", v: lastCommit.sha.slice(0, 7), s: now ? formatRelative(Date.parse(lastCommit.ts) / 1000, now) : "…" }
        : { l: "Oxirgi faollik", v: now ? formatLastUsed(project.lastUsedAt, now) : "…", s: "token sarfi bo'yicha" },
  ];

  const xLabels = daily ? [0, 0.25, 0.5, 0.75, 1].map((f, i, arr) => (i === arr.length - 1 ? "Bugun" : formatDayLabel(daily.times[Math.round(f * (daily.times.length - 1))] ?? 0))) : [];
  const peak = daily ? Math.max(0, ...daily.values) : 0;

  return (
    <>
      <header className="flex flex-wrap items-center gap-3 border-b border-bd px-4 py-3.5 md:px-6">
        <Link href="/projects" aria-label="Loyihalarga qaytish" className="flex text-mu">
          <IconBack size={18} />
        </Link>
        <div className="flex min-w-0 flex-[1_1_auto] flex-col gap-0.5">
          <h1 className="m-0 text-lg font-semibold">
            {project.name}{" "}
            <span className="pill mono bg-s3 align-middle text-mu" style={{ height: 18, fontSize: 10 }}>
              {project.kind}
            </span>
            {archivedAt && (
              <span className="pill ml-1.5 bg-s3 align-middle text-mu" style={{ height: 18, fontSize: 10 }}>
                arxiv
              </span>
            )}
          </h1>
          <span className="mono break-all text-xs text-mu">
            {machineName} · {shortenPath(project.path)}
            {git?.branch ? ` · ${git.branch}` : ""}
            {git?.headSha ? ` · ${git.headSha.slice(0, 7)}` : ""}
            {git?.dirty ? ` · o'zgarishlar bor${git.dirtyCount ? ` (${git.dirtyCount})` : ""}` : ""}
            {project.repoKey ? ` · ${project.repoKey}` : ""}
          </span>
        </div>
        <LivePill />
        <Link href={`/projects/${id}/work`} className="btn" data-testid="work-link">
          Ish maydoni →
          {unread > 0 && (
            <span className="pill bg-org text-white" style={{ height: 18, padding: "0 6px", fontSize: 11 }} data-testid="header-unread" aria-label={`${unread} ta o'qilmagan xabar`}>
              {unread}
            </span>
          )}
        </Link>
        <button
          type="button"
          className="btn"
          data-testid="archive-toggle"
          disabled={!archiver.canControl || archiver.busyId === id}
          title={archiver.canControl ? ARCHIVE_HINT : "COMMANDER_CONTROL_TOKEN sozlanmagan: dashboard boshqaruvi o'chiq"}
          onClick={() => void toggleArchive()}
        >
          {archiveActionLabel(archivedAt)}
        </button>
        <OpenSessionButton machineId={project.machineId} cwd={project.path} />
      </header>
      {archiver.error && (
        <div role="alert" className="border-b border-bd px-4 py-2 text-xs text-red md:px-6" data-testid="archive-error">
          {archiver.error}
        </div>
      )}
      {archivedAt && (
        <div className="border-b border-bd bg-s2 px-4 py-2 text-xs text-mu md:px-6" data-testid="archived-banner">
          Bu loyiha arxivlangan: ro&apos;yxatlarda ko&apos;rinmaydi. Tarix saqlangan; shu loyihada yangi sessiya boshlansa o&apos;zi qaytadi.
        </div>
      )}

      <div role="tablist" aria-label="Loyiha ko'rinishi" className="flex gap-1 border-b border-bd px-4 pt-2 md:px-6">
        {(["overview", "decisions", "deploy", "checkpoints"] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`rounded-t-md border-0 px-3 py-1.5 text-xs font-semibold ${tab === t ? "bg-s3 text-tx" : "bg-transparent text-mu"}`} style={{ cursor: "pointer", font: "inherit", fontWeight: 600 }} data-testid={`project-tab-${t}`}>
            {t === "overview" ? "Umumiy" : t === "decisions" ? "Qarorlar" : t === "deploy" ? "Deploy" : "Checkpointlar"}
          </button>
        ))}
      </div>
      {tab === "decisions" && <DecisionsSection projectId={id} />}
      {tab === "deploy" && <DeploySection projectId={id} />}
      {tab === "checkpoints" && <CheckpointsSection projectId={id} />}

      <div className={`flex flex-col gap-5 px-4 py-5 md:px-6 ${tab !== "overview" ? "hidden" : ""}`}>
        {budgets && projectBudgets.length > 0 ? <BudgetCard title="Kunlik byudjet" items={projectBudgets} resetsAt={budgets.resetsAt} now={now} /> : null}
        <div className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-3">
          {kpis.map((k) => (
            <div key={k.l} className="card flex flex-col gap-1 px-3.5 py-3">
              <span className="lbl">{k.l}</span>
              <span className="mono text-[22px] font-semibold">{k.v}</span>
              <span className="text-xs text-mu">{k.s}</span>
            </div>
          ))}
        </div>

        <section className="card flex flex-col gap-3 p-4" aria-label="Tokenlar 30 kun">
          <div className="flex items-center justify-between">
            <h2 className="m-0 text-sm font-semibold">Tokenlar · 30 kun</h2>
            <span className="text-xs text-mu">Ustun ustiga olib boring: kunlik qiymat</span>
          </div>
          {chartError ? (
            <span className="text-mu">{chartError}</span>
          ) : daily ? (
            <BarChart
              height={180}
              xLabels={xLabels}
              label={`Oxirgi 30 kun: jami ${formatTokens(daily.values.reduce((a, b) => a + b, 0))} token, eng ko'pi ${formatTokens(peak)}`}
              columns={daily.values.map((v, i) => ({
                title: `${formatDayLabel(daily.times[i])}: ${formatTokens(v)} token`,
                parts: [{ value: v, color: i === daily.values.length - 1 ? "var(--blue)" : "var(--blue-bg)" }],
              }))}
            />
          ) : (
            <div className="sk h-[180px]" aria-busy="true" />
          )}
        </section>

        {multiPart && parts ? (
          <PartsProgressCard projectId={id} parts={parts.parts} />
        ) : tasksView && detail.tasksMd && tasksView.total > 0 ? (
          <TasksSection view={tasksView} file={detail.tasksMd.path} />
        ) : (
          <section className="card flex flex-col gap-1.5 p-4" aria-label="Reja">
            <h2 className="m-0 text-sm font-semibold">
              Reja · <span className="mono font-medium">TASKS.md</span>
            </h2>
            <span className="text-mu">{detail.tasksMd ? "TASKS.md topildi, lekin undan vazifalar jadvali (# | Task | …) o'qib bo'lmadi." : "Loyihada docs/TASKS.md yoki TASKS.md topilmadi (yoki agentd hali yubormagan)."}</span>
          </section>
        )}

        <GitSection projectId={id} branch={git?.branch ?? null} git={gitState} />

        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,360px),1fr))] items-start gap-5">
          <section className="card overflow-hidden" aria-label="Sessiyalar">
            <div className="flex items-center justify-between px-4 py-3.5">
              <h2 className="m-0 text-sm font-semibold">Sessiyalar</h2>
              <Link href="/sessions" className="text-xs">
                Hammasi →
              </Link>
            </div>
            {sessions.length === 0 && <p className="m-0 border-t border-bd px-4 py-3 text-mu">{sessionsError ?? "Bu loyiha uchun sessiya yo'q."}</p>}
            {sessions.map((s) => (
              <div key={s.id}>
                <Link href={`/sessions/${s.id}`} className="flex items-center gap-2.5 border-t border-bd px-4 py-[9px] text-tx hover:bg-s2 hover:no-underline">
                  <StatusPill status={displayStatus(s)} />
                  <TaskPill session={s} />
                  <span className="mono min-w-0 flex-1 truncate text-mu">
                    {shortMachineName(s.machineName)} · {s.model ?? "model noma'lum"}
                  </span>
                  <span className="mono text-mu" suppressHydrationWarning>
                    {s.endedAt ? (now ? formatLastUsed(s.endedAt, now) : "…") : now ? formatCompact(now - Date.parse(s.statusSince)) : "…"}
                  </span>
                </Link>
                {s.endedAt === null && <SessionQuickActions session={s} />}
                {s.endedAt !== null && s.resume?.available === true && (
                  <div className="border-t border-bd bg-s2 px-4 py-2">
                    <ResumeButton session={s} />
                  </div>
                )}
              </div>
            ))}
          </section>

          <section className="card overflow-hidden" aria-label="Git commitlar">
            <div className="px-4 py-3.5">
              <h2 className="m-0 text-sm font-semibold">Git commitlar</h2>
            </div>
            <CommitList commits={detail.commits} />
          </section>
          {!multiPart && <MdCard title="TODOS.md" content={detail.todosMd} missing="TODOS.md yoki TODO.md topilmadi." />}
          <MdCard title="CHANGELOG.md" content={detail.changelogMd} missing="CHANGELOG.md topilmadi." />
        </div>
      </div>
    </>
  );
}

function MdCard({ title, content, missing }: { title: string; content: string | null; missing: string }) {
  return (
    <section className="card flex flex-col overflow-hidden" aria-label={title}>
      <h2 className="mono m-0 px-4 py-3.5 text-sm font-semibold">{title}</h2>
      {content ? (
        <div className="max-h-[360px] overflow-auto border-t border-bd">
          <MarkdownView content={content} />
        </div>
      ) : (
        <p className="m-0 border-t border-bd px-4 py-3 text-mu">{missing}</p>
      )}
    </section>
  );
}
