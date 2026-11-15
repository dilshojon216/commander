import { ASK_LIMITS } from '@commander/contracts';
import type { AskSource } from '@commander/contracts';
import { redactAndCap } from '../common/redact-text.js';

/**
 * "Commander'dan savol" konteksti (6.2): FAQAT tuzilgan ma'lumot (xulosalar, vazifa statistikasi, token/limit, mashinalar,
 * navbat, hisobotlar, qarorlar). Transcript, prompt matni, tool kiritmasi, chat matni bu yerga HECH QACHON kirmaydi:
 * quruvchi faqat quyida sanalgan maydonlarni oladi (qo'shimcha maydonlar e'tiborsiz), har matn redakt qilinadi va cheklanadi.
 *
 * Har manba `[S<n>]` belgisi bilan katalogga tushadi; model javobda shu belgilarni keltiradi, markaz ularni havolaga aylantiradi.
 */

export interface AskFacts {
  now: Date;
  machines: Array<{ id: string; name: string; online: boolean; openSessions: number; working: number; waiting: number; awaitingApproval: number; lastSeenMinutesAgo: number | null }>;
  sessions: Array<{ id: string; project: string; machine: string; status: string; task: string | null; sinceMinutes: number }>;
  projects: Array<{ id: string; name: string; machine: string; todayTokens: number; openSessions: number; tasks: { todo: number; doing: number; done: number } }>;
  usage: { todayTokens: number; last7dTokens: number; last30dTokens: number; todayCostUsd: number | null; last7dCostUsd: number | null };
  limits: { fiveHour: LimitFact | null; sevenDay: LimitFact | null };
  queue: Array<{ status: string; count: number }>;
  reports: Array<{ id: string; kind: string; periodStart: string; text: string }>;
  summaries: Array<{ sessionId: string; project: string | null; machine: string; taskKey: string | null; createdAt: string; summary: string; done: string[]; openItems: string[] }>;
  decisions: Array<{ id: string; projectId: string | null; project: string | null; title: string; decision: string; createdAt: string }>;
}

export interface LimitFact {
  usedPct: number;
  /** CLAUDE.md #6: `estimate` taxmin sifatida ko'rsatiladi. */
  source: 'official' | 'estimate';
  resetsAt: string | null;
}

export interface AskContext {
  context: string;
  /** `S1` -> manba. Faqat kontekstda ko'rsatilganlar. */
  catalog: Map<string, AskSource>;
}

const fmt = (n: number): string => Math.round(n).toLocaleString('en-US').replace(/,/g, ' ');
const money = (n: number | null): string => (n === null ? "noma'lum" : `$${n.toFixed(2)} (API ekvivalenti)`);
const label = (s: string, max: number = ASK_LIMITS.sourceLabelMaxChars): string => redactAndCap(s.replace(/\s+/g, ' ').trim(), max);

