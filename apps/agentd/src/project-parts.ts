import { closeSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { PART_LIMITS, PART_PATH_RE, PLAN_LIMITS, parsePlanMarkdown } from '@commander/contracts';
import type { PlanItem, SnapshotPart, SnapshotPlanItem } from '@commander/contracts';
import { isInsideSensitive } from './policy.js';
import { redact } from './redact.js';
import { trimTrailingReplacement } from './project-files.js';

/**
 * Loyiha qismlarini topish va o'qish (task 6.15). FAQAT o'qiydi: hech narsa yozmaydi, hech qanday jarayon ishga tushirmaydi.
 *
 * Topish: loyiha ildizi va uning pastki papkalari (ildizdan <= 2 daraja). Node_modules/.git/dist/build/vendor va nuqta bilan
 * boshlanuvchi papkalar, symlink'lar (papka ham, fayl ham), realpath'i ildizdan tashqarida yoki maxfiy papka (`~/.ssh` ...) ichida
 * bo'lganlar o'tkazib yuboriladi. Reja fayli nomi (katta-kichik harfga befarq): `TASKS.md`, `TODO.md`, `*TODO*.md`; papka ichidagi
 * `docs/TASKS.md` ham shu papkaniki. ILDIZ o'zi qism emas (uning reja fayli eski oqim bilan o'qiladi: `tasksMd`).
 *
 * Parse agentd'da (fayl 1.5 MB gacha bo'lishi mumkin: markazga matn yuborilmaydi, faqat qisqartirilgan band ro'yxati va sanoq),
 * sarlavhalar `redact()` dan o'tadi (CLAUDE.md qoida 5).
 */

const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', 'coverage', 'vendor', 'target', 'venv', '__pycache__', 'pods', 'bower_components', 'deriveddata', 'obj', 'bin', 'tmp', 'temp',
]);
const MAX_VISITS = 5_000;
const PLAN_NAME = /^(?:tasks|todo)\.md$|^.*todo.*\.md$/i;
const TASKS_NAME = /^tasks\.md$/i;

export interface PartDiscovery {
  /** Ildizga nisbiy yo'l (`web-app`, `apps/center`). */
  path: string;
  name: string;
  /** LOYIHA ILDIZIGA nisbiy reja fayllari, ustuvorlik tartibida. */
  planFiles: string[];
}

export interface PartsOptions {
  /** Sinov uchun: maxfiy papkalar ro'yxati (default `sensitiveDirs()`). */
  sensitive?: readonly string[];
  maxPlanFileBytes?: number;
}

function insideRoot(realRoot: string, realPath: string): boolean {
  const rel = relative(realRoot, realPath);
  return rel !== '' && !rel.startsWith('..') && !rel.split(sep).includes('..') && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel);
}

/** Ustuvorlik: `docs/TASKS.md`, `TASKS.md`, `TODO.md`, boshqa `*TODO*.md` (alifbo). */
function filePriority(rel: string): number {
  const base = basename(rel).toLowerCase();
  if (rel.toLowerCase().endsWith('docs/tasks.md')) return 0;
  if (base === 'tasks.md') return 1;
  if (base === 'todo.md') return 2;
  return 3;
}

function plainFile(realRoot: string, full: string, sensitive: readonly string[] | undefined): boolean {
  try {
    const st = lstatSync(full);
    if (!st.isFile() || st.size === 0) return false;
    const real = realpathSync(full);
    return insideRoot(realRoot, real) && !isInsideSensitive(real, undefined, sensitive);
  } catch {
    return false;
  }
}

