"use client";

import type { ProjectTaskDto, SessionDto, TaskBoardColumn } from "@commander/contracts";
import { displayKey, partLabel } from "@/lib/parts-view";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { BOARD_COLUMNS, LOCKED_REASON, canMove, cardView, groupByColumn } from "@/lib/work-view";
import type { CardView } from "@/lib/work-view";
import { TaskGit } from "@/components/git/TaskGit";
import type { TaskGitInfo } from "@/lib/git-view";

const RATIO_FG = { mu: "text-mu", grn: "text-grn", yel: "text-yel", red: "text-red" } as const;

export interface BoardProps {
  tasks: ProjectTaskDto[];
  /** 3.5: vazifa kaliti -> bog'langan commitlar va PR'lar (kartada ko'rsatiladi). */
  gitByTask?: (taskKey: string) => TaskGitInfo | null;
  /** Vazifa kaliti -> shu vazifada hozir ishlayotgan faol sessiya. */
  activeByTask: Map<string, SessionDto>;
  /** Boshqa sessiyaga biriktirish uchun tanlanadigan sessiyalar (prompt yuborish mumkin). */
  attachable: SessionDto[];
  /** Doska yozish sababi (null = mumkin). */
  writeReason: string | null;
  onMove: (key: string, to: TaskBoardColumn) => void;
  onAttach: (task: ProjectTaskDto, session: SessionDto) => void;
  onNewSession: (task: ProjectTaskDto) => void;
  /** 3.1: kartani navbatga qo'shish (limit yangilanganda / tunda / takroriy). Berilmasa menyu bandi chiqmaydi. */
  onQueue?: (task: ProjectTaskDto) => void;
  /** 3.9: kartani bosh sessiyaga topshirish (orkestratsiya). Berilmasa menyu bandi chiqmaydi. */
  onOrchestrate?: (task: ProjectTaskDto) => void;
  /** "Sessiyaga biriktirish" qo'shimcha sabab bo'yicha o'chiq (lockdown, token, siyosat). */
  attachReason: string | null;
  /** "Yangi sessiyada" o'chiq sababi (mashina siyosati va h.k.). */
  newReason: string | null;
  error: string | null;
  /** "Hammasi" ko'rinishida: kartada qism nishoni (kalitlar qismlar orasida takrorlanadi). */
  showPart?: boolean;
}

export function BoardTab(p: BoardProps) {
  const groups = groupByColumn(p.tasks);
  const [overCol, setOverCol] = useState<TaskBoardColumn | null>(null);
  const byKey = new Map(p.tasks.map((t) => [t.key, t]));

  return (
    <div className="flex flex-col gap-3">
      {p.writeReason && (
        <div role="note" className="rounded-lg bg-org-bg px-3 py-2 text-xs text-org" data-testid="board-readonly">
          Doska faqat ko&apos;rish rejimida: {p.writeReason}
        </div>
      )}
      {p.error && (
        <div role="alert" className="rounded-lg bg-red-bg px-3 py-2 text-xs text-red" data-testid="board-error">
          {p.error}
        </div>
      )}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] items-start gap-3.5">
        {BOARD_COLUMNS.map((col) => (
          <div
            key={col.id}
            role="group"
            aria-label={`${col.label} ustuni`}
            data-testid={`col-${col.id}`}
            onDragOver={(e) => {
              if (p.writeReason) return;
              e.preventDefault();
              setOverCol(col.id);
            }}
            onDragLeave={() => setOverCol((c) => (c === col.id ? null : c))}
            onDrop={(e) => {
              e.preventDefault();
              setOverCol(null);
              const key = e.dataTransfer.getData("text/plain");
              const t = byKey.get(key);
              if (t && !p.writeReason && canMove(t, col.id).ok) p.onMove(key, col.id);
            }}
            className={`flex flex-col gap-2 rounded-[10px] border bg-s2 p-2.5 ${overCol === col.id ? "border-blue" : "border-bd"}`}
          >
            <div className="flex items-center gap-2 px-1 pb-1 pt-0.5">
              <span className="dot" style={{ color: col.color }} />
              <b className="flex-1">{col.label}</b>
              <span className="mono text-mu">{groups[col.id].length}</span>
            </div>
            <div className="flex max-h-[640px] flex-col gap-2 overflow-y-auto">
              {groups[col.id].map((t) => (
                <TaskCard key={t.key} task={t} view={cardView(t)} session={p.activeByTask.get(t.key) ?? null} {...p} />
              ))}
              {groups[col.id].length === 0 && <span className="px-1 py-2 text-xs text-fa">Bo&apos;sh</span>}
            </div>
          </div>
        ))}
      </div>
      <span className="text-xs text-fa">Kartani sudrab ustunlar orasida suring yoki kartadagi ⋯ menyusidan foydalaning (klaviatura). TASKS.md&apos;da bajarilgan vazifalar qulflangan.</span>
    </div>
  );
}

