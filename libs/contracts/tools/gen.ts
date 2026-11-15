/**
 * Kontraktdan klient paketlarini generatsiya qilish (task 4.1).
 *
 *   node tools/gen.ts           # yozadi (dist/ dan o'qiydi: avval `npm run build`)
 *   node tools/gen.ts --check   # diskdagi natija bilan solishtiradi, farq bo'lsa exit 1
 *
 * Zod -> JSON Schema (generated/json-schema/*.json) -> Swift va Dart modellar. Chiqish deterministik.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectConstants, dartConstants, flatten, swiftConstants } from './constants.ts';
import { emitDart } from './emit-dart.ts';
import { emitSwift } from './emit-swift.ts';
import { analyze } from './ir.ts';
import { generateJsonSchemas, renderJsonSchema } from './json-schema.ts';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const SCHEMA_DIR = 'libs/contracts/generated/json-schema';
export const CONSTANTS_FILE = 'libs/contracts/generated/constants.json';
export const SWIFT_FILE = 'clients/swift/CommanderContracts/Sources/CommanderContracts/Generated.swift';
export const DART_FILE = 'clients/dart/commander_contracts/lib/src/generated.dart';

/** Repo ildizidan nisbiy yo'l -> fayl matni. */
export function generateAll(ns: Record<string, unknown>): Map<string, string> {
  const out = new Map<string, string>();
  const files = generateJsonSchemas(ns);
  for (const f of files) out.set(`${SCHEMA_DIR}/${f.name}.json`, renderJsonSchema(f));
  const consts = collectConstants(ns);
  out.set(CONSTANTS_FILE, JSON.stringify(consts, null, 2) + '\n');
  // Kodgenerator JSON Schema'larni DISKDAN emas, xotiradan (aynan yozilgan matndan) o'qiydi.
  const parsed = files.map((f) => ({ name: f.name, schema: JSON.parse(renderJsonSchema(f)) as Record<string, unknown> }));
  const decls = analyze(parsed);
  const flat = flatten(JSON.parse(JSON.stringify(consts)) as Record<string, unknown>);
  out.set(SWIFT_FILE, emitSwift(decls, swiftConstants(flat)));
  out.set(DART_FILE, emitDart(decls, dartConstants(flat)));
  return out;
}

/** Generatsiya qilinadigan kataloglar: ichidagi ortiqcha (eskirgan) fayllar ham drift hisoblanadi. */
const OWNED_DIRS = [SCHEMA_DIR];

export function diff(outputs: Map<string, string>, root: string = REPO_ROOT): string[] {
  const problems: string[] = [];
  for (const [rel, content] of outputs) {
    const abs = join(root, rel);
    if (!existsSync(abs)) problems.push(`yo'q: ${rel}`);
    else if (readFileSync(abs, 'utf8') !== content) problems.push(`farq: ${rel}`);
  }
  for (const dir of OWNED_DIRS) {
    const abs = join(root, dir);
    if (!existsSync(abs)) continue;
    for (const f of readdirSync(abs)) {
      const rel = `${dir}/${f}`;
      if (!outputs.has(rel)) problems.push(`ortiqcha: ${rel}`);
    }
  }
  return problems;
}

export function write(outputs: Map<string, string>, root: string = REPO_ROOT): void {
  for (const dir of OWNED_DIRS) {
    const abs = join(root, dir);
    if (!existsSync(abs)) continue;
    for (const f of readdirSync(abs)) if (!outputs.has(`${dir}/${f}`)) rmSync(join(abs, f));
  }
  for (const [rel, content] of outputs) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

async function main(): Promise<void> {
  const distEntry = join(REPO_ROOT, 'libs/contracts/dist/index.js');
  if (!existsSync(distEntry)) throw new Error('libs/contracts/dist yo\'q: avval `npm run -w libs/contracts build`');
  const ns = (await import(distEntry)) as Record<string, unknown>;
  const outputs = generateAll(ns);
  if (process.argv.includes('--check')) {
    const problems = diff(outputs);
    if (problems.length > 0) {
      process.stderr.write(`Generatsiya qilingan fayllar kontraktdan chetga chiqqan:\n${problems.map((p) => `  ${p}`).join('\n')}\nTuzatish: npm run -w libs/contracts gen:schema\n`);
      process.exit(1);
    }
    process.stdout.write(`gen:check OK (${outputs.size} fayl)\n`);
    return;
  }
  write(outputs);
  process.stdout.write(`yozildi: ${outputs.size} fayl (${relative(REPO_ROOT, join(REPO_ROOT, SCHEMA_DIR))})\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
