import { DEFAULT_REPORT_SETTINGS } from '@commander/contracts';
import type { ReportData, ReportKind, ReportModelShare, ReportSection, ReportSettings } from '@commander/contracts';
import { weightedTokens } from '../limits/limits-logic.js';
import { addDays, tashkentDayOf, TASHKENT_OFFSET_MS } from '../projects/tashkent-day.js';

/**
 * Hisobot mantig'i (3.3): sof, deterministik (LLM yo'q). Davr hisobi, jadval (Asia/Tashkent), agregatsiya, tavsiya evristikasi.
 * Narx = API-ekvivalent (`token_usage.cost_usd`): obuna to'lovi emas. Limit ulushi = vaznli tokenlar ulushi (`TOKEN_WEIGHTS`).
 */

export const MAX_RECOMMENDATIONS = 5;
/** "Kichik vazifa": reja <= shuncha soat (S = 2). */
export const SMALL_TASK_HOURS = 2;
export const OPUS_SMALL_TASK_SHARE = 0.6;
export const OPUS_SMALL_TASK_MIN_WEIGHTED = 200_000;
export const OPUS_SHORT_OUTPUT_TOKENS = 400;
export const OPUS_SHORT_MIN_REQUESTS = 20;
export const OPUS_PROJECT_SHARE = 0.5;
export const MAX_TOP_TASKS = 3;

export interface Period {
  kind: ReportKind;
  from: string;
  to: string;
}

/** Toshkent vaqtidagi (kun, daqiqa-kun, hafta kuni). */
export function tashkentClock(now: Date): { day: string; minutes: number; weekday: number } {
  const local = new Date(now.getTime() + TASHKENT_OFFSET_MS);
  return { day: local.toISOString().slice(0, 10), minutes: local.getUTCHours() * 60 + local.getUTCMinutes(), weekday: local.getUTCDay() };
}

export const parseHm = (hm: string): number => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));

/** Davr: kunlik = shu kun; haftalik = `day` va undan oldingi 6 kun (oxirgi 7 kun). */
export function periodFor(kind: ReportKind, day: string): Period {
  return kind === 'daily' ? { kind, from: day, to: day } : { kind, from: addDays(day, -6), to: day };
}

/** Rejalashtirilgan hisobot vaqti keldimi (bugun, belgilangan soatdan keyin) va shu davr uchun hali yaratilmaganmi. */
export function duePeriods(settings: ReportSettings, now: Date, existing: ReadonlySet<string>): Period[] {
  const c = tashkentClock(now);
  const out: Period[] = [];
  if (settings.dailyEnabled && c.minutes >= parseHm(settings.dailyTime)) {
    const p = periodFor('daily', c.day);
    if (!existing.has(`daily|${p.from}`)) out.push(p);
  }
  if (settings.weeklyEnabled && c.weekday === settings.weeklyDay && c.minutes >= parseHm(settings.weeklyTime)) {
    const p = periodFor('weekly', c.day);
    if (!existing.has(`weekly|${p.from}`)) out.push(p);
  }
  return out;
}

export function normalizeSettings(raw: unknown): ReportSettings {
  const o = typeof raw === 'object' && raw !== null ? (raw as Partial<ReportSettings>) : {};
  const hm = (v: unknown, d: string): string => (typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : d);
  return {
    dailyEnabled: typeof o.dailyEnabled === 'boolean' ? o.dailyEnabled : DEFAULT_REPORT_SETTINGS.dailyEnabled,
    weeklyEnabled: typeof o.weeklyEnabled === 'boolean' ? o.weeklyEnabled : DEFAULT_REPORT_SETTINGS.weeklyEnabled,
    dailyTime: hm(o.dailyTime, DEFAULT_REPORT_SETTINGS.dailyTime),
    weeklyTime: hm(o.weeklyTime, DEFAULT_REPORT_SETTINGS.weeklyTime),
    weeklyDay: typeof o.weeklyDay === 'number' && Number.isInteger(o.weeklyDay) && o.weeklyDay >= 0 && o.weeklyDay <= 6 ? o.weeklyDay : DEFAULT_REPORT_SETTINGS.weeklyDay,
  };
}

// --- agregatsiya ----------------------------------------------------------------------------------

export interface ModelRow {
  projectId: string | null;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  cost: number | null;
  requests: number;
}
export interface TaskStatRow {
  projectId: string;
  key: string;
  title: string | null;
  /** `project_tasks.size` ("S", "M", "4h", ...) uchun hisoblangan reja soati; yo'q = null. */
  plannedHours: number | null;
  weighted: number;
  cost: number | null;
  activeSeconds: number;
}
export interface TaskModelRow {
  projectId: string;
  key: string;
  model: string;
  weighted: number;
  output: number;
  requests: number;
}
export interface ReportInput {
  period: Period;
  projects: ReadonlyArray<{ id: string; name: string }>;
  models: readonly ModelRow[];
  closed: ReadonlyArray<{ projectId: string; key: string; title: string | null }>;
  commits: ReadonlyArray<{ projectId: string; count: number }>;
  active: ReadonlyArray<{ projectId: string | null; seconds: number }>;
  sessions: ReadonlyArray<{ projectId: string | null; sessions: number }>;
  tasks: readonly TaskStatRow[];
  taskModels: readonly TaskModelRow[];
  summaries: ReadonlyArray<{ projectId: string; day: string; summary: string }>;
  limits: ReportData['limits'];
}