/** Kontekstni quradi (<= `maxChars`). Hajm oshsa avval xulosalar/hisobotlar, so'ng sessiyalar qisqaradi. */
export function buildAskContext(f: AskFacts, maxChars: number = ASK_LIMITS.contextMaxChars): AskContext {
  const build = (nSummaries: number, nReports: number, nSessions: number, nDecisions: number): AskContext => {
    const catalog = new Map<string, AskSource>();
    let n = 0;
    const tag = (src: AskSource): string => {
      n += 1;
      const id = `S${n}`;
      catalog.set(id, src);
      return `[${id}]`;
    };
    const out: string[] = [];
    out.push(`Hozir: ${f.now.toISOString()} (Asia/Tashkent = UTC+5).`);

    out.push('', 'MASHINALAR:');
    if (f.machines.length === 0) out.push("(yo'q)");
    for (const m of f.machines) {
      const t = tag({ kind: 'machine', id: m.id, label: label(m.name), href: `/machines/${m.id}` });
      const seen = m.online ? 'onlayn' : m.lastSeenMinutesAgo === null ? "oflayn (hech qachon ko'rilmagan)" : `oflayn (${m.lastSeenMinutesAgo} daqiqa oldin ko'rilgan)`;
      out.push(`${t} ${label(m.name)}: ${seen}; ochiq sessiyalar ${m.openSessions} (ishlayapti ${m.working}, kutyapti ${m.waiting}, ruxsat kutyapti ${m.awaitingApproval})`);
    }

    out.push('', 'OCHIQ SESSIYALAR:');
    if (f.sessions.length === 0) out.push("(yo'q)");
    for (const s of f.sessions.slice(0, nSessions)) {
      const t = tag({ kind: 'session', id: s.id, label: label(`${s.project} @ ${s.machine}`), href: `/sessions/${s.id}` });
      out.push(`${t} ${label(s.project, 60)} @ ${label(s.machine, 40)}: ${s.status}, ${s.sinceMinutes} daqiqadan beri${s.task ? `, vazifa ${label(s.task, 32)}` : ''}`);
    }
    if (f.sessions.length > nSessions) out.push(`(+${f.sessions.length - nSessions} ta sessiya ko'rsatilmadi)`);

    out.push('', 'LOYIHALAR (bugungi token, vazifalar):');
    if (f.projects.length === 0) out.push("(yo'q)");
    for (const p of f.projects.slice(0, 25)) {
      const t = tag({ kind: 'project', id: p.id, label: label(p.name), href: `/projects/${p.id}` });
      out.push(`${t} ${label(p.name, 60)} @ ${label(p.machine, 40)}: bugun ${fmt(p.todayTokens)} token, ochiq sessiya ${p.openSessions}, vazifalar: qoldi ${p.tasks.todo}, jarayonda ${p.tasks.doing}, bajarildi ${p.tasks.done}`);
    }

    const u = tag({ kind: 'usage', id: null, label: 'Token sarfi', href: '/usage' });
    out.push('', `TOKEN SARFI ${u}: bugun ${fmt(f.usage.todayTokens)} (${money(f.usage.todayCostUsd)}); 7 kun ${fmt(f.usage.last7dTokens)} (${money(f.usage.last7dCostUsd)}); 30 kun ${fmt(f.usage.last30dTokens)}.`);

    const lim = (name: string, l: LimitFact | null): string =>
      l === null ? `${name}: ma'lumot yo'q` : `${name}: ${l.source === 'official' ? '' : '≈ '}${Math.round(l.usedPct)}% (${l.source === 'official' ? 'rasmiy' : 'TAXMIN'})${l.resetsAt ? `, yangilanadi ${l.resetsAt}` : ''}`;
    out.push('', `LIMITLAR: ${lim('5 soatlik', f.limits.fiveHour)}; ${lim('haftalik', f.limits.sevenDay)}.`);

    const q = tag({ kind: 'queue', id: null, label: 'Vazifalar navbati', href: '/queue' });
    out.push('', `NAVBAT ${q}: ${f.queue.length === 0 ? "bo'sh" : f.queue.map((x) => `${x.status}=${x.count}`).join(', ')}`);

    out.push('', "SO'NGGI HISOBOTLAR:");
    if (f.reports.length === 0) out.push("(yo'q)");
    for (const r of f.reports.slice(0, nReports)) {
      const t = tag({ kind: 'report', id: r.id, label: label(`${r.kind} hisobot ${r.periodStart}`), href: `/reports/${r.id}` });
      out.push(`${t} ${r.kind} ${r.periodStart}: ${redactAndCap(r.text.replace(/\s+/g, ' ').trim(), 500)}`);
    }

    out.push('', 'LOYIHA QARORLARI:');
    if (f.decisions.length === 0) out.push("(yo'q)");
    for (const d of f.decisions.slice(0, nDecisions)) {
      const t = tag({ kind: 'project', id: d.projectId, label: label(`${d.project ?? 'loyiha'}: ${d.title}`), href: d.projectId ? `/projects/${d.projectId}` : null });
      out.push(`${t} ${d.createdAt.slice(0, 10)} ${label(d.project ?? '', 40)} — ${redactAndCap(d.title, 120)}: ${redactAndCap(d.decision, 300)}`);
    }

    out.push('', 'SESSIYA XULOSALARI (savolga mos kelganlari):');
    if (f.summaries.length === 0) out.push("(mos xulosa topilmadi)");
    for (const s of f.summaries.slice(0, nSummaries)) {
      const t = tag({ kind: 'session', id: s.sessionId, label: label(`${s.project ?? 'sessiya'} @ ${s.machine} ${s.createdAt.slice(0, 10)}`), href: `/sessions/${s.sessionId}` });
      const done = s.done.length > 0 ? ` Qilingan: ${redactAndCap(s.done.slice(0, 6).join('; '), 400)}.` : '';
      const open = s.openItems.length > 0 ? ` Qolgan: ${redactAndCap(s.openItems.slice(0, 5).join('; '), 300)}.` : '';
      out.push(`${t} ${s.createdAt.slice(0, 10)} ${label(s.project ?? '', 40)}${s.taskKey ? ` vazifa ${label(s.taskKey, 32)}` : ''}: ${redactAndCap(s.summary, 700)}${done}${open}`);
    }
    return { context: out.join('\n'), catalog };
  };

  let nSummaries = 8;
  let nReports = 3;
  let nSessions = 30;
  let nDecisions = 8;
  let built = build(nSummaries, nReports, nSessions, nDecisions);
  while (built.context.length > maxChars && (nSummaries > 1 || nReports > 0 || nSessions > 5 || nDecisions > 0)) {
    if (nSummaries > 1) nSummaries -= 1;
    else if (nReports > 0) nReports -= 1;
    else if (nDecisions > 0) nDecisions -= 1;
    else nSessions = Math.max(5, nSessions - 5);
    built = build(nSummaries, nReports, nSessions, nDecisions);
  }
  if (built.context.length > maxChars) built = { ...built, context: built.context.slice(0, maxChars) };
  return built;
}

/** Model keltirgan `S<n>` belgilarini katalog bo'yicha havolalarga aylantiradi (katalogda yo'qlari tashlanadi). */
export function resolveSources(ids: readonly string[], catalog: ReadonlyMap<string, AskSource>): AskSource[] {
  const out: AskSource[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const s = catalog.get(id);
    if (!s || seen.has(id)) continue;
    seen.add(id);
    out.push(s);
    if (out.length >= ASK_LIMITS.maxSources) break;
  }
  return out;
}

/** Faol mashinani tanlash: tanlangan (agar tayyor) > onlayn Mac > har qanday tayyor onlayn mashina. Tayyor = onlayn + `assistant` e'lon qilgan. */
export function pickAssistantMachine<T extends { id: string; online: boolean; os: string | null; assistant: boolean; lastSeenAt: number }>(rows: readonly T[], preferredId: string | null): T | null {
  const ready = rows.filter((r) => r.online && r.assistant);
  if (preferredId) {
    const p = ready.find((r) => r.id === preferredId);
    if (p) return p;
  }
  const byRecent = (a: T, b: T): number => b.lastSeenAt - a.lastSeenAt;
  return [...ready].sort(byRecent).find((r) => r.os === 'darwin') ?? [...ready].sort(byRecent)[0] ?? null;
}
