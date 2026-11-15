"use client";

import { ProjectPartsResponseSchema, ProjectTasksResponseSchema } from "@commander/contracts";
import type { ProjectDto, ProjectPartsResponse, ProjectTaskDto, ProjectTasksResponse, SessionDto, TaskBoardColumn } from "@commander/contracts";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CommandProgress } from "@/components/control/CommandProgress";
import { useOpenSession } from "@/components/control/OpenSessionButton";
import { useCommandRunner, useTrackedCommand } from "@/components/control/useControl";
import { useLiveData } from "@/components/LiveData";
import { useShellUi } from "@/components/shell/ShellUi";
import { IconBack } from "@/components/ui/icons";
import { LivePill } from "@/components/ui/PageHeader";
import { getJson } from "@/lib/client-api";
import { machineLabel } from "@/lib/machines";
import { upsertById } from "@/lib/push";
import { sortSessionList } from "@/lib/session-list";
import { useLiveSync } from "@/lib/use-live-sync";
import { findProjectGroup } from "@/lib/messaging-view";
import { applyPending, boardKpis, rollbackPending, taskPrompt, workWriteReason } from "@/lib/work-view";
import { BoardTab } from "./BoardTab";
import { DailyTab } from "./DailyTab";
import { PartSummary, PartTabs } from "./PartsPanel";
import { ALL_PARTS, combinePartsDto, partCwd, partTabs, tasksForPart, workTotalsText } from "@/lib/parts-view";
import { MdImportDialog } from "./MdImportDialog";
import { QueueFormDialog } from "@/components/queue/QueueFormDialog";
import { useQueue } from "@/components/queue/useQueue";
import { MessagingPanel } from "./MessagingPanel";
import { OrchestrationPanel } from "@/components/orchestration/OrchestrationPanel";
import type { OrchPrefill } from "@/components/orchestration/OrchestrationPanel";
import { useMessagingGroups } from "./useMessaging";
import { ApprovalRulesPanel } from "@/components/rules/ApprovalRulesPanel";
import { SessionsPanel } from "./SessionsPanel";
import { useProjectGit } from "@/components/git/useGit";
import { commitsByTask, taskGitInfo } from "@/lib/git-view";
import { useWorkApi } from "./useWorkApi";

type Tab = "board" | "day" | "link" | "orch";
const TABS: { id: Tab; label: string }[] = [
  { id: "board", label: "Vazifalar doskasi" },
  { id: "day", label: "Kunlik ko'rinish" },
  { id: "link", label: "Sessiyalar aloqasi" },
  { id: "orch", label: "Orkestratsiya" },
];

