import { describe, expect, it } from 'vitest';
import type { Rule } from '@commander/contracts';
import { baseKeyOf, effectiveGroupKey, guessRole, resolveRecipients, routeByRules, shortIdOf } from './messaging-logic.js';
import type { Member } from './messaging-logic.js';

const m = (n: number, role: string | null): Member => ({ sessionId: `00000000-0000-0000-0000-00000000000${n}`, claudeSessionId: `abcd123${n}-0000-4000-8000-000000000000`, role });
const backend = m(1, 'backend');
const frontend = m(2, 'frontend');
const mobile = m(3, 'mobile');
const frontend2 = m(4, 'frontend');
const members = [backend, frontend, mobile, frontend2];

describe('guruh kaliti (repo_key + links)', () => {
  it('repo_key bo\'lsa shu; bo\'lmasa project:<id>', () => {
    expect(baseKeyOf({ repoKey: 'github.com/org/repo', projectId: 'p1' })).toBe('github.com/org/repo');
    expect(baseKeyOf({ repoKey: null, projectId: 'p1' })).toBe('project:p1');
    expect(baseKeyOf({ repoKey: '', projectId: 'p1' })).toBe('project:p1');
  });

  it('workspace bog\'langan bo\'lsa samarali kalit workspace:<nom> (turli repo bir guruh)', () => {
    const a = effectiveGroupKey(baseKeyOf({ repoKey: 'github.com/org/backend', projectId: 'p1' }), 'water');
    const b = effectiveGroupKey(baseKeyOf({ repoKey: 'github.com/org/frontend', projectId: 'p2' }), 'water');
    expect(a).toBe('workspace:water');
    expect(a).toBe(b);
    expect(effectiveGroupKey('github.com/org/x', null)).toBe('github.com/org/x');
    expect(effectiveGroupKey('github.com/org/x', null)).not.toBe(a); // guruhlar o'zaro aralashmaydi
  });
});

describe('guessRole', () => {
  it.each([
    ['acme_app_mobile_app', '/Users/x/working/acme_app_mobile_app', 'mobile'],
    ['demo-flow-frontend', null, 'frontend'],
    ['dashboard', '/srv/web/dashboard', 'frontend'],
    ['commander-web', null, 'frontend'],
    ['smart-well-api', null, 'backend'],
    ['backend-services', '/home/u/backend-services', 'backend'],
    ['myServer', null, 'backend'],
    ['meter_app_flutter', null, 'mobile'],
    ['notes', '/Users/x/notes', null],
  ])('%s -> %s', (name, path, expected) => {
    expect(guessRole({ name, path })).toBe(expected);
  });

  it('"application" kabi so\'zlar "app" deb adashmaydi, "background" ham "back" emas', () => {
    expect(guessRole({ name: 'application-notes', path: null })).toBeNull();
    expect(guessRole({ name: 'background-jobs', path: null })).toBeNull();
  });
});

describe('routeByRules', () => {
  const rules: Rule[] = [
    { kind: 'question', keyword: 'schema', toRole: 'backend' },
    { kind: 'api_change', toRole: 'frontend' },
    { keyword: 'ui', toRole: 'frontend' },
  ];

  it('birinchi mos qoida; kind va keyword ikkalasi ham bo\'lsa ikkalasi mos kelishi shart', () => {
    expect(routeByRules(rules, { kind: 'question', subject: 'Schema qanday?' })).toBe('backend');
    expect(routeByRules(rules, { kind: 'question', subject: 'Boshqa' })).toBeNull();
    expect(routeByRules(rules, { kind: 'api_change', subject: 'x' })).toBe('frontend');
    expect(routeByRules(rules, { kind: 'info', subject: 'UI yangilandi' })).toBe('frontend');
  });

  it('qoidalar yo\'q = mos kelmaydi', () => {
    expect(routeByRules([], { kind: 'question', subject: 'x' })).toBeNull();
  });
});

describe('resolveRecipients', () => {
  const base = { members, fromSessionId: backend.sessionId, rules: [] as Rule[], kind: 'question' as const, subject: 's' };

  it('rol bo\'yicha: o\'sha rolli hamma (yuboruvchidan tashqari)', () => {
    const r = resolveRecipients({ ...base, to: 'Frontend' });
    expect(r).toMatchObject({ ok: true, target: 'role:frontend' });
    expect(r.ok && r.recipients.map((x) => x.sessionId)).toEqual([frontend.sessionId, frontend2.sessionId]);
  });

  it('all: yuboruvchisiz hamma; egasi (from=null): hamma', () => {
    const r = resolveRecipients({ ...base, to: 'all' });
    expect(r.ok && r.recipients).toHaveLength(3);
    const o = resolveRecipients({ ...base, fromSessionId: null, to: 'all' });
    expect(o.ok && o.recipients).toHaveLength(4);
  });

  it('o\'ziga (rol yoki id) yuborish = qabul qiluvchi yo\'q', () => {
    expect(resolveRecipients({ ...base, to: 'backend' })).toMatchObject({ ok: false, code: 'no_recipients' });
    expect(resolveRecipients({ ...base, to: shortIdOf(backend.claudeSessionId) })).toMatchObject({ ok: false, code: 'no_recipients' });
  });

  it('qisqa id va to\'liq id bo\'yicha bitta sessiya', () => {
    const a = resolveRecipients({ ...base, to: shortIdOf(mobile.claudeSessionId) });
    expect(a).toMatchObject({ ok: true, target: `session:${shortIdOf(mobile.claudeSessionId)}` });
    const b = resolveRecipients({ ...base, to: mobile.claudeSessionId });
    expect(b.ok && b.recipients[0]?.sessionId).toBe(mobile.sessionId);
  });

  it('noaniq prefiks (bir nechta mos) va noma\'lum manzil rad etiladi', () => {
    expect(resolveRecipients({ ...base, to: 'abcd123' + '' })).toMatchObject({ ok: false });
    expect(resolveRecipients({ ...base, to: 'devops' })).toMatchObject({ ok: false, code: 'unknown_target' });
  });

  it('auto: qoida bo\'yicha rol; qoida yo\'q = no_rule_matched', () => {
    const rules: Rule[] = [{ kind: 'question', toRole: 'mobile' }];
    expect(resolveRecipients({ ...base, rules, to: 'auto' })).toMatchObject({ ok: true, target: 'auto:mobile' });
    expect(resolveRecipients({ ...base, rules, kind: 'info', to: 'auto' })).toMatchObject({ ok: false, code: 'no_rule_matched' });
  });

  it('juda ko\'p qabul qiluvchi (broadcast cheklovi)', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ sessionId: `s${i}`, claudeSessionId: `x${i}00000000`, role: 'w' }));
    expect(resolveRecipients({ ...base, members: many, fromSessionId: null, to: 'all' })).toMatchObject({ ok: false, code: 'too_many_recipients' });
  });

  it('guruhda yo\'q sessiyaga (boshqa guruh) yuborib bo\'lmaydi: members faqat shu guruh', () => {
    const other = '99999999-0000-4000-8000-000000000000';
    expect(resolveRecipients({ ...base, to: other.slice(0, 8) })).toMatchObject({ ok: false, code: 'unknown_target' });
  });
});
