import type { CommandActor } from './commands.service.js';

/**
 * Sessiya ochishdan oldingi ilgak (6.9 avto-checkpoint). `CommandsModule` checkpoint modulini bilmaydi (modul sikli yo'q):
 * `CheckpointsService` o'zini shu yerga ro'yxatdan o'tkazadi. Ilgak best-effort: xato/rad asosiy amalni TO'XTATMAYDI.
 */
export interface BeforeStartInfo {
  kind: 'bigTask' | 'orchestration';
  machineId: string;
  cwd: string;
  label: string;
}
type Hook = (info: BeforeStartInfo, actor: CommandActor) => Promise<void>;

let hook: Hook | null = null;

export const beforeStartHooks = {
  set(h: Hook): () => void {
    hook = h;
    return () => {
      if (hook === h) hook = null;
    };
  },
  async run(info: BeforeStartInfo, actor: CommandActor): Promise<void> {
    if (!hook) return;
    try {
      await hook(info, actor);
    } catch {
      /* avto-checkpoint best-effort */
    }
  },
};