function TaskCard({ task, view: v, session, showPart, gitByTask, writeReason, attachReason, newReason, attachable, onMove, onAttach, onNewSession, onQueue, onOrchestrate }: { task: ProjectTaskDto; view: CardView; session: SessionDto | null } & BoardProps) {
  const [menu, setMenu] = useState(false);
  const ref = useRef<HTMLElement>(null);
  const draggable = !v.locked && !writeReason;

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menu]);

  return (
    <article
      ref={ref}
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", task.key);
        e.dataTransfer.effectAllowed = "move";
      }}
      onKeyDown={(e) => e.key === "Escape" && setMenu(false)}
      data-testid="task-card"
      data-key={task.key}
      data-column={v.column}
      className={`relative flex flex-col gap-[7px] rounded-[9px] border border-bd bg-s1 px-3 py-2.5 ${draggable ? "cursor-grab" : ""}`}
    >
      <div className="flex items-center gap-1.5">
        <span className="mono text-[11px] text-mu">{v.key}</span>
        {showPart && (
          <span className="pill bg-s3 text-[10px] text-mu" style={{ height: 18, padding: "0 6px" }} title={v.part || "Asosiy"} data-testid="card-part">
            {partLabel(v.part)}
          </span>
        )}
        {v.locked && (
          <span className="text-[11px] text-fa" title={LOCKED_REASON} aria-label={LOCKED_REASON} data-testid="lock">
            🔒
          </span>
        )}
        <span className="flex-1" />
        {v.phase && (
          <span className="max-w-[110px] truncate text-[10px] text-fa" title={v.phase}>
            {v.phase.split(/[—(]/)[0].trim()}
          </span>
        )}
        <button type="button" className="btn h-6 w-6 p-0 text-xs" aria-haspopup="menu" aria-expanded={menu} aria-label={`${v.key}: amallar`} onClick={() => setMenu((m) => !m)}>
          ⋯
        </button>
      </div>
      <span className="font-medium">{v.title}</span>
      {v.progressPct !== null && v.column === "doing" && (
        <div className="h-1 rounded bg-s3" title={`Reja bo'yicha ${v.progressPct}%`}>
          <div className="h-1 rounded bg-blue" style={{ width: `${v.progressPct}%` }} />
        </div>
      )}
      {v.hasMeta && (
      <div className="mono flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-mu">
        <span title={v.planEstimated ? "Reja hajm (S/M/L) dan hisoblangan: taxmin" : undefined}>
          {v.planText}
          {v.planEstimated && <span className="ml-1 text-fa">taxmin</span>}
        </span>
        <span className={RATIO_FG[v.ratioColor]}>haqiqiy: {v.actualText}</span>
        <span>{v.tokens}</span>
        {v.branchGuess && (
          <span className="text-fa" title="Atributsiya git branch nomidan taxmin qilingan">
            taxmin (branch)
          </span>
        )}
      </div>
      )}
      {(v.scoreStars || v.delta) && (
        <div className="flex items-center gap-1.5 text-xs">
          {v.scoreStars && (
            <span className="text-yel" style={{ letterSpacing: 1 }} title={v.scoreReason ?? undefined} aria-label={`Baho: ${task.score?.score} / 5`}>
              {v.scoreStars}
            </span>
          )}
          {v.delta && <span className={RATIO_FG[v.ratioColor]}>{v.delta}</span>}
        </div>
      )}
      {gitByTask && (() => {
        const g = gitByTask(task.key);
        return g ? <TaskGit info={g} /> : null;
      })()}
      {session && (
        <Link href={`/sessions/${session.id}`} className="pill bg-blue-bg text-blue" style={{ height: 20, alignSelf: "flex-start" }} data-testid="card-session">
          <span className="dot live" />
          sessiyada ishlanmoqda
        </Link>
      )}
      {menu && (
        <div role="menu" aria-label={`${v.key} menyusi`} className="absolute right-2 top-9 z-10 flex w-[230px] flex-col gap-0.5 rounded-lg border border-bd bg-s1 p-1.5 shadow-lg" data-testid="card-menu">
          <span className="lbl px-2 py-1">Ustunga ko&apos;chirish</span>
          {BOARD_COLUMNS.map((c) => {
            const chk = canMove(task, c.id);
            const dis = !chk.ok || !!writeReason;
            return (
              <button
                key={c.id}
                role="menuitem"
                type="button"
                disabled={dis}
                title={writeReason ?? (!chk.ok ? (chk.reason ?? "Hozirgi ustun") : undefined)}
                className="rounded-md border-0 bg-transparent px-2 py-1.5 text-left text-tx hover:bg-s3 disabled:opacity-40"
                style={{ cursor: dis ? "not-allowed" : "pointer", font: "inherit" }}
                onClick={() => {
                  setMenu(false);
                  onMove(task.key, c.id);
                }}
              >
                {c.label}
              </button>
            );
          })}
          <span className="lbl px-2 py-1 pt-2">Sessiyaga biriktirish</span>
          {attachable.length === 0 && <span className="px-2 py-1 text-xs text-mu">Prompt qabul qiluvchi sessiya yo&apos;q</span>}
          {attachable.map((s) => (
            <button
              key={s.id}
              role="menuitem"
              type="button"
              disabled={!!attachReason}
              title={attachReason ?? `#task:${displayKey(task.key)} promptini yuborish`}
              className="truncate rounded-md border-0 bg-transparent px-2 py-1.5 text-left text-tx hover:bg-s3 disabled:opacity-40"
              style={{ cursor: attachReason ? "not-allowed" : "pointer", font: "inherit" }}
              onClick={() => {
                setMenu(false);
                onAttach(task, s);
              }}
            >
              {s.machineName.replace(/-[0-9a-f]{16,}.*$/, "")} · {s.status}
            </button>
          ))}
          <button
            role="menuitem"
            type="button"
            disabled={!!attachReason || !!newReason}
            title={attachReason ?? newReason ?? "Yangi sessiya oynasi vazifa bilan to'ldiriladi"}
            className="rounded-md border-0 bg-transparent px-2 py-1.5 text-left font-medium text-blue hover:bg-s3 disabled:opacity-40"
            style={{ cursor: attachReason || newReason ? "not-allowed" : "pointer", font: "inherit" }}
            onClick={() => {
              setMenu(false);
              onNewSession(task);
            }}
          >
            + Yangi sessiyada
          </button>
          {onQueue && (
            <button
              role="menuitem"
              type="button"
              disabled={!!newReason}
              title={newReason ?? "Vazifani navbatga qo'shish: limit yangilanganda, tunda yoki takroriy"}
              className="rounded-md border-0 bg-transparent px-2 py-1.5 text-left font-medium text-blue hover:bg-s3 disabled:opacity-40"
              style={{ cursor: newReason ? "not-allowed" : "pointer", font: "inherit" }}
              data-testid="card-queue"
              onClick={() => {
                setMenu(false);
                onQueue(task);
              }}
            >
              🕒 Navbatga qo&apos;shish
            </button>
          )}
          {onOrchestrate && (
            <button
              role="menuitem"
              type="button"
              disabled={!!newReason}
              title={newReason ?? "Vazifani bosh sessiyaga topshirish: reja tuzadi va ishchi sessiyalarga tarqatadi"}
              className="rounded-md border-0 bg-transparent px-2 py-1.5 text-left font-medium text-blue hover:bg-s3 disabled:opacity-40"
              style={{ cursor: newReason ? "not-allowed" : "pointer", font: "inherit" }}
              data-testid="card-orchestrate"
              onClick={() => {
                setMenu(false);
                onOrchestrate(task);
              }}
            >
              🧭 Bosh sessiyaga topshirish
            </button>
          )}
        </div>
      )}
    </article>
  );
}
