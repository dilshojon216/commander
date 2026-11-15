/**
 * Unified diff (3.7 dry-run). Satr bo'yicha Myers algoritmi (O(ND)); sof, tashqi bog'liqliksiz.
 * Katta farq (D > MAX_EDITS) yoki juda ko'p satr bo'lsa `null` qaytaradi (chaqiruvchi "diff juda katta" deydi).
 */

const MAX_LINES = 6000;
const MAX_EDITS = 1500;

type Op = { t: ' ' | '+' | '-'; line: string };

function splitLines(s: string): string[] {
  if (s === '') return [];
  const lines = s.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Myers: a -> b uchun operatsiyalar ketma-ketligi. */
function myers(a: string[], b: string[]): Op[] | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDITS);
  const off = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!)) x = v[off + k + 1]!;
      else x = v[off + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    if (found < 0) v = v.slice();
  }
  if (found < 0) return null;
  // Orqaga yurish
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const vv = trace[d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && vv[off + k - 1]! < vv[off + k + 1]!) ? k + 1 : k - 1;
    const prevX = vv[off + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ t: ' ', line: a[x - 1]! });
      x--;
      y--;
    }
    if (x === prevX) ops.push({ t: '+', line: b[y - 1]! });
    else ops.push({ t: '-', line: a[x - 1]! });
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    ops.push({ t: ' ', line: a[x - 1]! });
    x--;
    y--;
  }
  return ops.reverse();
}

export interface UnifiedDiff {
  text: string;
  /** Qo'shilgan/o'chirilgan satrlar soni. */
  added: number;
  removed: number;
}

/** `null` = juda katta yoki farq juda ko'p. Bir xil matn = bo'sh `text`. */
export function unifiedDiff(oldText: string, newText: string, oldLabel: string, newLabel: string, context = 3): UnifiedDiff | null {
  if (oldText === newText) return { text: '', added: 0, removed: 0 };
  const a = splitLines(oldText);
  const b = splitLines(newText);
  if (a.length > MAX_LINES || b.length > MAX_LINES) return null;
  const ops = myers(a, b);
  if (!ops) return null;

  const out: string[] = [`--- ${oldLabel}`, `+++ ${newLabel}`];
  let added = 0;
  let removed = 0;
  for (const o of ops) {
    if (o.t === '+') added++;
    else if (o.t === '-') removed++;
  }
  // Hunk'lar: o'zgarish atrofida `context` satr
  const changeIdx: number[] = [];
  ops.forEach((o, i) => {
    if (o.t !== ' ') changeIdx.push(i);
  });
  let i = 0;
  // old/new satr raqami har op oldidan
  const oldNo: number[] = [];
  const newNo: number[] = [];
  let on = 1;
  let nn = 1;
  for (const o of ops) {
    oldNo.push(on);
    newNo.push(nn);
    if (o.t !== '+') on++;
    if (o.t !== '-') nn++;
  }
  while (i < changeIdx.length) {
    let start = Math.max(0, changeIdx[i]! - context);
    let end = Math.min(ops.length - 1, changeIdx[i]! + context);
    let j = i + 1;
    while (j < changeIdx.length && changeIdx[j]! - context <= end + 1) {
      end = Math.min(ops.length - 1, changeIdx[j]! + context);
      j++;
    }
    const slice = ops.slice(start, end + 1);
    const oc = slice.filter((o) => o.t !== '+').length;
    const nc = slice.filter((o) => o.t !== '-').length;
    const os = oc === 0 ? oldNo[start]! - 1 : oldNo[start]!;
    const ns = nc === 0 ? newNo[start]! - 1 : newNo[start]!;
    out.push(`@@ -${os},${oc} +${ns},${nc} @@`);
    for (const o of slice) out.push(`${o.t}${o.line}`);
    start = end + 1;
    i = j;
  }
  return { text: out.join('\n') + '\n', added, removed };
}
