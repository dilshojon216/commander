// Web dashboard'dagi TypeScript modulini (apps/dashboard/lib/*.ts) Vite bilan yig'ib, yuklaydi: native generatorlar
// (gen-error-texts, gen-elevation-rules) web manbasidan to'g'ridan-to'g'ri o'qiydi, shuning uchun qo'lda nusxa YO'Q.
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const dashboard = join(repoRoot, 'apps/dashboard');

/** `lib/<name>.ts` ni yig'ib, modulni qaytaradi (barcha bog'liqliklar ichiga olinadi). */
export async function loadWebModule(name) {
  const result = await build({
    root: dashboard,
    configFile: false,
    logLevel: 'silent',
    build: { write: false, minify: false, ssr: join(dashboard, 'lib', `${name}.ts`), rollupOptions: { output: { format: 'es' } } },
    ssr: { noExternal: true },
    resolve: { alias: { '@': dashboard } },
  });
  const chunk = (Array.isArray(result) ? result[0] : result).output.find((o) => o.type === 'chunk');
  const file = join(tmpdir(), `commander-web-${name}-${process.pid}.mjs`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, chunk.code);
  return import(file);
}
