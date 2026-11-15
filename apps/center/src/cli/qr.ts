/**
 * Minimal QR Code kodlovchi (ISO/IEC 18004): byte rejim, versiyalar 1-10, xato tuzatish darajasi M.
 * Tashqi kutubxonasiz: faqat admin CLI pairing QR'i uchun (URL ~ 100 bayt). Terminalga `renderQr()` bilan chiqariladi.
 */

const ECC_M_FORMAT_BITS = 0b00;
/** Versiya (1..10) -> [ma'lumot kodsozlari, blokdagi EC kodsozlari, [blok soni, blokdagi ma'lumot] guruhlari]. ECC M. */
const VERSIONS_M: ReadonlyArray<{ data: number; ec: number; groups: ReadonlyArray<readonly [number, number]> }> = [
  { data: 16, ec: 10, groups: [[1, 16]] },
  { data: 28, ec: 16, groups: [[1, 28]] },
  { data: 44, ec: 26, groups: [[1, 44]] },
  { data: 64, ec: 18, groups: [[2, 32]] },
  { data: 86, ec: 24, groups: [[2, 43]] },
  { data: 108, ec: 16, groups: [[4, 27]] },
  { data: 124, ec: 18, groups: [[4, 31]] },
  { data: 154, ec: 22, groups: [[2, 38], [2, 39]] },
  { data: 182, ec: 22, groups: [[3, 36], [2, 37]] },
  { data: 216, ec: 26, groups: [[4, 43], [1, 44]] },
];
const ALIGN_POSITIONS: ReadonlyArray<readonly number[]> = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

// --- GF(256) / Reed-Solomon ------------------------------------------------------------------

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
const gfMul = (a: number, b: number): number => (a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!);

function rsGenerator(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] = (next[j] ?? 0) ^ gfMul(poly[j]!, 1);
      next[j + 1] = (next[j + 1] ?? 0) ^ gfMul(poly[j]!, EXP[i]!);
    }
    poly = next;
  }
  return poly; // yuqori darajadan boshlab, bosh koeffitsient 1
}

export function rsRemainder(data: readonly number[], ecLen: number): number[] {
  const gen = rsGenerator(ecLen);
  const rem = new Array<number>(ecLen).fill(0);
  for (const b of data) {
    const factor = b ^ rem.shift()!;
    rem.push(0);
    for (let i = 0; i < ecLen; i++) rem[i] = rem[i]! ^ gfMul(gen[i + 1]!, factor);
  }
  return rem;
}

// --- Format / versiya bitlari ---------------------------------------------------------------

export function formatBits(mask: number): number {
  const data = (ECC_M_FORMAT_BITS << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

function versionBits(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

// --- Matritsa -------------------------------------------------------------------------------

export interface QrMatrix {
  version: number;
  size: number;
  mask: number;
  /** modules[y][x] === true: qora. */
  modules: boolean[][];
}

class Grid {
  readonly size: number;
  readonly modules: boolean[][];
  readonly isFunction: boolean[][];
  constructor(readonly version: number) {
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.isFunction = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.drawFunctionPatterns();
  }

  private set(x: number, y: number, dark: boolean): void {
    this.modules[y]![x] = dark;
    this.isFunction[y]![x] = true;
  }

  private drawFunctionPatterns(): void {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }
    for (const [cx, cy] of [[3, 3], [n - 4, 3], [3, n - 4]] as const) {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || y < 0 || x >= n || y >= n) continue;
          const dist = Math.max(Math.abs(dx), Math.abs(dy));
          this.set(x, y, dist !== 2 && dist !== 4);
        }
      }
    }
    const pos = ALIGN_POSITIONS[this.version - 1]!;
    for (const ay of pos) {
      for (const ax of pos) {
        const overlapsFinder = (ax === 6 && ay === 6) || (ax === 6 && ay === pos[pos.length - 1]) || (ax === pos[pos.length - 1] && ay === 6);
        if (overlapsFinder) continue;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) this.set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
    this.drawFormat(0); // zaxira joyi (keyin qayta chiziladi)
    if (this.version >= 7) {
      const bits = versionBits(this.version);
      for (let i = 0; i < 18; i++) {
        const dark = ((bits >>> i) & 1) === 1;
        const a = n - 11 + (i % 3);
        const b = Math.floor(i / 3);
        this.set(a, b, dark);
        this.set(b, a, dark);
      }
    }
  }

  drawFormat(mask: number): void {
    const n = this.size;
    const bits = formatBits(mask);
    const bit = (i: number): boolean => ((bits >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) this.set(8, i, bit(i));
    this.set(8, 7, bit(6));
    this.set(8, 8, bit(7));
    this.set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) this.set(n - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.set(8, n - 15 + i, bit(i));
    this.set(8, n - 8, true); // qorong'i modul
  }

  placeData(codewords: readonly number[]): void {
    const n = this.size;
    let bitIdx = 0;
    const total = codewords.length * 8;
    for (let right = n - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < n; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? n - 1 - vert : vert;
          if (this.isFunction[y]![x] || bitIdx >= total) continue;
          this.modules[y]![x] = ((codewords[bitIdx >>> 3]! >>> (7 - (bitIdx & 7))) & 1) === 1;
          bitIdx++;
        }
      }
    }
  }

  applyMask(mask: number): void {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (this.isFunction[y]![x]) continue;
        let invert: boolean;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        }
        if (invert) this.modules[y]![x] = !this.modules[y]![x];
      }
    }
  }

  penalty(): number {
    const n = this.size;
    const m = this.modules;
    let score = 0;
    const runScore = (line: boolean[]): number => {
      let s = 0;
      let run = 1;
      for (let i = 1; i <= line.length; i++) {
        if (i < line.length && line[i] === line[i - 1]) run++;
        else {
          if (run >= 5) s += 3 + (run - 5);
          run = 1;
        }
      }
      // 1:1:3:1:1 naqsh (4 bo'sh bilan)
      const str = line.map((b) => (b ? '1' : '0')).join('');
      for (const pat of ['10111010000', '00001011101']) {
        for (let i = str.indexOf(pat); i !== -1; i = str.indexOf(pat, i + 1)) s += 40;
      }
      return s;
    };
    for (let y = 0; y < n; y++) score += runScore(m[y]!);
    for (let x = 0; x < n; x++) score += runScore(m.map((row) => row[x]!));
    for (let y = 0; y < n - 1; y++) {
      for (let x = 0; x < n - 1; x++) {
        const c = m[y]![x];
        if (c === m[y]![x + 1] && c === m[y + 1]![x] && c === m[y + 1]![x + 1]) score += 3;
      }
    }
    let dark = 0;
    for (const row of m) for (const c of row) if (c) dark++;
    const pct = (dark * 100) / (n * n);
    score += Math.floor(Math.abs(pct - 50) / 5) * 10;
    return score;
  }
}