export const modelFamily = (model: string): string => {
  const m = model.toLowerCase();
  if (m.includes('opus')) return 'Opus';
  if (m.includes('sonnet')) return 'Sonnet';
  if (m.includes('haiku')) return 'Haiku';
  return model.length > 32 ? model.slice(0, 32) : model;
};

const sumCost = (xs: Array<number | null>): number | null => (xs.every((x) => x === null) ? null : Math.round(xs.reduce<number>((a, b) => a + (b ?? 0), 0) * 10_000) / 10_000);
const rowWeighted = (r: ModelRow): number => weightedTokens({ input: r.input, output: r.output, cacheRead: r.cacheRead, cacheCreation: r.cacheCreation });

function modelShares(rows: readonly ModelRow[]): ReportModelShare[] {
  const by = new Map<string, { requests: number; weighted: number; output: number; costs: Array<number | null> }>();
  for (const r of rows) {
    const f = modelFamily(r.model);
    const cur = by.get(f) ?? { requests: 0, weighted: 0, output: 0, costs: [] };
    cur.requests += r.requests;
    cur.weighted += rowWeighted(r);
    cur.output += r.output;
    cur.costs.push(r.cost);
    by.set(f, cur);
  }
  const total = [...by.values()].reduce((s, v) => s + v.weighted, 0);
  return [...by.entries()]
    .map(([model, v]) => ({ model, requests: v.requests, weighted: Math.round(v.weighted), outputTokens: Math.round(v.output), costUsd: sumCost(v.costs), share: total > 0 ? Math.round((v.weighted / total) * 1000) / 1000 : 0 }))
    .sort((a, b) => b.weighted - a.weighted);
}

