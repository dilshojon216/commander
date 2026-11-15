import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { commanderHome, resolveIpcPath } from '@commander/contracts/ipc';

/**
 * Hamma lokal holat `~/.commander/` ichida (POSIX: dir 0700; Windows: foydalanuvchi profili ACL'i, chunki mode bitlari
 * Windows'da ishlamaydi, install skripti qo'shimcha `icacls` bilan qattiqlashtiradi). Testlar uchun `COMMANDER_HOME` bilan almashtiriladi.
 * `socketFile`: POSIX'da `<home>/agentd.sock`, Windows'da named pipe (`\\.\pipe\commander-agentd-<user>`).
 */
export interface AgentdPaths {
  home: string;
  configFile: string;
  keyFile: string;
  dbFile: string;
  /** Lokal xavfsizlik siyosati (0600): masofaviy boshqaruv shu yerda yoqiladi; markazdan O'ZGARTIRILMAYDI. */
  policyFile: string;
  /** OTLP qabul qiluvchi uchun mashina tokeni (0600): `OTEL_EXPORTER_OTLP_HEADERS=x-commander-token=<token>` (M-20). */
  otlpTokenFile: string;
  socketFile: string;
}

function currentUsername(): string | undefined {
  try {
    return userInfo().username;
  } catch {
    return undefined;
  }
}

export function resolvePaths(
  home: string = commanderHome({ env: process.env, platform: process.platform, homeDir: homedir() }),
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): AgentdPaths {
  const username = currentUsername();
  // `home` aniq berilsa (test) pipe nomi shu home'ga bog'lanadi; COMMANDER_SOCKET env'i esa hamma narsadan ustun.
  const socketFile = resolveIpcPath({
    env: { ...env, COMMANDER_HOME: home === defaultHome(platform) ? undefined : home },
    platform,
    homeDir: homedir(),
    ...(username ? { username } : {}),
  });
  return {
    home,
    configFile: join(home, 'config.json'),
    keyFile: join(home, 'device.key'),
    dbFile: join(home, 'agentd.db'),
    policyFile: join(home, 'policy.json'),
    otlpTokenFile: join(home, 'otlp-token'),
    socketFile,
  };
}

function defaultHome(platform: string): string {
  return commanderHome({ env: {}, platform, homeDir: homedir() });
}