export function WorkView({ project, machineName, initialTasks, initialSessions, initialPart }: { project: ProjectDto; machineName: string; initialTasks: ProjectTasksResponse | null; initialSessions: SessionDto[]; initialPart?: string }) {
  const { machines, sessions: liveSessions, lockdown, canControl } = useLiveData();
  const { openNewSession } = useShellUi();
  const queueApi = useQueue();
  const [queueTask, setQueueTask] = useState<ProjectTaskDto | null>(null);
  const [orchPrefill, setOrchPrefill] = useState<OrchPrefill | null>(null);
  const id = project.id;
  const [tasks, setTasks] = useState(initialTasks);
  const [pending, setPending] = useState<Record<string, TaskBoardColumn>>({});
  const [boardError, setBoardError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("board");
  const [mdOpen, setMdOpen] = useState(false);
  const [actionCmd, setActionCmd] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [dailyKey, setDailyKey] = useState(0);
  // 6.15: loyiha qismlari (monorepo papkalari); tanlangan qism '' = asosiy
  const [parts, setParts] = useState<ProjectPartsResponse | null>(null);
  const [part, setPart] = useState(initialPart ?? ALL_PARTS);
  const cmd = useTrackedCommand(actionCmd);
  const api = useWorkApi(id);
  // 3.5: vazifaga bog'langan commitlar va PR'lar (kartada)
  const { git: projectGit } = useProjectGit(id);
  const gitByTask = useMemo(() => {
    const byTask = commitsByTask(projectGit?.taskCommits ?? []);
    const prs = projectGit?.prs ?? [];
    return (key: string) => taskGitInfo(key, byTask, prs);
  }, [projectGit]);
  const runner = useCommandRunner();
  const openNew = useOpenSession(project.machineId);
  const messaging = useMessagingGroups();
  const unread = messaging.data ? (findProjectGroup(messaging.data.groups, project)?.unread ?? 0) : 0;
  const tickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const moving = useRef(new Set<string>());

  const machine = machines.find((m) => m.id === project.machineId);
  const agentReason = workWriteReason("agent", { lockdown, canControl, machine });
  const boardReason = workWriteReason("board", { lockdown, canControl, machine });
  const attachReason = workWriteReason("board", { lockdown, canControl, machine });

  const fetchTasks = useCallback((signal?: AbortSignal) => getJson(`/projects/${id}/tasks`, ProjectTasksResponseSchema, signal), [id]);
  useLiveSync<ProjectTasksResponse>({
    fetchSnapshot: (signal) => fetchTasks(signal),
    onSnapshot: setTasks,
    onError: () => undefined,
    onPush: (e) => {
      if (e.type === "project.updated" && e.project.id === id) {
        fetchTasks()
          .then(setTasks)
          .catch(() => undefined);
        setDailyKey((k) => k + 1);
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
  // Qismlar: mount, loyiha yangilanishi (push) va yangilash buyrug'i yakunlanganda
  useEffect(() => {
    const ctl = new AbortController();
    getJson(`/projects/${id}/parts`, ProjectPartsResponseSchema, ctl.signal)
      .then(setParts)
      .catch(() => undefined);
    return () => ctl.abort();
  }, [id, dailyKey, cmd?.status]);
  // Yangilash buyrug'i yakunlangach vazifalarni qayta o'qiymiz
  useEffect(() => {
    if (cmd?.status === "done") {
      fetchTasks()
        .then(setTasks)
        .catch(() => undefined);
    }
  }, [cmd?.status, fetchTasks]);

  const sessions = useMemo(() => {
    let list = initialSessions;
    for (const s of liveSessions) if (s.projectId === id) list = upsertById(list, s);
    return sortSessionList(list.filter((s) => s.endedAt === null));
  }, [initialSessions, liveSessions, id]);

  // 6.14: tugagan terminal sessiyalar, "Davom ettirish" mumkin bo'lganlari (eng yangi 5 ta)
  const resumable = useMemo(() => {
    let list = initialSessions;
    for (const s of liveSessions) if (s.projectId === id) list = upsertById(list, s);
    return sortSessionList(list.filter((s) => s.endedAt !== null && s.resume?.available === true)).slice(0, 5);
  }, [initialSessions, liveSessions, id]);

  const tabs = useMemo(() => partTabs(parts?.parts ?? []), [parts]);
  const hasParts = tabs.length > 0;
  const activePart = hasParts && tabs.some((t) => t.id === part) ? part : (tabs[0]?.id ?? "");
  const partDto = useMemo(() => (activePart === ALL_PARTS ? (parts ? combinePartsDto(parts.parts) : null) : (parts?.parts.find((p) => p.part === activePart) ?? null)), [parts, activePart]);
  const partTasks = useMemo(() => (hasParts ? tasksForPart(tasks?.tasks ?? [], activePart) : (tasks?.tasks ?? [])), [tasks, hasParts, activePart]);
  const shown = useMemo(() => applyPending(partTasks, pending), [partTasks, pending]);
  const activeByTask = useMemo(() => {
    const m = new Map<string, SessionDto>();
    for (const s of sessions) if (s.taskKey && !m.has(s.taskKey)) m.set(s.taskKey, s);
    return m;
  }, [sessions]);
  const attachable = sessions.filter((s) => s.controls.prompt);
  const kpis = useMemo(() => boardKpis(shown), [shown]);

  async function move(key: string, to: TaskBoardColumn) {
    if (moving.current.has(key)) return;
    moving.current.add(key);
    setBoardError(null);
    setPending((p) => ({ ...p, [key]: to }));
    try {
      const r = await api.moveTask(key, to);
      setTasks((t) => (t ? { ...t, tasks: t.tasks.map((x) => (x.key === key ? { ...x, column: r.column, columnSource: r.columnSource } : x)) } : t));
      setPending((p) => rollbackPending(p, key));
      if (!r.changed) setBoardError("Karta ko'chirilmadi: TASKS.md'da bajarilgan vazifa qulflangan");
    } catch (e) {
      setPending((p) => rollbackPending(p, key));
      setBoardError(e instanceof Error ? e.message : "Xatolik");
    } finally {
      moving.current.delete(key);
    }
  }

  async function attach(t: ProjectTaskDto, s: SessionDto) {
    setActionError(null);
    const c = await runner.submit({ type: "session.prompt", sessionId: s.id, text: taskPrompt(t.key, t.title) });
    if (c) setActionCmd(c.id);
    else setActionError(runner.error);
  }

  async function refresh() {
    setActionError(null);
    try {
      const c = await api.refresh();
      setActionCmd(c.id);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Xatolik");
    }
  }

  const totalsText = workTotalsText(hasParts ? (parts?.parts ?? []) : [], tasks?.tasksMd ? tasks.tasksMd.path : null, tasks?.summary.total ?? 0);

  return (
    <>
      <header className="flex flex-wrap items-center gap-3 px-4 pb-2.5 pt-3.5 md:px-6">
        <Link href={`/projects/${id}`} aria-label="Loyiha sahifasiga qaytish" className="flex text-mu">
          <IconBack size={18} />
        </Link>
        <div className="flex min-w-0 flex-[1_1_auto] flex-col gap-0.5">
          <h1 className="m-0 text-lg font-semibold">{project.name}</h1>
          <span className="mono text-xs text-mu">
            {machine ? machineLabel(machine) : machineName} · {sessions.length} ta faol sessiya · {totalsText}
          </span>
        </div>
        <LivePill />
        <button type="button" className="btn" disabled={!!agentReason || api.busy} title={agentReason ?? undefined} onClick={() => void refresh()}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
            <path d="M13.5 8A5.5 5.5 0 113 5M3 2v3h3" />
          </svg>
          TASKS.md&apos;dan yangilash
        </button>
        <button type="button" className="btn btn-pri" disabled={!!agentReason} title={agentReason ?? undefined} onClick={() => setMdOpen(true)}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M8 3v10M3 8h10" />
          </svg>
          .md fayldan vazifalar
        </button>
      </header>
      {agentReason && (
        <p className="m-0 px-4 text-right text-[11px] text-org md:px-6" data-testid="agent-reason">
          {agentReason}
        </p>
      )}

      <div className="flex flex-col gap-4 px-4 pb-6 pt-3 md:px-6">
        {(cmd || actionError) && (
          <div className="flex flex-col gap-1">
            {cmd && <CommandProgress command={cmd} />}
            {actionError && (
              <div role="alert" className="rounded-lg bg-red-bg px-3 py-2 text-xs text-red">
                {actionError}
              </div>
            )}
          </div>
        )}

        <SessionsPanel sessions={sessions} resumable={resumable} machineId={project.machineId} cwd={project.path} />

        {hasParts && <PartTabs tabs={tabs} active={activePart} onSelect={setPart} />}
        {hasParts && partDto && <PartSummary part={partDto} />}

        <div className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-3">
          <Kpi l="Bajarildi" v={`${kpis.done} / ${kpis.total}`} s={kpis.total ? `${Math.round((kpis.done / kpis.total) * 100)}%` : "—"} />
          <Kpi l="Jarayonda" v={String(kpis.doing)} s="faol vazifalar" color="var(--blue)" />
          <Kpi l="Tekshiruvda" v={String(kpis.review)} s="doskada" color="var(--yel)" />
          <Kpi l="O'rtacha baho" v={kpis.avgScore === null ? "—" : kpis.avgScore.toFixed(1)} s="Claude bahosi" color={kpis.avgScore === null ? undefined : "var(--yel)"} />
          <Kpi l="Reja aniqligi" v={kpis.accuracy === null ? "—" : `${Math.round(kpis.accuracy * 100)}%`} s="reja va haqiqiy vaqt" />
        </div>

        <div className="flex border-b border-bd" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className="h-[38px] border-0 border-b-2 bg-transparent px-1 text-[13px] font-semibold"
              style={{ marginRight: 18, cursor: "pointer", color: tab === t.id ? "var(--tx)" : "var(--mu)", borderBottomColor: tab === t.id ? "var(--blue)" : "transparent", font: "600 13px var(--font-sans)" }}
            >
              {t.label}
              {t.id === "link" && unread > 0 && (
                <span className="pill ml-1.5 bg-org text-white" style={{ height: 18, padding: "0 6px", fontSize: 11 }} data-testid="tab-unread" aria-label={`${unread} ta o'qilmagan xabar`}>
                  {unread}
                </span>
              )}
            </button>
          ))}
        </div>

        {tab === "board" &&
          (shown.length === 0 ? (
            <div className="card p-6 text-mu">Loyihada vazifalar jadvali (TASKS.md) topilmadi yoki bo&apos;sh. &quot;.md fayldan vazifalar&quot; orqali yarating.</div>
          ) : (
            <BoardTab
              tasks={shown}
              gitByTask={gitByTask}
              activeByTask={activeByTask}
              attachable={attachable}
              writeReason={boardReason}
              attachReason={attachReason}
              newReason={openNew.reason}
              error={boardError}
              showPart={hasParts && activePart === ALL_PARTS}
              onMove={(k, to) => void move(k, to)}
              onAttach={(t, s) => void attach(t, s)}
              onNewSession={(t) => openNewSession({ machineId: project.machineId, cwd: partCwd(project.path, activePart), prompt: taskPrompt(t.key, t.title) })}
              onQueue={(t) => setQueueTask(t)}
              onOrchestrate={(t) => {
                setOrchPrefill({ goal: `${t.title}\n\n(${taskPrompt(t.key, t.title)})`, taskKey: t.key });
                setTab("orch");
              }}
            />
          ))}
        {tab === "day" && <DailyTab key={hasParts && activePart !== ALL_PARTS ? activePart : "__all"} projectId={id} writeReason={agentReason} refreshKey={dailyKey} {...(hasParts && activePart !== ALL_PARTS ? { part: activePart } : {})} />}
        {tab === "link" && <MessagingPanel project={project} groups={messaging.data} onReload={messaging.reload} />}
        {tab === "orch" && <OrchestrationPanel project={project} sessions={sessions} prefill={orchPrefill} onPrefillUsed={() => setOrchPrefill(null)} />}

        <div className="card p-4">
          <ApprovalRulesPanel title="Avto-ruxsat qoidalari · loyiha" scope="project" scopeRef={project.id} collapsible />
        </div>
      </div>

      {queueTask && (
        <QueueFormDialog
          api={queueApi}
          prefill={{ machineId: project.machineId, cwd: project.path, prompt: taskPrompt(queueTask.key, queueTask.title), projectId: id, taskKey: queueTask.key }}
          onClose={() => setQueueTask(null)}
        />
      )}

      {mdOpen && (
        <MdImportDialog
          projectId={id}
          tasks={tasksForPart(tasks?.tasks ?? [], "")}
          writeReason={agentReason}
          onClose={() => setMdOpen(false)}
          onDone={() => {
            setMdOpen(false);
            fetchTasks()
              .then(setTasks)
              .catch(() => undefined);
          }}
          onRefresh={() => void refresh()}
        />
      )}
    </>
  );
}

function Kpi({ l, v, s, color }: { l: string; v: string; s: string; color?: string }) {
  return (
    <div className="card flex flex-col gap-1 px-3.5 py-3">
      <span className="lbl">{l}</span>
      <span className="mono text-xl font-semibold" style={{ color }}>
        {v}
      </span>
      <span className="text-xs text-mu">{s}</span>
    </div>
  );
}