function section(args: {
  projectId: string | null;
  name: string;
  models: readonly ModelRow[];
  closed: Array<{ key: string; title: string | null }>;
  commits: number;
  activeSeconds: number;
  sessions: number;
  tasks: readonly TaskStatRow[];
  totalWeighted: number;
  summaries: string[];
}): ReportSection {
  const tokens = args.models.reduce(
    (a, r) => ({ input: a.input + r.input, output: a.output + r.output, cacheRead: a.cacheRead + r.cacheRead, cacheCreation: a.cacheCreation + r.cacheCreation }),
    { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
  );
  const weighted = weightedTokens(tokens);
  const planned = args.tasks.filter((t) => t.plannedHours !== null);
  return {
    projectId: args.projectId,
    name: args.name,
    tasksClosed: args.closed,
    commits: args.commits,
    tokens: { ...tokens, weighted: Math.round(weighted) },
    costUsd: sumCost(args.models.map((m) => m.cost)),
    activeSeconds: Math.round(args.activeSeconds),
    sessions: args.sessions,
    topTasks: [...args.tasks]
      .filter((t) => t.weighted > 0)
      .sort((a, b) => b.weighted - a.weighted || a.key.localeCompare(b.key))
      .slice(0, MAX_TOP_TASKS)
      .map((t) => ({ key: t.key, title: t.title, weighted: Math.round(t.weighted), costUsd: t.cost })),
    planVsActual:
      planned.length > 0
        ? {
            plannedHours: Math.round(planned.reduce((s, t) => s + (t.plannedHours ?? 0), 0) * 10) / 10,
            actualHours: Math.round((planned.reduce((s, t) => s + t.activeSeconds, 0) / 3600) * 10) / 10,
            tasks: planned.length,
          }
        : null,
    limitShare: args.totalWeighted > 0 ? Math.round((weighted / args.totalWeighted) * 1000) / 1000 : 0,
    models: modelShares(args.models),
    summaries: args.summaries,
  };
}

export function buildReport(input: ReportInput): ReportData {
  const names = new Map(input.projects.map((p) => [p.id, p.name] as const));
  const totalWeighted = input.models.reduce((s, r) => s + rowWeighted(r), 0);

  const ids = new Set<string>();
  for (const r of input.models) if (r.projectId) ids.add(r.projectId);
  for (const r of input.closed) ids.add(r.projectId);
  for (const r of input.commits) if (r.count > 0) ids.add(r.projectId);
  for (const r of input.active) if (r.projectId && r.seconds > 0) ids.add(r.projectId);

  const projects = [...ids].map((id) =>
    section({
      projectId: id,
      name: names.get(id) ?? id.slice(0, 8),
      models: input.models.filter((m) => m.projectId === id),
      closed: input.closed.filter((c) => c.projectId === id).map((c) => ({ key: c.key, title: c.title })),
      commits: input.commits.find((c) => c.projectId === id)?.count ?? 0,
      activeSeconds: input.active.filter((a) => a.projectId === id).reduce((s, a) => s + a.seconds, 0),
      sessions: input.sessions.filter((s) => s.projectId === id).reduce((s, x) => s + x.sessions, 0),
      tasks: input.tasks.filter((t) => t.projectId === id),
      totalWeighted,
      summaries: input.summaries.filter((s) => s.projectId === id).sort((a, b) => a.day.localeCompare(b.day)).map((s) => s.summary),
    }),
  );
  projects.sort((a, b) => b.tokens.weighted - a.tokens.weighted || (a.name < b.name ? -1 : 1));

  const total = section({
    projectId: null,
    name: 'Jami',
    models: input.models,
    closed: input.closed.map((c) => ({ key: c.key, title: c.title })),
    commits: input.commits.reduce((s, c) => s + c.count, 0),
    activeSeconds: input.active.reduce((s, a) => s + a.seconds, 0),
    sessions: input.sessions.reduce((s, x) => s + x.sessions, 0),
    tasks: input.tasks,
    totalWeighted,
    summaries: [],
  });
  return {
    kind: input.period.kind,
    from: input.period.from,
    to: input.period.to,
    total,
    projects,
    recommendations: recommend(input, names),
    limits: input.limits,
  };
}

/**
 * Model tanlash tavsiyasi (deterministik). Qoidalar:
 *  R1 — kichik vazifa (reja <= 2 soat) vaznli tokenlarining >= 60% Opus'da va >= 200k: "Sonnet yetarli bo'lishi mumkin";
 *  R2 — loyihada Opus >= 20 so'rov, o'rtacha chiqish < 400 token va Opus ulushi >= 50%: qisqa so'rovlar uchun Sonnet.
 * Bu maslahat, hukm emas: sifat/xavf tomonini egasi baholaydi.
 */
export function recommend(input: Pick<ReportInput, 'models' | 'tasks' | 'taskModels'>, names: ReadonlyMap<string, string>): string[] {
  const out: string[] = [];
  const byTask = new Map<string, TaskModelRow[]>();
  for (const r of input.taskModels) {
    const k = `${r.projectId}|${r.key}`;
    byTask.set(k, [...(byTask.get(k) ?? []), r]);
  }
  for (const t of input.tasks) {
    if (t.plannedHours === null || t.plannedHours > SMALL_TASK_HOURS) continue;
    const rows = byTask.get(`${t.projectId}|${t.key}`) ?? [];
    const total = rows.reduce((s, r) => s + r.weighted, 0);
    const opus = rows.filter((r) => modelFamily(r.model) === 'Opus').reduce((s, r) => s + r.weighted, 0);
    if (total >= OPUS_SMALL_TASK_MIN_WEIGHTED && opus / total >= OPUS_SMALL_TASK_SHARE) {
      out.push(`«${t.key}» kichik vazifa (~${t.plannedHours} soat) lekin tokenlarning ${Math.round((opus / total) * 100)}% Opus'da (${Math.round(total / 1000)}k): Sonnet yetarli bo'lishi mumkin`);
    }
  }
  const projectIds = new Set(input.models.map((m) => m.projectId).filter((x): x is string => x !== null));
  for (const id of projectIds) {
    const rows = input.models.filter((m) => m.projectId === id);
    const opusRows = rows.filter((r) => modelFamily(r.model) === 'Opus');
    const req = opusRows.reduce((s, r) => s + r.requests, 0);
    if (req < OPUS_SHORT_MIN_REQUESTS) continue;
    const avgOut = opusRows.reduce((s, r) => s + r.output, 0) / req;
    const share = opusRows.reduce((s, r) => s + rowWeighted(r), 0) / Math.max(1, rows.reduce((s, r) => s + rowWeighted(r), 0));
    if (avgOut < OPUS_SHORT_OUTPUT_TOKENS && share >= OPUS_PROJECT_SHARE) {
      out.push(`${names.get(id) ?? id.slice(0, 8)}: Opus so'rovlari qisqa (o'rtacha ${Math.round(avgOut)} chiqish tokeni, ${req} ta): oddiy ishlar uchun Sonnet sinab ko'ring`);
    }
  }
  return out.slice(0, MAX_RECOMMENDATIONS);
}

/** Davr yorlig'i: "13-noy" yoki "7-13 noy". */
export const periodLabel = (p: Pick<Period, 'from' | 'to'>): string => (p.from === p.to ? p.to : `${p.from} — ${p.to}`);

export { tashkentDayOf };
