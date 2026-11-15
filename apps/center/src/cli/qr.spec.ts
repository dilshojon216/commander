import { describe, expect, it } from 'vitest';
import { encodeQr, formatBits, renderQr, rsRemainder } from './qr.js';
import type { QrMatrix } from './qr.js';

// --- mustaqil mini-dekoder (test uchun): format bitlari, maskani olib tashlash, RS sindromlari, byte rejim ---------------------

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
}
const mul = (a: number, b: number): number => (a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!);

const BLOCKS: Record<number, { ec: number; groups: Array<[number, number]> }> = {
  1: { ec: 10, groups: [[1, 16]] }, 2: { ec: 16, groups: [[1, 28]] }, 3: { ec: 26, groups: [[1, 44]] },
  4: { ec: 18, groups: [[2, 32]] }, 5: { ec: 24, groups: [[2, 43]] }, 6: { ec: 16, groups: [[4, 27]] },
  7: { ec: 18, groups: [[4, 31]] }, 8: { ec: 22, groups: [[2, 38], [2, 39]] }, 9: { ec: 22, groups: [[3, 36], [2, 37]] },
  10: { ec: 26, groups: [[4, 43], [1, 44]] },
};
const ALIGN: Record<number, number[]> = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };

function isFunctionModule(v: number, x: number, y: number): boolean {
  const n = v * 4 + 17;
  if (x === 6 || y === 6) return true;
  if ((x < 9 && y < 9) || (x >= n - 8 && y < 9) || (x < 9 && y >= n - 8)) return true;
  if (v >= 7 && ((x >= n - 11 && y < 6) || (y >= n - 11 && x < 6))) return true;
  const p = ALIGN[v]!;
  for (const ay of p) {
    for (const ax of p) {
      if ((ax === 6 && ay === 6) || (ax === 6 && ay === p[p.length - 1]) || (ax === p[p.length - 1] && ay === 6)) continue;
      if (Math.abs(x - ax) <= 2 && Math.abs(y - ay) <= 2) return true;
    }
  }
  return false;
}

function maskFn(mask: number, x: number, y: number): boolean {
  return [
    (x + y) % 2 === 0, y % 2 === 0, x % 3 === 0, (x + y) % 3 === 0,
    (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, ((x * y) % 2) + ((x * y) % 3) === 0,
    (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ][mask]!;
}

function decode(m: QrMatrix): string {
  const n = m.size;
  const at = (x: number, y: number): number => (m.modules[y]![x] ? 1 : 0);
  // format bitlari: birinchi nusxa (chap-yuqori), ikkinchisi bilan bir xil bo'lishi shart
  let f1 = 0;
  const pos1: Array<[number, number]> = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
  pos1.forEach(([x, y], i) => { f1 |= at(x, y) << i; });
  let f2 = 0;
  for (let i = 0; i < 8; i++) f2 |= at(n - 1 - i, 8) << i;
  for (let i = 8; i < 15; i++) f2 |= at(8, n - 15 + i) << i;
  expect(f1).toBe(f2);
  expect(f1).toBe(formatBits(m.mask));
  expect((f1 ^ 0x5412) >> 13).toBe(0); // ECC M = 00
  const mask = ((f1 ^ 0x5412) >> 10) & 7;
  // ma'lumot bitlarini zigzag o'qish
  const bits: number[] = [];
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < n; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = ((right + 1) & 2) === 0 ? n - 1 - vert : vert;
        if (isFunctionModule(m.version, x, y)) continue;
        bits.push(at(x, y) ^ (maskFn(mask, x, y) ? 1 : 0));
      }
    }
  }
  const cws: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) cws.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  // deinterleave
  const info = BLOCKS[m.version]!;
  const lens = info.groups.flatMap(([c, l]) => Array<number>(c).fill(l));
  const blocks = lens.map(() => ({ data: [] as number[], ec: [] as number[] }));
  let idx = 0;
  const maxLen = Math.max(...lens);
  for (let i = 0; i < maxLen; i++) lens.forEach((l, b) => { if (i < l) blocks[b]!.data.push(cws[idx++]!); });
  for (let i = 0; i < info.ec; i++) blocks.forEach((b) => b.ec.push(cws[idx++]!));
  // RS sindromlari: butun kodsoz (data||ec) uchun alpha^0..alpha^(ec-1) da qiymat 0
  for (const b of blocks) {
    const word = [...b.data, ...b.ec];
    for (let s = 0; s < info.ec; s++) {
      let acc = 0;
      for (const c of word) acc = mul(acc, EXP[s]!) ^ c;
      expect(acc).toBe(0);
    }
  }
  const data = blocks.flatMap((b) => b.data);
  const bitStr = data.map((c) => c.toString(2).padStart(8, '0')).join('');
  expect(bitStr.slice(0, 4)).toBe('0100');
  const cc = m.version >= 10 ? 16 : 8;
  const len = parseInt(bitStr.slice(4, 4 + cc), 2);
  const out: number[] = [];
  for (let i = 0; i < len; i++) out.push(parseInt(bitStr.slice(4 + cc + i * 8, 4 + cc + i * 8 + 8), 2));
  return new TextDecoder().decode(Uint8Array.from(out));
}

