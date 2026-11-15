import { describe, expect, it } from 'vitest';
import { decideSessionEnd, decideSpanAction } from './task-spans.js';
import type { OpenSpan } from './task-spans.js';

const t = (s: number): Date => new Date(1_700_000_000_000 + s * 1000);
const open = (taskKey: string, source: OpenSpan['source'], startS = 0): OpenSpan => ({ id: 'span-1', taskKey, source, startedAt: t(startS) });

describe('decideSpanAction: aniq marker', () => {
  it('span yo\'q: ochadi', () => {
    expect(decideSpanAction(null, { taskKey: '1.4', source: 'explicit' }, t(1))).toEqual({ kind: 'open', taskKey: '1.4', source: 'explicit', at: t(1), closeCurrent: false });
  });
  it('xuddi shu aniq vazifa takror: noop', () => {
    expect(decideSpanAction(open('1.4', 'explicit'), { taskKey: '1.4', source: 'explicit' }, t(5))).toEqual({ kind: 'noop' });
  });
  it('vazifa almashadi: eskisini yopib yangisini ochadi', () => {
    expect(decideSpanAction(open('1.4', 'explicit'), { taskKey: '2.9', source: 'explicit' }, t(5))).toEqual({ kind: 'open', taskKey: '2.9', source: 'explicit', at: t(5), closeCurrent: true });
  });
  it('aniq marker ochiq branch-span\'ni ustidan yozadi (hatto bir xil id)', () => {
    expect(decideSpanAction(open('1.4', 'branch'), { taskKey: '1.4', source: 'explicit' }, t(5))).toEqual({ kind: 'open', taskKey: '1.4', source: 'explicit', at: t(5), closeCurrent: true });
  });
  it('id\'siz aniq marker: noop', () => {
    expect(decideSpanAction(null, { taskKey: null, source: 'explicit' }, t(1))).toEqual({ kind: 'noop' });
  });
});

describe('decideSpanAction: branch taxmini', () => {
  it('span yo\'q: branch-span ochadi', () => {
    expect(decideSpanAction(null, { taskKey: '1.4', source: 'branch' }, t(1))).toMatchObject({ kind: 'open', source: 'branch', closeCurrent: false });
  });
  it('aniq span ochiq: branch E\'TIBORSIZ (explicit branch\'ni bosib o\'tadi)', () => {
    expect(decideSpanAction(open('1.4', 'explicit'), { taskKey: '9.9', source: 'branch' }, t(5))).toEqual({ kind: 'noop' });
    expect(decideSpanAction(open('1.4', 'explicit'), { taskKey: null, source: 'branch' }, t(5))).toEqual({ kind: 'noop' });
  });
  it('branch o\'zgarsa almashadi; o\'zgarmasa noop; vazifasiz branchga o\'tsa yopiladi', () => {
    expect(decideSpanAction(open('1.4', 'branch'), { taskKey: '1.4', source: 'branch' }, t(5))).toEqual({ kind: 'noop' });
    expect(decideSpanAction(open('1.4', 'branch'), { taskKey: '2.1', source: 'branch' }, t(5))).toMatchObject({ kind: 'open', taskKey: '2.1', closeCurrent: true });
    expect(decideSpanAction(open('1.4', 'branch'), { taskKey: null, source: 'branch' }, t(5))).toEqual({ kind: 'close', at: t(5) });
    expect(decideSpanAction(null, { taskKey: null, source: 'branch' }, t(5))).toEqual({ kind: 'noop' });
  });
});

describe('tartibsiz va tugash', () => {
  it('ochiq span boshlanishidan eski hodisa e\'tiborsiz', () => {
    expect(decideSpanAction(open('1.4', 'explicit', 10), { taskKey: '2.9', source: 'explicit' }, t(5))).toEqual({ kind: 'noop' });
  });
  it('sessiya tugashi ochiq span\'ni yopadi; span yo\'q bo\'lsa noop; yopilish boshlanishdan oldin bo\'lmaydi', () => {
    expect(decideSessionEnd(open('1.4', 'explicit'), t(9))).toEqual({ kind: 'close', at: t(9) });
    expect(decideSessionEnd(null, t(9))).toEqual({ kind: 'noop' });
    expect(decideSessionEnd(open('1.4', 'explicit', 20), t(9))).toEqual({ kind: 'close', at: t(20) });
  });
  it('to\'liq oqim: branch -> explicit (branch yopiladi) -> boshqa explicit -> tugash', () => {
    let cur: OpenSpan | null = null;
    const log: string[] = [];
    const apply = (m: Parameters<typeof decideSpanAction>[1], s: number): void => {
      const a = decideSpanAction(cur, m, t(s));
      if (a.kind === 'open') {
        if (a.closeCurrent && cur) log.push(`close ${cur.taskKey}@${s}`);
        cur = { id: `s${s}`, taskKey: a.taskKey, source: a.source, startedAt: a.at };
        log.push(`open ${a.taskKey}/${a.source}@${s}`);
      } else if (a.kind === 'close' && cur) {
        log.push(`close ${cur.taskKey}@${s}`);
        cur = null;
      }
    };
    apply({ taskKey: '1.4', source: 'branch' }, 1);
    apply({ taskKey: '2.9', source: 'explicit' }, 2);
    apply({ taskKey: '1.4', source: 'branch' }, 3); // aniq faol: e'tiborsiz
    apply({ taskKey: '2.1', source: 'explicit' }, 4);
    const end = decideSessionEnd(cur, t(5));
    if (end.kind === 'close' && cur) log.push(`close ${(cur as OpenSpan).taskKey}@5`);
    expect(log).toEqual(['open 1.4/branch@1', 'close 1.4@2', 'open 2.9/explicit@2', 'close 2.9@4', 'open 2.1/explicit@4', 'close 2.1@5']);
  });
});