function listPlanFiles(realRoot: string, dir: string, relDir: string, sensitive: readonly string[] | undefined): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  const inDocs = basename(dir).toLowerCase() === 'docs';
  for (const e of entries) {
    if (!e.isFile() || e.isSymbolicLink() || !PLAN_NAME.test(e.name)) continue;
    // `docs/TASKS.md` ota papkaniki: `docs` papkasining o'zi uchun TASKS.md hisoblanmaydi
    if (inDocs && TASKS_NAME.test(e.name)) continue;
    if (plainFile(realRoot, join(dir, e.name), sensitive)) out.push(`${relDir}/${e.name}`);
  }
  // docs/TASKS.md (papkaning o'ziga tegishli)
  let docs: string | null = null;
  try {
    for (const e of entries) if (e.isDirectory() && !e.isSymbolicLink() && e.name.toLowerCase() === 'docs') docs = e.name;
    if (docs) {
      for (const f of readdirSync(join(dir, docs), { withFileTypes: true })) {
        if (f.isFile() && !f.isSymbolicLink() && TASKS_NAME.test(f.name) && plainFile(realRoot, join(dir, docs, f.name), sensitive)) out.push(`${relDir}/${docs}/${f.name}`);
      }
    }
  } catch {
    /* docs o'qilmadi */
  }
  return out
    .slice(0, PART_LIMITS.maxPlanFiles * 2)
    .sort((a, b) => filePriority(a) - filePriority(b) || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, PART_LIMITS.maxPlanFiles);
}

/** Loyiha ildizi ostidagi qismlar (yo'l bo'yicha alifbo tartibida; ildizning o'zi kirmaydi). */
export function discoverParts(root: string, opts: PartsOptions = {}): PartDiscovery[] {
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return [];
  }
  const found: PartDiscovery[] = [];
  const slugs = new Set<string>();
  let visits = 0;

  const subdirs = (dir: string): string[] => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const names: string[] = [];
    for (const e of entries) {
      if (++visits > MAX_VISITS) break;
      if (!e.isDirectory() || e.isSymbolicLink()) continue;
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name.toLowerCase())) continue;
      names.push(e.name);
    }
    return names.sort();
  };

  const consider = (dir: string, rel: string): void => {
    if (found.length >= PART_LIMITS.maxParts || !PART_PATH_RE.test(rel)) return;
    try {
      const real = realpathSync(dir);
      if (!insideRoot(realRoot, real) || isInsideSensitive(real, undefined, opts.sensitive)) return;
    } catch {
      return;
    }
    const slug = rel.toLowerCase();
    if (slugs.has(slug)) return;
    const planFiles = listPlanFiles(realRoot, dir, rel, opts.sensitive);
    if (planFiles.length === 0) return;
    slugs.add(slug);
    found.push({ path: rel, name: basename(rel), planFiles });
  };

  for (const a of subdirs(realRoot)) {
    consider(join(realRoot, a), a);
    for (const b of subdirs(join(realRoot, a))) consider(join(realRoot, a, b), `${a}/${b}`);
  }
  return found.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
}

function readPlanText(realRoot: string, rel: string, maxBytes: number): { text: string; truncated: boolean } | null {
  try {
    const full = join(realRoot, rel);
    const st = lstatSync(full);
    if (!st.isFile()) return null;
    const size = Math.min(st.size, maxBytes);
    const buf = Buffer.alloc(size);
    const fd = openSync(full, 'r');
    let read = 0;
    try {
      while (read < size) {
        const n = readSync(fd, buf, read, size - read, read);
        if (n <= 0) break;
        read += n;
      }
    } finally {
      closeSync(fd);
    }
    let text = buf.subarray(0, read).toString('utf8');
    const truncated = st.size > maxBytes;
    if (truncated) text = trimTrailingReplacement(text);
    return { text, truncated };
  } catch {
    return null;
  }
}

const toWire = (i: PlanItem): SnapshotPlanItem => ({
  key: i.key,
  title: redact(i.title).slice(0, PLAN_LIMITS.maxTitle + 1),
  ...(i.phase ? { phase: redact(i.phase).slice(0, PLAN_LIMITS.maxPhase) } : {}),
  status: i.status,
  ...(i.size ? { size: i.size } : {}),
  ...(i.doneOn ? { doneOn: i.doneOn } : {}),
});

/**
 * Qismning reja fayllarini o'qib bitta ro'yxatga birlashtiradi. Bir nechta fayl bo'lsa faza oldiga fayl nomi qo'yiladi va
 * boshqa fayldagi takror kalit `-2`, `-3` bilan farqlanadi (birinchi fayl ustun).
 */