describe('qr', () => {
  it('format bitlari (ECC M): standart jadval qiymatlari', () => {
    expect(formatBits(0).toString(2).padStart(15, '0')).toBe('101010000010010');
    expect(formatBits(1).toString(2).padStart(15, '0')).toBe('101000100100101');
    expect(formatBits(7).toString(2).padStart(15, '0')).toBe('100101010100000');
  });

  it("Reed-Solomon: ISO 18004 namunasi ('01234567' versiya 1-M ma'lumoti) EC kodsozlari", () => {
    // Annex I (versiya 1-M, 16 ma'lumot kodsozi): 00010000 00100000 00001100 01010110 01100001 10000000 11101100 ...
    const data = [0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11];
    // Annex I: 10 ta EC kodsozi (L emas, M: 10 EC) = A5 24 D4 C1 ED 36 C7 87 2C 55
    expect(rsRemainder(data, 10)).toEqual([0xa5, 0x24, 0xd4, 0xc1, 0xed, 0x36, 0xc7, 0x87, 0x2c, 0x55]);
  });

  it('turli uzunliklar: versiya tanlash, dekod aylanishi (round-trip) va RS sindromlari', () => {
    const cases: Array<[string, number]> = [
      ['A', 1],
      ['x'.repeat(14), 1],
      ['x'.repeat(15), 2],
      ['commander://pair?c=https%3A%2F%2Fmac.tail1234.ts.net&code=ABCDE-FGHJK', 4],
      [`commander://pair?c=https%3A%2F%2Fmac.tail1234.ts.net&code=ABCDE-FGHJK&fp=${'a'.repeat(64)}`, 6],
      ['Ünicode ✓ ' + 'z'.repeat(150), 9],
      ['q'.repeat(210), 10],
    ];
    for (const [text, minVersion] of cases) {
      const m = encodeQr(text);
      expect(m.size).toBe(m.version * 4 + 17);
      expect(m.version).toBeGreaterThanOrEqual(minVersion);
      expect(decode(m)).toBe(text);
    }
  });

  it('versiyalar bo\'yicha chegara: har versiyaning sig\'imi to\'liq ishlatiladi', () => {
    const cap = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213];
    cap.forEach((c, i) => {
      expect(encodeQr('b'.repeat(c)).version).toBe(i + 1);
      expect(decode(encodeQr('b'.repeat(c)))).toBe('b'.repeat(c));
    });
    expect(() => encodeQr('b'.repeat(215))).toThrow(/juda uzun/);
  });

  it('finder naqshlari, timing va qorong\'i modul joyida', () => {
    const m = encodeQr('commander');
    const n = m.size;
    const finder = (ox: number, oy: number): void => {
      for (let dy = 0; dy < 7; dy++) {
        for (let dx = 0; dx < 7; dx++) {
          const d = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
          expect(m.modules[oy + dy]![ox + dx]).toBe(d !== 2);
        }
      }
    };
    finder(0, 0);
    finder(n - 7, 0);
    finder(0, n - 7);
    for (let i = 8; i < n - 8; i++) {
      expect(m.modules[6]![i]).toBe(i % 2 === 0);
      expect(m.modules[i]![6]).toBe(i % 2 === 0);
    }
    expect(m.modules[n - 8]![8]).toBe(true);
  });

  it('renderQr: faqat ruxsat etilgan belgilar, balandlik = ceil((n + 2*quiet)/2)', () => {
    const m = encodeQr('hello');
    const out = renderQr(m, 2);
    const lines = out.split('\n');
    expect(lines.length).toBe(Math.ceil((m.size + 4) / 2));
    for (const l of lines) {
      expect(l.length).toBe(m.size + 4);
      expect(l).toMatch(/^[▀▄█ ]+$/);
    }
    // quiet zona yuqori qatori: hammasi och (to'ldirilgan)
    expect(lines[0]).toBe('█'.repeat(m.size + 4));
  });
});
