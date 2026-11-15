import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { commanderHome } from '@commander/contracts/ipc';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveShell } from './shell.js';
import { readStdin, resolveSocketPath, sendToAgentd } from './socket.js';

/**
 * `cc-statusline`: Claude Code status line JSON'idagi `rate_limits` ni agentd'ga fire-and-forget yuboradi, so'ng
 * foydalanuvchining joriy status line buyrug'ini AYNAN shu stdin bilan ishga tushiradi va uning chiqishini o'zgartirmay
 * (stdout'ni to'g'ridan-to'g'ri o'tkazib) qaytaradi.
 *
 * Buyruq manbai (ustuvorlik): argv (`cc-statusline <buyruq...>`), `COMMANDER_STATUSLINE_CMD`, `~/.commander/config.json`
 * dagi `statuslineCommand`. Yo'q bo'lsa hech narsa chiqarmaydi. agentd o'chiq bo'lsa ham status line buzilmaydi.
 */
export const RELAY_TIMEOUT_MS = 300;

export function resolveCommand(argv: string[], env: NodeJS.ProcessEnv, readConfig: () => string | undefined = defaultConfigReader(env)): string | undefined {
  if (argv.length > 0) return argv.join(' ');
  if (env['COMMANDER_STATUSLINE_CMD']) return env['COMMANDER_STATUSLINE_CMD'];
  return readConfig();
}

function defaultConfigReader(env: NodeJS.ProcessEnv): () => string | undefined {
  return () => {
    try {
      const home = commanderHome({ env, platform: process.platform, homeDir: homedir() });
      const cfg: unknown = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
      if (typeof cfg === 'object' && cfg !== null && 'statuslineCommand' in cfg) {
        const v = (cfg as { statuslineCommand: unknown }).statuslineCommand;
        return typeof v === 'string' && v !== '' ? v : undefined;
      }
    } catch {
      /* config yo'q */
    }
    return undefined;
  };
}

export interface StatuslineIo {
  stdin: NodeJS.ReadableStream;
  env: NodeJS.ProcessEnv;
  socketPath?: string;
  readConfig?: () => string | undefined;
}

/** Qaytadi: bola buyrug'ining exit kodi (yo'q bo'lsa 0). */
export async function runCcStatusline(argv: string[], io: StatuslineIo): Promise<number> {
  const input = await readStdin(io.stdin, 1024 * 1024, 2000);

  const relay = (async (): Promise<void> => {
    try {
      const payload: unknown = JSON.parse(input);
      await sendToAgentd(io.socketPath ?? resolveSocketPath(io.env), { v: 1, kind: 'statusline', payload }, { timeoutMs: RELAY_TIMEOUT_MS, waitReply: false });
    } catch {
      /* fail-safe */
    }
  })();

  const command = resolveCommand(argv, io.env, io.readConfig);
  let code = 0;
  if (command) {
    code = await new Promise<number>((resolve) => {
      const shell = resolveShell(process.platform, io.env);
      // Shell topilmasa (Windows'da Git Bash yo'q) cmd.exe'ga qaytamiz; buyruq foydalanuvchining o'z konfiguratsiyasi.
      const child = shell
        ? spawn(shell.file, [...shell.args, command], { stdio: ['pipe', 'inherit', 'inherit'], env: io.env, windowsHide: true })
        : spawn(command, { shell: true, stdio: ['pipe', 'inherit', 'inherit'], env: io.env, windowsHide: true });
      child.on('error', () => resolve(0));
      child.on('close', (c) => resolve(c ?? 0));
      child.stdin.on('error', () => undefined);
      child.stdin.end(input);
    });
  }
  await relay;
  return code;
}