export function readPart(root: string, d: PartDiscovery, opts: PartsOptions = {}): SnapshotPart {
  let realRoot = root;
  try {
    realRoot = realpathSync(root);
  } catch {
    /* ildiz yo'q: o'qish baribir bo'sh */
  }
  const maxBytes = opts.maxPlanFileBytes ?? PART_LIMITS.maxPlanFileBytes;
  const multi = d.planFiles.length > 1;
  const items: SnapshotPlanItem[] = [];
  const seen = new Set<string>();
  const counts = { todo: 0, doing: 0, done: 0, unknown: 0, total: 0 };
  let readTruncated = false;
  let itemsTruncated = false;
  const files: string[] = [];

  for (const rel of d.planFiles) {
    const got = readPlanText(realRoot, rel, maxBytes);
    if (!got) continue;
    files.push(rel);
    if (got.truncated) readTruncated = true;
    const parsed = parsePlanMarkdown(got.text);
    if (parsed.truncated) itemsTruncated = true;
    counts.todo += parsed.counts.todo;
    counts.doing += parsed.counts.doing;
    counts.done += parsed.counts.done;
    counts.unknown += parsed.counts.unknown;
    counts.total += parsed.counts.total;
    const label = basename(rel).replace(/\.md$/i, '');
    for (const it of parsed.items) {
      if (items.length >= PLAN_LIMITS.maxItems) {
        itemsTruncated = true;
        break;
      }
      let key = it.key;
      for (let n = 2; seen.has(key); n++) key = `${it.key.slice(0, PLAN_LIMITS.maxKey - String(n).length - 1)}-${n}`;
      seen.add(key);
      const wire = toWire({ ...it, key, phase: multi ? `${label} › ${it.phase ?? ''}`.replace(/ › $/, '').slice(0, PLAN_LIMITS.maxPhase) : it.phase });
      items.push(wire);
    }
  }
  if (items.length < counts.total) itemsTruncated = true;
  return { path: d.path, name: d.name, planFiles: files.length > 0 ? files : d.planFiles, counts, items, itemsTruncated, readTruncated };
}

/** Barcha qismlar (topish + o'qish). */
export function collectParts(root: string, opts: PartsOptions = {}): SnapshotPart[] {
  return discoverParts(root, opts).map((d) => readPart(root, d, opts));
}

const jsonBytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v));

/**
 * Qismlar JSON hajmini `budget` ga sig'dirish (progress sanoqlari saqlanadi, faqat bandlar ro'yxati qisqaradi):
 *  1. sarlavhalar 70 belgigacha;  2. fazalar olib tashlanadi;  3. eng katta qismdan avval bajarilgan bandlar (eng eskisi),
 *  keyin boshqalar tashlanadi (`itemsTruncated`).
 */
export function fitParts(parts: SnapshotPart[], budget: number): SnapshotPart[] {
  let out = parts.map((p) => ({ ...p, items: p.items.map((i) => ({ ...i })) }));
  if (jsonBytes(out) <= budget) return out;
  out = out.map((p) => ({ ...p, items: p.items.map((i) => (i.title.length > 70 ? { ...i, title: `${i.title.slice(0, 69).trimEnd()}…` } : i)) }));
  if (jsonBytes(out) <= budget) return out;
  out = out.map((p) => ({ ...p, items: p.items.map(({ phase: _phase, ...rest }) => rest) }));
  let size = jsonBytes(out);
  while (size > budget) {
    let target = -1;
    for (let i = 0; i < out.length; i++) if (out[i]!.items.length > 0 && (target === -1 || out[i]!.items.length > out[target]!.items.length)) target = i;
    if (target === -1) break;
    const p = out[target]!;
    // ~10% ni yoki kamida 1 ta; bajarilganlardan boshlab
    const drop = Math.max(1, Math.floor(p.items.length / 10));
    const keep = [...p.items];
    let removed = 0;
    for (let i = 0; i < keep.length && removed < drop; ) {
      if (keep[i]!.status === 'done') {
        keep.splice(i, 1);
        removed++;
      } else i++;
    }
    while (removed < drop && keep.length > 0) {
      keep.pop();
      removed++;
    }
    out[target] = { ...p, items: keep, itemsTruncated: true };
    size = jsonBytes(out);
  }
  return out;
}
