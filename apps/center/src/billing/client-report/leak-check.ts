import type { ClientReportModel } from '@commander/contracts';
import { redactText } from '../../common/redact-text.js';
import { visibleText } from './html.js';

/**
 * So'nggi to'siq (6.8): yaratilgan hujjat matnida taqiqlangan narsa qolganini tekshiradi. `sanitize.ts` asosiy himoya; bu
 * u o'tkazib yuborgan holatni TO'XTATADI (generatsiya 422). Faqat TOPILGAN TURLAR qaytadi (qiymatlar emas: jurnalga/javobga sir tushmasin).
 */

export interface LeakContext {
  /** Mashina nomlari, host nomlari (>= 3 belgi). */
  names: readonly string[];
  /** Loyiha yo'llari (to'liq). */
  paths: readonly string[];
  /** Ko'lamdagi commit xeshlari (to'liq). */
  shas: readonly string[];
}

export type LeakKind = 'machine_name' | 'path' | 'commit_hash' | 'secret' | 'generic_path' | 'url' | 'email' | 'ip';

const GENERIC: Array<[LeakKind, RegExp]> = [
  ['generic_path', /(?:^|[\s("'])(?:~|\/Users|\/home|\/var|\/etc|\/opt|\/tmp|[A-Za-z]:\\)[/\\]/],
  ['commit_hash', /(?<![0-9A-Za-z])(?=[0-9a-f]{7,40}(?![0-9A-Za-z]))(?=[0-9]*[a-f])(?=[a-f]*[0-9])[0-9a-f]{7,40}(?![0-9A-Za-z])/i],
  ['url', /\b[a-z][a-z0-9+.-]{1,12}:\/\/\S+/i],
  ['email', /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}/],
  ['ip', /\b\d{1,3}(?:\.\d{1,3}){3}\b/],
];

function modelStrings(m: ClientReportModel): string {
  const parts: string[] = [m.title];
  for (const g of m.groups) parts.push(g.name, ...g.done.map((t) => t.title), ...g.inProgress.map((t) => t.title), ...g.remaining.map((t) => t.title), ...g.closedInPeriod.map((t) => t.title));
  for (const s of m.summaries) parts.push(...s.lines);
  return parts.join('\n');
}

export function findLeaks(m: ClientReportModel, html: string, ctx: LeakContext): LeakKind[] {
  const found = new Set<LeakKind>();
  for (const text of [modelStrings(m), visibleText(html)]) {
    const lower = text.toLowerCase();
    for (const n of ctx.names) if (n.trim().length >= 3 && lower.includes(n.trim().toLowerCase())) found.add('machine_name');
    for (const p of ctx.paths) if (p.length >= 3 && text.includes(p)) found.add('path');
    for (const s of ctx.shas) if (s.length >= 7 && lower.includes(s.slice(0, 7).toLowerCase())) found.add('commit_hash');
    if (redactText(text) !== text) found.add('secret');
    for (const [kind, re] of GENERIC) if (re.test(text)) found.add(kind);
  }
  return [...found];
}
