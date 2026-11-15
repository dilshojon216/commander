import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as contracts from '../src/index.ts';
import { REPO_ROOT, diff, generateAll } from './gen.ts';

const ns = contracts as unknown as Record<string, unknown>;

describe('klient kodgeneratsiyasi (4.1)', () => {
  it('generatsiya qilingan fayllar kontraktdan chetga chiqmagan (gen:check)', () => {
    const problems = diff(generateAll(ns));
    expect(problems, `Tuzatish: npm run -w libs/contracts gen:schema\n${problems.join('\n')}`).toEqual([]);
  });

  it('chiqish deterministik', () => {
    const a = generateAll(ns);
    const b = generateAll(ns);
    expect([...a.entries()]).toEqual([...b.entries()]);
  });
});

interface Manifest {
  fixtures: Record<string, string>;
  knownInvalid: Record<string, string>;
}
const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'clients/fixtures/manifest.json'), 'utf8')) as Manifest;
const load = (name: string): unknown => JSON.parse(readFileSync(join(REPO_ROOT, 'clients/fixtures', `${name}.json`), 'utf8'));
const schemaOf = (name: string): z.ZodType => {
  const s = ns[`${name}Schema`];
  if (!s) throw new Error(`manifest: ${name}Schema yo'q`);
  return s as z.ZodType;
};

describe('klient fixture\'lari kontraktga mos (Swift/Dart testlari shu fayllarni dekodlaydi)', () => {
  for (const [file, schema] of Object.entries(manifest.fixtures)) {
    it(`${file} -> ${schema}`, () => {
      const r = schemaOf(schema).safeParse(load(file));
      expect(r.success ? [] : r.error.issues).toEqual([]);
    });
  }

  it('knownInvalid: kelajakdagi qiymatlar Zod\'da rad etiladi (klient tolerantligi testi uchun)', () => {
    for (const [file, schema] of Object.entries(manifest.knownInvalid)) {
      expect(schemaOf(schema).safeParse(load(file)).success, file).toBe(false);
    }
  });
});
