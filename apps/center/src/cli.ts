import 'reflect-metadata';
import { parseArgs } from 'node:util';
import { NestFactory } from '@nestjs/core';
import { CliModule } from './cli/cli.module.js';
import { runCli } from './cli/commands.js';

/**
 * Admin CLI: `docker compose exec app node dist/cli.js <buyruq>` (yoki dev'da `npm run cli -- ...`).
 * HTTP admin yuzasi yo'q: kod/token yaratish, revoke va lockdown faqat shu jarayon orqali.
 */
async function main(): Promise<number> {
  const app = await NestFactory.createApplicationContext(CliModule, { logger: ['error', 'warn'] });
  try {
    return await runCli(app, process.argv.slice(2), parseArgs);
  } finally {
    await app.close();
  }
}

process.exitCode = await main().catch((err: unknown) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  return 1;
});
