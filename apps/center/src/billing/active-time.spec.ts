import { describe, expect, it } from 'vitest';
import { ACTIVE_CAP_MS, activeIntervals, intersect, mergeIntervals, subtract, unionSeconds } from './active-time.js';
import type { StatusEvent } from './active-time.js';
import { tashkentDayRange } from '../projects/tashkent-day.js';

const H = 3_600_000;
const T0 = Date.parse('2026-11-10T00:00:00Z');
const win = { start: T0, end: T0 + 24 * H };
const ev = (sessionId: string, h: number, status: string, nextH: number | null): StatusEvent => ({ sessionId, ts: T0 + h * H, status, nextTs: nextH === null ? null : T0 + nextH * H });
const NOW = T0 + 1000 * H;

describe('activeIntervals', () => {
  it('faqat working va awaiting_approval sanaladi', () => {
    const r = activeIntervals([ev('a', 1, 'working', 2), ev('a', 2, 'waiting', 3), ev('a', 3, 'awaiting_approval', 3.5), ev('a', 3.5, 'idle', 4)], win, NOW);
    expect(r.map((i) => [(i.start - T0) / H, (i.end - T0) / H])).toEqual([[1, 2], [3, 3.5]]);
  });

  it("bo'sh joy (idle gap) 4 soat bilan chegaralanadi", () => {
    const r = activeIntervals([ev('a', 1, 'working', 20)], win, NOW);
    expect(r[0]!.end - r[0]!.start).toBe(ACTIVE_CAP_MS);
  });

  it("oxirgi hodisa (keyingisi yo'q) ham chegaralanadi va `now` dan o'tmaydi", () => {
    expect(activeIntervals([ev('a', 1, 'working', null)], win, NOW)[0]!.end - T0 - H).toBe(ACTIVE_CAP_MS);
    const now = T0 + 2 * H;
    expect(activeIntervals([ev('a', 1, 'working', null)], win, now)[0]!.end).toBe(now);
    expect(activeIntervals([ev('a', 3, 'working', null)], win, now)).toEqual([]);
  });

  it('oyna chegarasida kesiladi (kecha boshlangan oraliq)', () => {
    const r = activeIntervals([ev('a', -1, 'working', 1)], win, NOW);
    expect([(r[0]!.start - T0) / H, (r[0]!.end - T0) / H]).toEqual([0, 1]);
    const r2 = activeIntervals([ev('a', 23, 'working', 30)], win, NOW);
    expect((r2[0]!.end - T0) / H).toBe(24);
  });

  it("oyna tashqarisidagi hodisa e'tiborsiz", () => {
    expect(activeIntervals([ev('a', 30, 'working', 31), ev('a', -10, 'working', -9)], win, NOW)).toEqual([]);
  });

  it("Toshkent kun chegarasi: UTC 19:00 = Toshkent 00:00 (oy chegarasi)", () => {
    const nov = { start: tashkentDayRange('2026-11-01').start.getTime(), end: tashkentDayRange('2026-11-30').end.getTime() };
    expect(new Date(nov.start).toISOString()).toBe('2026-10-31T19:00:00.000Z');
    // 31-oktyabr 18:00Z..20:00Z ishlangan: faqat 19:00Z dan keyingi qismi noyabrga tushadi
    const ts = Date.parse('2026-10-31T18:00:00Z');
    const r = activeIntervals([{ sessionId: 'a', ts, status: 'working', nextTs: ts + 2 * H }], nov, NOW);
    expect(r[0]!.end - r[0]!.start).toBe(H);
    // noyabr oxiri: 30-noyabr 18:30Z (Toshkent 23:30) .. 19:30Z: yarmi noyabrda
    const t2 = Date.parse('2026-11-30T18:30:00Z');
    const r2 = activeIntervals([{ sessionId: 'a', ts: t2, status: 'working', nextTs: t2 + H }], nov, NOW);
    expect(r2[0]!.end - r2[0]!.start).toBe(H / 2);
  });
});

describe('mergeIntervals / unionSeconds', () => {
  it('kesishganlar qo\'shiladi, tegib turganlar ham', () => {
    expect(mergeIntervals([{ start: 5, end: 8 }, { start: 1, end: 3 }, { start: 2, end: 4 }, { start: 4, end: 5 }])).toEqual([{ start: 1, end: 8 }]);
  });

  it("parallel sessiyalar ikki marta sanalmaydi", () => {
    // A: 1..3, B: 2..4 (soat) => birlashma 3 soat, yig'indi 4 soat
    const r = activeIntervals([ev('a', 1, 'working', 3), ev('b', 2, 'working', 4)], win, NOW);
    expect(unionSeconds(r)).toBe(3 * 3600);
    expect(r.reduce((s, i) => s + (i.end - i.start), 0)).toBe(4 * H);
  });

  it('bir sessiya ichida takroriy/ustma-ust oraliq bir marta', () => {
    expect(unionSeconds([{ start: 0, end: 10_000 }, { start: 0, end: 10_000 }, { start: 5_000, end: 6_000 }])).toBe(10);
  });

  it("bo'sh kirish = 0", () => {
    expect(unionSeconds([])).toBe(0);
  });
});

describe('intersect / subtract', () => {
  it('kesishma', () => {
    expect(intersect([{ start: 0, end: 10 }, { start: 20, end: 30 }], [{ start: 5, end: 25 }])).toEqual([{ start: 5, end: 10 }, { start: 20, end: 25 }]);
    expect(intersect([{ start: 0, end: 5 }], [{ start: 5, end: 9 }])).toEqual([]);
  });
  it('ayirma (vazifasiz qism)', () => {
    expect(subtract([{ start: 0, end: 10 }], [{ start: 2, end: 4 }, { start: 6, end: 7 }])).toEqual([{ start: 0, end: 2 }, { start: 4, end: 6 }, { start: 7, end: 10 }]);
    expect(subtract([{ start: 0, end: 10 }], [{ start: -5, end: 20 }])).toEqual([]);
    expect(subtract([{ start: 0, end: 10 }], [])).toEqual([{ start: 0, end: 10 }]);
  });
});
