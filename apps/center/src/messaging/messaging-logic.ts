import { MESSAGE_LIMITS } from '@commander/contracts';
import type { MessageErrorCode, MessageKind, Rule } from '@commander/contracts';

/**
 * Sof mantiq (DB'siz): guruh kaliti, rol taxmini, yo'naltirish qoidalari va qabul qiluvchilarni aniqlash.
 * `MessagingService` ham, testlar ham shuni ishlatadi.
 */

/** Samarali guruh kaliti: workspace'ga bog'langan bo'lsa `workspace:<nom>`, aks holda asl kalit (repo_key, yo'q bo'lsa `project:<uuid>`). */
export function baseKeyOf(p: { repoKey: string | null; projectId: string }): string {
  return p.repoKey && p.repoKey.length > 0 ? p.repoKey : `project:${p.projectId}`;
}

export function effectiveGroupKey(base: string, workspace: string | null): string {
  return workspace ? `workspace:${workspace}` : base;
}

/** Sessiyaning qisqa id'si: `to` sifatida ishlatiladi. */
export const shortIdOf = (claudeSessionId: string): string => claudeSessionId.slice(0, 8).toLowerCase();

const FRONT = ['front', 'frontend', 'web', 'ui', 'client', 'dashboard', 'site', 'landing', 'next', 'react', 'vue'];
const BACK = ['back', 'backend', 'api', 'server', 'service', 'services', 'core', 'gateway', 'nest', 'nestjs'];
const MOBILE = ['mobile', 'app', 'flutter', 'android', 'ios', 'rn'];

/** Nom/yo'l bo'laklari: kichik harf, harf-raqam bo'yicha va camelCase chegarasida. */
function tokens(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

const hasAny = (ts: string[], words: string[]): boolean => ts.some((t) => words.includes(t) || words.some((w) => w.length >= 4 && t.startsWith(w) && t.length <= w.length + 2));

/**
 * Loyiha nomi va yo'lining oxirgi segmentlaridan rol TAXMINI (`frontend` | `backend` | `mobile` | `null`). Aniq o'rnatilgan
 * rol har doim ustun; bu faqat dastlabki ko'rsatma va doim "taxmin" deb belgilanadi. Ustuvorlik: mobile > frontend > backend
 * ("acme-app-mobile-app" -> mobile; "api-web" -> frontend).
 */
export function guessRole(i: { name: string | null; path: string | null }): string | null {
  const pathParts = (i.path ?? '').split(/[\\/]+/).filter(Boolean).slice(-2);
  const ts = [...tokens(i.name ?? ''), ...pathParts.flatMap(tokens)];
  if (ts.length === 0) return null;
  if (hasAny(ts, MOBILE)) return 'mobile';
  if (hasAny(ts, FRONT)) return 'frontend';
  if (hasAny(ts, BACK)) return 'backend';
  return null;
}

/** Qoidalar tartib bilan; birinchi mos kelgani. Qoida: `kind` va/yoki `keyword` (mavzuda, katta-kichik harfsiz). Mos kelmasa `null`. */
export function routeByRules(rules: readonly Rule[], i: { kind: MessageKind; subject: string }): string | null {
  const subject = i.subject.toLowerCase();
  for (const r of rules) {
    if (r.kind !== undefined && r.kind !== i.kind) continue;
    if (r.keyword !== undefined && !subject.includes(r.keyword.toLowerCase())) continue;
    if (r.kind === undefined && r.keyword === undefined) continue;
    return r.toRole;
  }
  return null;
}

export interface Member {
  sessionId: string;
  claudeSessionId: string;
  /** Samarali rol (aniq yoki taxmin), yo'q bo'lsa `null`. */
  role: string | null;
}

export type Resolution =
  | { ok: true; recipients: Member[]; target: string }
  | { ok: false; code: MessageErrorCode; message: string };

const HEX = /^[0-9a-f][0-9a-f-]{7,}$/;

/**
 * `to` ni qabul qiluvchilarga aylantiradi (yuboruvchi har doim chiqariladi; guruhdan tashqari hech kim kirmaydi:
 * `members` allaqachon bitta guruh a'zolari). `fromSessionId = null` = egasi (hech kim chiqarilmaydi).
 */
export function resolveRecipients(i: { to: string; members: readonly Member[]; fromSessionId: string | null; rules: readonly Rule[]; kind: MessageKind; subject: string }): Resolution {
  const to = i.to.trim().toLowerCase();
  const others = i.members.filter((m) => m.sessionId !== i.fromSessionId);
  const finish = (recipients: Member[], target: string): Resolution => {
    if (recipients.length === 0) return { ok: false, code: 'no_recipients', message: 'Guruhda bu manzilga mos boshqa sessiya yo\'q' };
    if (recipients.length > MESSAGE_LIMITS.maxRecipients) return { ok: false, code: 'too_many_recipients', message: `Bir yuborishda eng ko'pi ${MESSAGE_LIMITS.maxRecipients} qabul qiluvchi` };
    return { ok: true, recipients, target };
  };

  if (to === 'all' || to === 'hammasi') return finish(others, 'all');
  if (to === 'auto') {
    const role = routeByRules(i.rules, { kind: i.kind, subject: i.subject });
    if (!role) return { ok: false, code: 'no_rule_matched', message: 'Avto-yo\'naltirish qoidalaridan hech biri mos kelmadi' };
    return finish(others.filter((m) => m.role === role), `auto:${role}`);
  }
  const byRole = i.members.filter((m) => m.role === to);
  if (byRole.length > 0) return finish(others.filter((m) => m.role === to), `role:${to}`);
  if (HEX.test(to)) {
    const bySession = i.members.filter((m) => m.claudeSessionId.toLowerCase() === to || m.claudeSessionId.toLowerCase().startsWith(to));
    if (bySession.length === 1) {
      const only = bySession[0] as Member;
      return finish(only.sessionId === i.fromSessionId ? [] : [only], `session:${shortIdOf(only.claudeSessionId)}`);
    }
    if (bySession.length > 1) return { ok: false, code: 'unknown_target', message: 'Sessiya id\'si bir nechta sessiyaga mos keladi: uzunroq yozing' };
  }
  return { ok: false, code: 'unknown_target', message: `Guruhda "${i.to.slice(0, 40)}" rolli yoki id'li sessiya yo'q (commander_peers bilan tekshiring)` };
}

/** Yuboruvchi chiqaradigan vaqt oynasini tekshirish uchun kalit. */
export const sendLimitKey = (sessionId: string): string => `send:${sessionId}`;
