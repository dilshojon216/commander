import type { BillingCurrency, TimesheetClient, TimesheetDto, TimesheetProject, TimesheetTask, TimesheetTotals } from '@commander/contracts';
import { ACTIVE_CAP_MS, activeIntervals, intersect, mergeIntervals, subtract, totalMs } from './active-time.js';
import type { Interval, StatusEvent } from './active-time.js';
import { CURRENCY_DECIMALS, amountForMinutes, billedMinutes, convertMinor, formatMinor } from './money.js';

/**
 * Timesheet yig'ish (6.7): sof, deterministik. SQL qatorlari -> `TimesheetDto`. Faol vaqt ta'rifi: `active-time.ts`.
 * Loyiha = `project_key`; mijoz = `client_projects` bo'yicha. Mijoz jami = uning barcha loyihalari faol oraliqlari BIRLASHMASI.
 */

export const UNKNOWN_PROJECT_KEY = '__unknown__';
export const UNKNOWN_PROJECT_NAME = "Noma'lum (cwd yo'q)";
export const UNASSIGNED_CLIENT_NAME = 'Biriktirilmagan loyihalar';
/** Xom `token_usage` retention'i (kun) va `session_events` retention'i (kun): davr shulardan uzoq bo'lsa "to'liq emas" belgisi. */
export const RAW_USAGE_DAYS = 30;
export const SESSION_EVENTS_DAYS = 90;

export interface ClientRow {
  id: string;
  name: string;
  hourlyRate: string | null;
  currency: BillingCurrency;
}
export interface TokenSums {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}
export interface EventRow extends StatusEvent {
  projectKey: string | null;
}
export interface SpanRow {
  sessionId: string;
  projectKey: string;
  taskKey: string;
  startMs: number;
  endMs: number | null;
}
export interface TaskInfo {
  title: string;
  status: 'todo' | 'doing' | 'done' | 'unknown';
  size: string | null;
}

export interface TimesheetInput {
  from: string;
  to: string;
  startMs: number;
  endMs: number;
  nowMs: number;
  projectNames: ReadonlyMap<string, string>;
  clients: readonly ClientRow[];
  /** project_key -> client id. */
  mapping: ReadonlyMap<string, string>;
  events: readonly EventRow[];
  spans: readonly SpanRow[];
  /** Loyiha jami (kunlik agregat; 30 kundan eski davr uchun ham to'liq). */
  projectTokens: ReadonlyMap<string, { tokens: TokenSums; costUsd: number | null }>;
  /** `project_key|task_key` -> xom token'lar (span oynasi bo'yicha). */
  taskTokens: ReadonlyMap<string, { tokens: TokenSums; costUsd: number | null; sessions: number }>;
  closed: ReadonlyArray<{ projectKey: string; taskKey: string }>;
  projectCommits: ReadonlyMap<string, number>;
  taskCommits: ReadonlyMap<string, number>;
  taskInfo: ReadonlyMap<string, TaskInfo>;
  sizeHours: (size: string | null) => number | null;
  currency: BillingCurrency | null;
  fxUzsPerUsd: string | null;
}

