import * as nodePath from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeApprovalTarget } from './approval-target.js';
import type { TargetFs } from './approval-target.js';

/** Soxta fayl tizimi: `links` symlink'lar (yo'l -> haqiqiy yo'l), `existing` mavjud yo'llar. */
function fakeFs(existing: string[], links: Record<string, string> = {}): TargetFs {
  const set = new Set(existing);
  return {
    realpath(p: string): string {
      // eng uzun symlink prefiksini almashtiradi
      for (const [from, to] of Object.entries(links)) {
        if (p === from || p.startsWith(`${from}/`)) return to + p.slice(from.length);
      }
      if (set.has(p)) return p;
      throw new Error('ENOENT');
    },
  };
}

const CWD = '/work/proj';
const fs = fakeFs(['/', '/work', CWD, `${CWD}/src`, `${CWD}/src/a.ts`], { [`${CWD}/link-out`]: '/etc', [`${CWD}/link-in`]: `${CWD}/src` });
const t = (tool: string, input: unknown, cwd: string | null = CWD) => computeApprovalTarget(tool, input, cwd, { fs, path: nodePath.posix });

describe('computeApprovalTarget', () => {
  it("fayl bo'lmagan vositalar uchun maslahat yo'q (Bash, WebFetch, mcp)", () => {
    expect(t('Bash', { command: 'ls' })).toBeUndefined();
    expect(t('WebFetch', { url: 'https://x' })).toBeUndefined();
    expect(t('mcp__a__b', {})).toBeUndefined();
  });
  it("mutlaq va nisbiy yo'l cwd'ga nisbatan normallashadi", () => {
    expect(t('Edit', { file_path: `${CWD}/src/a.ts`, old_string: 'secret-body', new_string: 'x' })).toEqual({ path: 'src/a.ts', insideCwd: true });
    expect(t('Write', { file_path: 'src/new/b.ts', content: 'xxx' })).toEqual({ path: 'src/new/b.ts', insideCwd: true });
    expect(t('Edit', { file_path: `${CWD}/src/../src/./a.ts` })).toEqual({ path: 'src/a.ts', insideCwd: true });
    expect(t('NotebookEdit', { notebook_path: `${CWD}/n.ipynb` })).toEqual({ path: 'n.ipynb', insideCwd: true });
  });
  it("cwd tashqarisi, '..' va mutlaq tashqi yo'l: path yubormaydi", () => {
    expect(t('Edit', { file_path: '/etc/passwd' })).toEqual({ path: null, insideCwd: false });
    expect(t('Edit', { file_path: '../other/x.ts' })).toEqual({ path: null, insideCwd: false });
    expect(t('Edit', { file_path: `${CWD}/../x` })).toEqual({ path: null, insideCwd: false });
    expect(t('Edit', { file_path: '/work/proj-evil/x' })).toEqual({ path: null, insideCwd: false });
  });
  it("symlink: tashqariga olib boruvchi = tashqarida; ichkariga = ichkarida (haqiqiy yo'l)", () => {
    expect(t('Write', { file_path: `${CWD}/link-out/passwd` })).toEqual({ path: null, insideCwd: false });
    expect(t('Edit', { file_path: `${CWD}/link-in/a.ts` })).toEqual({ path: 'src/a.ts', insideCwd: true });
  });
  it("noaniq kiritma: matn bo'lmagan, bo'sh, NUL, ~, cwd yo'q", () => {
    expect(t('Edit', { file_path: 42 })).toEqual({ path: null, insideCwd: false });
    expect(t('Edit', {})).toEqual({ path: null, insideCwd: false });
    expect(t('Edit', null)).toEqual({ path: null, insideCwd: false });
    expect(t('Edit', { file_path: 'a\0b' })).toEqual({ path: null, insideCwd: false });
    expect(t('Edit', { file_path: '~/x' })).toEqual({ path: null, insideCwd: false });
    expect(t('Edit', { file_path: 'a.ts' }, null)).toEqual({ path: null, insideCwd: false });
    expect(t('Edit', { file_path: 'a.ts' }, 'relative/cwd')).toEqual({ path: null, insideCwd: false });
  });
  it("Glob/Grep: path yo'q = cwd ('.'); pattern/regex natijaga kirmaydi", () => {
    expect(t('Glob', { pattern: '**/*.ts' })).toEqual({ path: '.', insideCwd: true });
    expect(t('Grep', { pattern: 'TOKEN=abcd', path: `${CWD}/src` })).toEqual({ path: 'src', insideCwd: true });
    expect(t('Grep', { pattern: 'x', path: '/etc' })).toEqual({ path: null, insideCwd: false });
  });
  it("sir shaklidagi yo'l nomi yuborilmaydi", () => {
    expect(t('Edit', { file_path: `${CWD}/sk-ant-abcdefghijklmnop123.txt` })).toEqual({ path: null, insideCwd: false });
  });
  it("natija faqat {path, insideCwd}: xom matn (old_string/content/command) sizmaydi", () => {
    const r = t('Edit', { file_path: 'a.ts', old_string: 'HIDDEN-OLD', new_string: 'HIDDEN-NEW', content: 'HIDDEN-C' });
    expect(Object.keys(r!).sort()).toEqual(['insideCwd', 'path']);
    expect(JSON.stringify(r)).not.toContain('HIDDEN');
  });
});
