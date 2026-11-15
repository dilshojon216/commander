import type { ProjectTaskDto, ProjectTasksResponse, ProjectTaskStatus, TokenTotals } from "@commander/contracts";
import { formatCost, formatDayLabel, formatDuration, formatLastUsed, formatTokens } from "./format";

/** TASKS bo'limi ko'rinish modeli (sof, testlanadi): faza guruhlari, progress, "vazifasiz", qamrov izohi. */

export const TASK_STATUS_LABEL: Record<ProjectTaskStatus, string> = {
  todo: "Qoldi",
  doing: "Jarayonda",
  done: "Bajarildi",
  unknown: "Noma'lum",
};

export interface TaskRowView {
  key: string;
  title: string;
  status: ProjectTaskStatus;
  statusLabel: string;
  tokens: string;
  tokensTitle: string;
  /** "≈ $X API ekv." yoki "—". */
  cost: string;
  activeTime: string;
  sessions: string;
  lastActivity: string;
  /** Atributsiya TAXMIN bo'lsa badge matni (branch nomidan). */
  badge: { text: string; title: string } | null;
}

export interface TaskGroupView {
  phase: string | null;
  tasks: TaskRowView[];
  done: number;
  total: number;
}

export interface TasksView {
  groups: TaskGroupView[];
  total: number;
  done: number;
  doing: number;
  donePct: number;
  doingPct: number;
  unattributed: { tokens: string; cost: string; sessions: number } | null;
  /** Faoliyat bor, lekin TASKS.md'da yo'q id'lar. */
  other: { key: string; tokens: string; sessions: number }[];
  /** Token qamrovi eslatmasi. */
  coveredNote: string | null;
  hasStats: boolean;
}

const totalOf = (t: TokenTotals) => t.totalTokens;

function costText(t: TokenTotals): string {
  return t.costUsd === null ? "—" : `≈ ${formatCost(t.costUsd)} API ekv.`;
}

function rowView(t: ProjectTaskDto, now: number): TaskRowView {
  const s = t.stats;
  const used = s.sessions > 0 || totalOf(s.tokens) > 0;
  let badge: TaskRowView["badge"] = null;
  if (s.source === "branch") badge = { text: "taxmin (branch)", title: "Vazifa git branch nomidan taxmin qilingan; /task yoki #task: bilan aniqlashtiring" };
  else if (s.source === "mixed") badge = { text: "qisman taxmin", title: "Statistikaning bir qismi git branch nomidan taxmin qilingan" };
  return {
    key: t.key,
    title: t.title,
    status: t.status,
    statusLabel: TASK_STATUS_LABEL[t.status],
    tokens: used ? formatTokens(totalOf(s.tokens)) : "—",
    tokensTitle: used ? `input ${formatTokens(s.tokens.inputTokens)} · output ${formatTokens(s.tokens.outputTokens)} · cache read ${formatTokens(s.tokens.cacheReadTokens)} · cache write ${formatTokens(s.tokens.cacheCreationTokens)}` : "Bu vazifa bo'yicha token yo'q",
    cost: used ? costText(s.tokens) : "—",
    activeTime: s.activeSeconds > 0 ? formatDuration(s.activeSeconds * 1000) : "—",
    sessions: s.sessions > 0 ? String(s.sessions) : "—",
    lastActivity: s.lastActivityAt && now ? formatLastUsed(s.lastActivityAt, now) : "—",
    badge,
  };
}

export function buildTasksView(resp: ProjectTasksResponse, now: number): TasksView {
  const groups: TaskGroupView[] = [];
  for (const t of [...resp.tasks].sort((a, b) => a.order - b.order)) {
    let g = groups[groups.length - 1];
    if (!g || g.phase !== t.phase) {
      g = { phase: t.phase, tasks: [], done: 0, total: 0 };
      groups.push(g);
    }
    g.tasks.push(rowView(t, now));
    g.total++;
    if (t.status === "done") g.done++;
  }
  const total = resp.summary.total;
  const un = resp.unattributed;
  const unUsed = un.sessions > 0 || totalOf(un.tokens) > 0;
  const covered = Date.parse(resp.tokensCoveredFrom);
  return {
    groups,
    total,
    done: resp.summary.done,
    doing: resp.summary.doing,
    donePct: total ? (resp.summary.done / total) * 100 : 0,
    doingPct: total ? (resp.summary.doing / total) * 100 : 0,
    unattributed: unUsed ? { tokens: formatTokens(totalOf(un.tokens)), cost: costText(un.tokens), sessions: un.sessions } : null,
    other: resp.other.map((o) => ({ key: o.key, tokens: formatTokens(totalOf(o.stats.tokens)), sessions: o.stats.sessions })),
    coveredNote: Number.isNaN(covered) ? null : `Tokenlar ${formatDayLabel(covered)} dan hisoblanadi: 30 kundan eskisi hisobda yo'q`,
    hasStats: resp.tasks.some((t) => t.stats.sessions > 0 || totalOf(t.stats.tokens) > 0),
  };
}

/** Sessiya ro'yxati uchun vazifa belgisi: `T-07` yoki taxmin bo'lsa `T-07 ~`. */
export function taskPill(s: { taskKey?: string | null; taskSource?: "explicit" | "branch" | null }): { text: string; title: string } | null {
  if (!s.taskKey) return null;
  const guess = s.taskSource === "branch";
  return { text: guess ? `${s.taskKey} ~` : s.taskKey, title: guess ? `Vazifa ${s.taskKey} (taxmin: git branch nomidan)` : `Vazifa ${s.taskKey}${s.taskSource === "explicit" ? " (aniq belgilangan)" : ""}` };
}
