import { describe, expect, it } from 'vitest';
import { unifiedDiff } from './config-diff.js';

describe('unifiedDiff', () => {
  it('bir xil matn: bo\'sh diff', () => {
    expect(unifiedDiff('a\nb\n', 'a\nb\n', 'x', 'y')).toEqual({ text: '', added: 0, removed: 0 });
  });

  it('qo\'shish, o\'chirish va o\'zgartirish satrlari', () => {
    const d = unifiedDiff('a\nb\nc\nd\n', 'a\nB\nc\nd\ne\n', 'local/X', 'profile/X')!;
    expect(d.added).toBe(2);
    expect(d.removed).toBe(1);
    expect(d.text).toContain('--- local/X');
    expect(d.text).toContain('+++ profile/X');
    expect(d.text).toContain('-b');
    expect(d.text).toContain('+B');
    expect(d.text).toContain('+e');
    expect(d.text).toMatch(/@@ -1,4 \+1,5 @@/);
  });

  it('bo\'sh fayldan va bo\'sh faylga', () => {
    expect(unifiedDiff('', 'x\ny\n', 'a', 'b')!.text).toContain('@@ -0,0 +1,2 @@');
    expect(unifiedDiff('x\ny\n', '', 'a', 'b')!.text).toContain('@@ -1,2 +0,0 @@');
  });

  it('uzoq masofadagi ikki o\'zgarish ikkita hunk beradi', () => {
    const a = Array.from({ length: 40 }, (_, i) => `l${i}`).join('\n') + '\n';
    const b = a.replace('l2\n', 'L2\n').replace('l35\n', 'L35\n');
    const d = unifiedDiff(a, b, 'a', 'b')!;
    expect(d.text.match(/^@@/gm)).toHaveLength(2);
  });

  it('juda katta kirishda null qaytaradi', () => {
    const big = Array.from({ length: 7000 }, (_, i) => `l${i}`).join('\n');
    expect(unifiedDiff(big, big + 'x', 'a', 'b')).toBeNull();
  });
});

/** Test yordamchisi: unified diff'ni eski matnga qo'llaydi (round-trip tekshiruvi). */
function applyUnified(oldText: string, diff: string): string {
  const old = oldText === '' ? [] : oldText.replace(/\n$/, '').split('\n');
  const out: string[] = [];
  let pos = 0;
  for (const line of diff.split('\n')) {
    const h = /^@@ -(\d+),(\d+) \+\d+,\d+ @@$/.exec(line);
    if (h) {
      const start = Number(h[2]) === 0 ? Number(h[1]) : Number(h[1]) - 1;
      while (pos < start) out.push(old[pos++]!);
      continue;
    }
    if (line.startsWith('---') || line.startsWith('+++') || line === '') continue;
    if (line[0] === ' ') {
      out.push(old[pos++]!);
    } else if (line[0] === '-') pos++;
    else if (line[0] === '+') out.push(line.slice(1));
  }
  while (pos < old.length) out.push(old[pos++]!);
  return out.length === 0 ? '' : out.join('\n') + '\n';
}

describe('unifiedDiff round-trip (tasodifiy)', () => {
  it('diff eski matnga qo\'llansa yangi matn chiqadi', () => {
    let seed = 12345;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let round = 0; round < 200; round++) {
      const n = Math.floor(rnd() * 30);
      const a = Array.from({ length: n }, () => `x${Math.floor(rnd() * 6)}`);
      const b = a.filter(() => rnd() > 0.2);
      for (let k = 0; k < Math.floor(rnd() * 5); k++) b.splice(Math.floor(rnd() * (b.length + 1)), 0, `n${Math.floor(rnd() * 4)}`);
      const oldText = a.length ? a.join('\n') + '\n' : '';
      const newText = b.length ? b.join('\n') + '\n' : '';
      const d = unifiedDiff(oldText, newText, 'a', 'b')!;
      expect(applyUnified(oldText, d.text)).toBe(newText);
    }
  });
});
