// agentd + cc-hook + cc-statusline + cc-mcp ni bog'liqliksiz bitta-fayl ESM bundle'larga yig'adi (Ubuntu'ga nusxalash uchun).
import { build } from 'rolldown';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const outDir = join(root, 'dist-bundle');
mkdirSync(outDir, { recursive: true });
for (const [name, entry] of [
  ['agentd', 'apps/agentd/src/cli.ts'],
  ['cc-hook', 'libs/hooks/src/cc-hook.ts'],
  ['cc-statusline', 'libs/hooks/src/cc-statusline.ts'],
  ['cc-mcp', 'libs/hooks/src/cc-mcp.ts'],
]) {
  await build({
    input: join(root, entry),
    platform: 'node',
    resolve: { extensionAlias: { '.js': ['.ts', '.js'] } },
    output: { file: join(outDir, `${name}.mjs`), format: 'esm' },
    external: [/^node:/],
    logLevel: 'warn',
  });
}
process.stdout.write(`bundle tayyor: ${outDir}\n`);
