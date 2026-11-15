import { homedir, userInfo } from 'node:os';
import { resolveIpcPath } from '@commander/contracts/ipc';

function currentUsername(): string | undefined {
  try {
    return userInfo().username;
  } catch {
    return undefined; // userInfo() ba'zi muhitlarda tashlaydi; resolveIpcPath env'ga qaytadi
  }
}

/** cc-hook va cc-statusline uchun agentd manzili (Unix socket yoki Windows named pipe); mantiq contracts/ipc.ts'da. */
export function resolveSocketPath(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string {
  const username = currentUsername();
  return resolveIpcPath({ env, platform, homeDir: homedir(), ...(username ? { username } : {}) });
}
