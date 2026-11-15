/**
 * Lokal IPC va yo'l yordamchilari: agentd, cc-hook va cc-statusline HAMMASI shu yerdan oladi (yagona manba).
 * Sof funksiyalar (node importlarisiz): platforma, env, home va foydalanuvchi nomi chaqiruvchidan keladi (testlash oson).
 *
 *  - POSIX (macOS/Linux): Unix socket `<home>/agentd.sock` (0600, home 0700: kirish OS ruxsatlari bilan cheklanadi).
 *  - Windows: named pipe `\\.\pipe\commander-agentd-<user>`. Node `net.Server.listen()` pipe'ni jarayon tokeni
 *    default DACL'i bilan yaratadi (egasi, SYSTEM, Administrators to'liq; boshqalar `readableAll/writableAll`
 *    berilmagani uchun yozolmaydi). Alohida ACL berish Node API'sida YO'Q; pipe nomida foydalanuvchi nomi bor,
 *    shuning uchun bir PC'dagi ikki foydalanuvchi to'qnashmaydi. Pipe ichidagi protokol maxfiy ma'lumot bermaydi.
 */

export interface IpcPathInput {
  env?: Readonly<Record<string, string | undefined>>;
  platform: string;
  /** `os.homedir()` */
  homeDir: string;
  /** `os.userInfo().username` (yo'q bo'lsa `USERNAME`/`USER` env). */
  username?: string;
}

export const WIN_PIPE_PREFIX = '\\\\.\\pipe\\';

/** `<home>/.commander` yoki `COMMANDER_HOME` (testlar uchun). */
export function commanderHome(i: IpcPathInput): string {
  const override = i.env?.['COMMANDER_HOME'];
  if (override) return override;
  const sep = i.platform === 'win32' ? '\\' : '/';
  return `${i.homeDir.replace(/[\\/]+$/, '')}${sep}.commander`;
}

export function isWindowsPipePath(p: string): boolean {
  return p.toLowerCase().startsWith(WIN_PIPE_PREFIX);
}

/** FNV-1a 32 bit (hex). Faqat maxsus `COMMANDER_HOME` uchun pipe nomini farqlash; kriptografik emas. */
function shortHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function sanitizeUser(name: string | undefined, env: IpcPathInput['env']): string {
  const raw = name || env?.['USERNAME'] || env?.['USER'] || 'user';
  return raw.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64).toLowerCase() || 'user';
}

/** Windows pipe nomi. Standart home: `commander-agentd-<user>`; maxsus `COMMANDER_HOME`: oxiriga home xeshi qo'shiladi. */
export function windowsPipePath(i: IpcPathInput): string {
  const user = sanitizeUser(i.username, i.env);
  const custom = i.env?.['COMMANDER_HOME'];
  return `${WIN_PIPE_PREFIX}commander-agentd-${user}${custom ? `-${shortHash(custom.toLowerCase())}` : ''}`;
}

/** agentd hook-server manzili. `COMMANDER_SOCKET` hamma narsadan ustun (testlar, qo'lda). */
export function resolveIpcPath(i: IpcPathInput): string {
  const forced = i.env?.['COMMANDER_SOCKET'];
  if (forced) return forced;
  if (i.platform === 'win32') return windowsPipePath(i);
  return `${commanderHome(i)}/agentd.sock`;
}

/**
 * Loyiha yo'lini yagona ko'rinishga keltiradi (bitta loyiha ikkiga bo'linmasin).
 * POSIX: aynan o'zgarishsiz.
 * Windows: `\` -> `/`, disk harfi katta (`c:` -> `C:`), takroriy ajratgichlar birlashadi, oxirgi `/` olinadi
 * (`C:/` qoladi). UNC (`//server/share/..`) boshidagi `//` saqlanadi. Katta-kichik harf PAPKA nomlarida o'zgartirilmaydi
 * (ko'rinish buzilmasin); haqiqiy yozilishni agentd `realpath.native` bilan beradi (project-root.ts).
 */
export function normalizeProjectPath(p: string, platform: string): string {
  if (platform !== 'win32') return p;
  let s = p.replace(/\\/g, '/');
  // `\\?\C:\x` va `\\.\C:\x` prefikslari
  s = s.replace(/^\/\/[?.]\//, '');
  const unc = s.startsWith('//');
  s = (unc ? '//' : '') + s.replace(/^\/+/, '').replace(/\/{2,}/g, '/');
  s = s.replace(/^([a-zA-Z]):/, (_m, d: string) => `${d.toUpperCase()}:`);
  if (/^[A-Z]:\/?$/.test(s)) return `${s.slice(0, 2)}/`;
  return s.length > 1 ? s.replace(/\/+$/, '') : s;
}

/**
 * `kind: 'permission'` lokal IPC javobi (agentd -> cc-hook). Bog'liqliksiz tiplar (cc-hook zod yuklamaydi).
 * `decision: null` = qaror yo'q (deadline, center offline, lokal hal bo'ldi, xato): cc-hook HECH NARSA chiqarmaydi
 * va Claude Code oddiy lokal promptga qaytadi. `allow` faqat center'dan kelgan aniq qarorda bo'ladi.
 */
export interface PermissionIpcDecision {
  behavior: 'allow' | 'deny';
  message?: string;
  /** AskUserQuestion (6.13): javob indekslari; cc-hook ularni O'Z xom tool_input'iga moslab `updatedInput.answers` yasaydi. */
  answers?: Array<{ q: number; picks: number[]; other?: string }>;
}
export interface PermissionIpcReply {
  ok: boolean;
  decision: PermissionIpcDecision | null;
  /** Faqat tashxis uchun (`expired`, `center_offline`, `bad_request`, ...). */
  reason?: string;
}

/** cc-hook deadline'i (ms): sukut 300 s; agentd va cc-hook bir xil chegaralarni qo'llaydi. */
export const PERMISSION_DEADLINE = { defaultMs: 300_000, minMs: 1_000, maxMs: 900_000 } as const;