export const taskId = (projectKey: string, taskKey: string): string => `${projectKey}|${taskKey}`;
const ZERO_TOKENS = (): TokenSums => ({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
const addTokens = (a: TokenSums, b: TokenSums): TokenSums => ({ input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheCreation: a.cacheCreation + b.cacheCreation });
const addCost = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : a + b);
const roundCost = (c: number | null): number | null => (c === null ? null : Math.round(c * 1e6) / 1e6);
const secs = (ms: number): number => Math.round(ms / 1000);

const emptyTotals = (): TimesheetTotals => ({ activeSeconds: 0, sessions: 0, tasksClosed: 0, commits: 0, tokens: ZERO_TOKENS(), costUsd: null, plannedSeconds: 0, plannedActualSeconds: 0 });

interface ProjectCalc {
  key: string;
  name: string;
  ivs: Interval[];
  sessions: Set<string>;
  project: TimesheetProject;
}

/** `[from, to]` (kunlar) bo'yicha davr chegarasi kunlari soni. */
export const periodDays = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;

export function buildTimesheet(input: TimesheetInput): TimesheetDto {
  const window: Interval = { start: input.startMs, end: input.endMs };
  const ivAll = activeIntervals(input.events, window, input.nowMs, ACTIVE_CAP_MS);
  const projectOfSession = new Map<string, string>();
  for (const e of input.events) projectOfSession.set(e.sessionId, e.projectKey ?? UNKNOWN_PROJECT_KEY);

  const byProject = new Map<string, { ivs: Interval[]; sessions: Set<string> }>();
  const bySession = new Map<string, Interval[]>();
  for (const iv of ivAll) {
    const key = projectOfSession.get(iv.sessionId) ?? UNKNOWN_PROJECT_KEY;
    const g = byProject.get(key) ?? { ivs: [], sessions: new Set<string>() };
    g.ivs.push({ start: iv.start, end: iv.end });
    g.sessions.add(iv.sessionId);
    byProject.set(key, g);
    const list = bySession.get(iv.sessionId) ?? [];
    list.push({ start: iv.start, end: iv.end });
    bySession.set(iv.sessionId, list);
  }

  // vazifa oraliqlari: sessiya faol oraliqlari ∩ span
  const taskIvs = new Map<string, { ivs: Interval[]; sessions: Set<string>; projectKey: string; taskKey: string }>();
  for (const sp of input.spans) {
    const sessionIvs = bySession.get(sp.sessionId);
    if (!sessionIvs) continue;
    const spanEnd = Math.min(sp.endMs ?? input.nowMs, window.end);
    const hit = intersect(sessionIvs, [{ start: Math.max(sp.startMs, window.start), end: spanEnd }]);
    if (hit.length === 0) continue;
    const id = taskId(sp.projectKey, sp.taskKey);
    const t = taskIvs.get(id) ?? { ivs: [], sessions: new Set<string>(), projectKey: sp.projectKey, taskKey: sp.taskKey };
    t.ivs.push(...hit);
    t.sessions.add(sp.sessionId);
    taskIvs.set(id, t);
  }

  const closedSet = new Map<string, Set<string>>();
  for (const c of input.closed) {
    const s = closedSet.get(c.projectKey) ?? new Set<string>();
    s.add(c.taskKey);
    closedSet.set(c.projectKey, s);
  }

  // Faol loyiha kalitlari: faol vaqt yoki token yoki yopilgan vazifa yoki commit
  const keys = new Set<string>([...byProject.keys(), ...input.projectTokens.keys(), ...closedSet.keys(), ...input.projectCommits.keys()]);
  const calcs = new Map<string, ProjectCalc>();
  for (const key of keys) {
    const g = byProject.get(key) ?? { ivs: [], sessions: new Set<string>() };
    const merged = mergeIntervals(g.ivs);
    const tk = input.projectTokens.get(key);
    const tasks: TimesheetTask[] = [];
    const taskIds = new Set<string>();
    for (const [id, t] of taskIvs) if (t.projectKey === key) taskIds.add(id);
    for (const id of input.taskTokens.keys()) if (id.startsWith(`${key}|`)) taskIds.add(id);
    for (const tk2 of closedSet.get(key) ?? []) taskIds.add(taskId(key, tk2));
    for (const id of input.taskCommits.keys()) if (id.startsWith(`${key}|`)) taskIds.add(id);

    let plannedSeconds = 0;
    let plannedActual = 0;
    let attributed: Interval[] = [];
    for (const id of taskIds) {
      const taskKey = id.slice(key.length + 1);
      const iv = taskIvs.get(id);
      const tt = input.taskTokens.get(id);
      const info = input.taskInfo.get(id);
      const activeSeconds = iv ? secs(totalMs(mergeIntervals(iv.ivs))) : 0;
      if (iv) attributed = attributed.concat(iv.ivs);
      const planned = info ? input.sizeHours(info.size) : null;
      const closedInPeriod = closedSet.get(key)?.has(taskKey) ?? false;
      const commits = input.taskCommits.get(id) ?? 0;
      if (activeSeconds === 0 && !tt && !closedInPeriod && commits === 0) continue;
      if (planned !== null && activeSeconds > 0) {
        plannedSeconds += Math.round(planned * 3600);
        plannedActual += activeSeconds;
      }
      tasks.push({
        key: taskKey,
        title: info?.title ?? null,
        status: info?.status ?? null,
        activeSeconds,
        sessions: iv?.sessions.size ?? tt?.sessions ?? 0,
        tokens: tt?.tokens ?? ZERO_TOKENS(),
        costUsd: roundCost(tt?.costUsd ?? null),
        commits,
        closedInPeriod,
        plannedHours: planned,
      });
    }
    tasks.sort((a, b) => b.activeSeconds - a.activeSeconds || a.key.localeCompare(b.key, undefined, { numeric: true }));
    const activeSeconds = secs(totalMs(merged));
    const project: TimesheetProject = {
      projectKey: key,
      name: key === UNKNOWN_PROJECT_KEY ? UNKNOWN_PROJECT_NAME : (input.projectNames.get(key) ?? key),
      totals: {
        activeSeconds,
        sessions: g.sessions.size,
        tasksClosed: closedSet.get(key)?.size ?? 0,
        commits: input.projectCommits.get(key) ?? 0,
        tokens: tk?.tokens ?? ZERO_TOKENS(),
        costUsd: roundCost(tk?.costUsd ?? null),
        plannedSeconds,
        plannedActualSeconds: plannedActual,
      },
      tasks,
      unattributedSeconds: secs(totalMs(subtract(merged, attributed))),
    };
    const hasActivity = activeSeconds > 0 || tasks.length > 0 || project.totals.tokens.input + project.totals.tokens.output + project.totals.tokens.cacheRead + project.totals.tokens.cacheCreation > 0 || project.totals.commits > 0;
    if (hasActivity) calcs.set(key, { key, name: project.name, ivs: merged, sessions: g.sessions, project });
  }

  // Mijozlar
  const clientOf = (key: string): string | null => input.mapping.get(key) ?? null;
  const groups = new Map<string | null, ProjectCalc[]>();
  for (const c of calcs.values()) {
    const cid = clientOf(c.key);
    const list = groups.get(cid) ?? [];
    list.push(c);
    groups.set(cid, list);
  }

  const clients: TimesheetClient[] = [];
  const clientById = new Map(input.clients.map((c) => [c.id, c] as const));
  const sumTotals = (list: ProjectCalc[]): { totals: TimesheetTotals; overlapSeconds: number; ivs: Interval[]; sessions: Set<string> } => {
    const ivs = mergeIntervals(list.flatMap((p) => p.ivs));
    const sessions = new Set<string>();
    for (const p of list) for (const s of p.sessions) sessions.add(s);
    const totals = emptyTotals();
    let sumProjects = 0;
    for (const p of list) {
      const t = p.project.totals;
      sumProjects += t.activeSeconds;
      totals.tasksClosed += t.tasksClosed;
      totals.commits += t.commits;
      totals.tokens = addTokens(totals.tokens, t.tokens);
      totals.costUsd = addCost(totals.costUsd, t.costUsd);
      totals.plannedSeconds += t.plannedSeconds;
      totals.plannedActualSeconds += t.plannedActualSeconds;
    }
    totals.activeSeconds = secs(totalMs(ivs));
    totals.sessions = sessions.size;
    totals.costUsd = roundCost(totals.costUsd);
    return { totals, overlapSeconds: Math.max(0, sumProjects - totals.activeSeconds), ivs, sessions };
  };

  const display = input.currency;
  const buildClient = (cid: string | null, list: ProjectCalc[]): TimesheetClient => {
    const row = cid ? clientById.get(cid) : undefined;
    const { totals, overlapSeconds } = sumTotals(list);
    const minutes = billedMinutes(totals.activeSeconds);
    let amount: string | null = null;
    let amountCurrency: BillingCurrency | null = null;
    let note: string | null = null;
    if (!row) note = null;
    else if (row.hourlyRate === null) note = 'Soatlik stavka belgilanmagan';
    else {
      const minor = amountForMinutes(minutes, row.hourlyRate, row.currency);
      const target = display ?? row.currency;
      if (minor === null) note = 'Stavka noto\'g\'ri';
      else if (target !== row.currency) {
        const conv = input.fxUzsPerUsd ? convertMinor(minor, row.currency, target, input.fxUzsPerUsd) : null;
        if (conv === null) note = 'Kurs kiritilmagan (valyuta farq qiladi)';
        else {
          amount = formatMinor(conv, CURRENCY_DECIMALS[target]);
          amountCurrency = target;
        }
      } else {
        amount = formatMinor(minor, CURRENCY_DECIMALS[target]);
        amountCurrency = target;
      }
    }
    return {
      clientId: row?.id ?? null,
      name: row?.name ?? UNASSIGNED_CLIENT_NAME,
      hourlyRate: row?.hourlyRate ?? null,
      rateCurrency: row?.hourlyRate !== null && row ? row.currency : null,
      amount,
      amountCurrency,
      billedMinutes: minutes,
      amountNote: note,
      totals,
      overlapSeconds,
      projects: list.map((p) => p.project).sort((a, b) => b.totals.activeSeconds - a.totals.activeSeconds || a.name.localeCompare(b.name)),
    };
  };

  for (const [cid, list] of groups) if (cid !== null && clientById.has(cid)) clients.push(buildClient(cid, list));
  clients.sort((a, b) => b.totals.activeSeconds - a.totals.activeSeconds || a.name.localeCompare(b.name));
  const unassigned = [...groups.entries()].filter(([cid]) => cid === null || !clientById.has(cid)).flatMap(([, list]) => list);
  if (unassigned.length > 0) clients.push(buildClient(null, unassigned));

  const all = [...calcs.values()];
  const total = sumTotals(all).totals;
  const now = input.nowMs;
  const startDay = Date.parse(`${input.from}T00:00:00Z`) - 5 * 3_600_000;
  return {
    period: { from: input.from, to: input.to },
    generatedAt: new Date(now).toISOString(),
    currency: display,
    fxUzsPerUsd: input.fxUzsPerUsd,
    activeCapHours: ACTIVE_CAP_MS / 3_600_000,
    taskTokensPartial: startDay < now - RAW_USAGE_DAYS * 86_400_000,
    activeTimePartial: startDay < now - SESSION_EVENTS_DAYS * 86_400_000,
    clients,
    total,
  };
}

/** `YYYY-MM` -> `{ from, to }` (oyning birinchi va oxirgi kuni). */
export function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, '0');
  return { from: `${y}-${mm}-01`, to: `${y}-${mm}-${String(last).padStart(2, '0')}` };
}