function buildDataCodewords(bytes: Uint8Array, version: number): number[] {
  const info = VERSIONS_M[version - 1]!;
  const bits: number[] = [];
  const push = (value: number, len: number): void => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, version >= 10 ? 16 : 8);
  for (const b of bytes) push(b, 8);
  const capacityBits = info.data * 8;
  push(0, Math.min(4, capacityBits - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let pad = 0xec; out.length < info.data; pad ^= 0xec ^ 0x11) out.push(pad);
  return out;
}

function interleave(data: readonly number[], version: number): number[] {
  const info = VERSIONS_M[version - 1]!;
  const blocks: Array<{ data: number[]; ec: number[] }> = [];
  let off = 0;
  for (const [count, len] of info.groups) {
    for (let i = 0; i < count; i++) {
      const d = data.slice(off, off + len);
      off += len;
      blocks.push({ data: d, ec: rsRemainder(d, info.ec) });
    }
  }
  const out: number[] = [];
  const maxLen = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < maxLen; i++) for (const b of blocks) if (i < b.data.length) out.push(b.data[i]!);
  for (let i = 0; i < info.ec; i++) for (const b of blocks) out.push(b.ec[i]!);
  return out;
}

/** UTF-8 matnni QR matritsasiga kodlaydi (eng kichik versiya 1-10, ECC M, eng kam jarimali maska). */
export function encodeQr(text: string): QrMatrix {
  const bytes = new TextEncoder().encode(text);
  let version = 0;
  for (let v = 1; v <= 10; v++) {
    const headerBits = 4 + (v >= 10 ? 16 : 8);
    if (headerBits + bytes.length * 8 <= VERSIONS_M[v - 1]!.data * 8) {
      version = v;
      break;
    }
  }
  if (version === 0) throw new Error(`QR: matn juda uzun (${bytes.length} bayt; versiya 10-M chegarasi oshdi)`);

  const codewords = interleave(buildDataCodewords(bytes, version), version);
  let best: Grid | null = null;
  let bestMask = 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const g = new Grid(version);
    g.placeData(codewords);
    g.applyMask(mask);
    g.drawFormat(mask);
    const s = g.penalty();
    if (s < bestScore) {
      best = g;
      bestScore = s;
      bestMask = mask;
    }
  }
  return { version, size: best!.size, mask: bestMask, modules: best!.modules };
}

/**
 * Terminal uchun yarim-blok belgilar (`▀ ▄ █` va bo'shliq): har ikki matritsa qatori = bitta matn qatori.
 * Och (fon) modullar TO'LDIRILGAN belgi, qora modullar bo'sh: qorong'i terminalda to'g'ri (och fonda qora modul)
 * ko'rinadi va telefon kameralari skanerlaydi. Och temada ko'rinish teskari bo'ladi (aksariyat skanerlar baribir o'qiydi).
 * `quiet`: atrofdagi bo'sh zona (modul), kamida 2 tavsiya.
 */
export function renderQr(matrix: QrMatrix, quiet = 2): string {
  const n = matrix.size;
  const dark = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < n && y < n && matrix.modules[y]![x]!;
  const lines: string[] = [];
  for (let y = -quiet; y < n + quiet; y += 2) {
    let line = '';
    for (let x = -quiet; x < n + quiet; x++) {
      const top = !dark(x, y);
      const bottom = !dark(x, y + 1);
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    lines.push(line);
  }
  return lines.join('\n');
}
