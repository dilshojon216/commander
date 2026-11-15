import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { REMOTE_PERMISSION_MODES, isCheckpointCommandType, isConfigCommandType, isDeployCommandType } from '@commander/contracts';
import type { CommandErrorCode, CommandType } from '@commander/contracts';
import { decideConfigPolicy } from './config-policy.js';
import type { AgentdPaths } from './paths.js';

/**
 * Lokal siyosat `~/.commander/policy.json` (0600). Markazdan O'ZGARTIRILMAYDI: faqat egasi `agentd policy ...` bilan
 * (yoki faylni qo'lda) o'zgartiradi. DEFAULT = masofaviy boshqaruv O'CHIQ (hammasi rad). Fayl o'qib bo'lmasa, buzuq
 * bo'lsa yoki guruh/boshqalarga ochiq bo'lsa ham "o'chiq" hisoblanadi (fail-closed). Har buyruqda qayta o'qiladi.
 */
export const PolicySchema = z.object({
  remote: z
    .object({
      enabled: z.boolean().default(false),
      /** Mutlaq papkalar; `session.start` cwd'si (realpath bilan) shulardan birining ichida bo'lishi shart. */
      allowedRoots: z.array(z.string().min(1).max(4096)).max(100).default([]),
      allowStart: z.boolean().default(true),
      allowPrompt: z.boolean().default(true),
      allowStop: z.boolean().default(true),
      allowSetMode: z.boolean().default(true),
      /** `auto` ruxsat rejimi (classifier avto-tasdiq): alohida yoqiladi. */
      allowAutoMode: z.boolean().default(false),
      maxConcurrentStarted: z.number().int().min(0).max(100).default(3),
      /** Loyiha ish maydoni (2.15): `project.refresh|read_md|summarize` (faqat o'qish; summarize `claude -p` ishga tushiradi). */
      allowProjectRead: z.boolean().default(true),
      /** `project.append_tasks`: faqat loyihaning TASKS.md'ini tahrirlash. */
      allowProjectWrite: z.boolean().default(true),
      /** Sozlamalar sinxronlash (3.7): DEFAULT O'CHIQ. O'qish = capture + dry-run; yozish = qo'llash + qaytarish. */
      allowConfigRead: z.boolean().default(false),
      allowConfigWrite: z.boolean().default(false),
      /** Log ko'ruvchi (6.6): `logs.tail` (docker/journal; faqat o'qish, chiqish redakt qilinadi va saqlanmaydi). DEFAULT yoqilgan (`enabled` o'chiq bo'lsa baribir rad). */
      allowLogs: z.boolean().default(true),
      /** Fayl loglari uchun ruxsat etilgan ildizlar (mutlaq papkalar). DEFAULT bo'sh (opt-in); macOS `~/Library/Logs/commander` doim ruxsat. */
      allowedLogRoots: z.array(z.string().min(1).max(4096)).max(50).default([]),
      /** Deploy (6.5): `deploy.run|rollback` (qadamlarni mashinada bajaradi = RCE). DEFAULT O'CHIQ; `agentd policy allow-deploy`. `deploy.inspect` faqat o'qish (`allowProjectRead`). */
      allowDeploy: z.boolean().default(false),
      /** Retsept `shell:` qadamlari (yoki `bash -c`): alohida opt-in, DEFAULT O'CHIQ. */
      allowDeployShell: z.boolean().default(false),
      /** Xavfsizlik/dependency tekshiruvi (6.10): `project.scan` (faqat o'qish; audit reestrga tarmoq so'rovi yuborishi mumkin). DEFAULT yoqilgan. */
      allowScan: z.boolean().default(true),
    })
    .default({
      enabled: false,
      allowedRoots: [],
      allowStart: true,
      allowPrompt: true,
      allowStop: true,
      allowSetMode: true,
      allowAutoMode: false,
      maxConcurrentStarted: 3,
      allowProjectRead: true,
      allowProjectWrite: true,
      allowConfigRead: false,
      allowConfigWrite: false,
      allowLogs: true,
      allowedLogRoots: [],
      allowDeploy: false,
      allowDeployShell: false,
      allowScan: true,
    }),
});
export type Policy = z.infer<typeof PolicySchema>;
export type RemotePolicy = Policy['remote'];

export const DISABLED_POLICY: Policy = PolicySchema.parse({});

export interface LoadedPolicy {
  policy: Policy;
  /** Fayl bor-yo'qligi va nega "o'chiq" ekani (diagnostika; `agentd policy show`). */
  source: 'file' | 'default' | 'invalid' | 'insecure';
  detail?: string;
}

const isPosix = process.platform !== 'win32';

/** Fayl faqat egasiga ochiq (0600) va egasi shu foydalanuvchi bo'lishi shart (POSIX). Windows: profil ACL'iga tayanadi. */
export function policyFileInsecure(file: string): string | null {
  if (!isPosix) return null;
  const st = statSync(file);
  if ((st.mode & 0o077) !== 0) return `policy.json guruh/boshqalarga ochiq (mode ${(st.mode & 0o777).toString(8)}); chmod 600`;
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return 'policy.json boshqa foydalanuvchiga tegishli';
  return null;
}

export function loadPolicy(paths: Pick<AgentdPaths, 'policyFile'>): LoadedPolicy {
  const file = paths.policyFile;
  if (!existsSync(file)) return { policy: DISABLED_POLICY, source: 'default' };
  if (isSymlink(file)) return { policy: DISABLED_POLICY, source: 'insecure', detail: 'policy.json simvolik havola bo\'lmasligi kerak' };
  try {
    const insecure = policyFileInsecure(file);
    if (insecure) return { policy: DISABLED_POLICY, source: 'insecure', detail: insecure };
    const parsed = PolicySchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    if (!parsed.success) return { policy: DISABLED_POLICY, source: 'invalid', detail: z.prettifyError(parsed.error).slice(0, 300) };
    return { policy: parsed.data, source: 'file' };
  } catch (err) {
    return { policy: DISABLED_POLICY, source: 'invalid', detail: err instanceof Error ? err.message.slice(0, 200) : 'unreadable' };
  }
}

/** Atomik yozuv, fayl 0600. */
export function savePolicy(paths: Pick<AgentdPaths, 'policyFile' | 'home'>, policy: Policy): void {
  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  const tmp = `${paths.policyFile}.tmp`;
  writeFileSync(tmp, JSON.stringify(PolicySchema.parse(policy), null, 2) + '\n', { mode: 0o600 });
  if (isPosix) chmodSync(tmp, 0o600);
  renameSync(tmp, paths.policyFile);
}

// --- yo'l tekshiruvi ---------------------------------------------------------------------------

export interface PathOps {
  /** `fs.realpathSync.native` (Windows'da qisqa nomlar/registrni haqiqiyga keltiradi). */
  realpath(p: string): string;
  isDirectory(p: string): boolean;
  lib: Pick<typeof path.posix, 'relative' | 'isAbsolute' | 'sep' | 'resolve' | 'parse'>;
  /** Windows: registrga befarq. */
  caseInsensitive: boolean;
}

export const realPathOps: PathOps = {
  realpath: (p) => realpathSync.native(p),
  isDirectory: (p) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
  lib: process.platform === 'win32' ? path.win32 : path.posix,
  caseInsensitive: process.platform === 'win32' || process.platform === 'darwin',
};

/** `target` `root` ichidami (yoki unga teng)? Ikkalasi ham ALLAQACHON realpath qilingan, mutlaq yo'l. Sof. */
export function isInside(root: string, target: string, lib: PathOps['lib'], caseInsensitive = false): boolean {
  const norm = (p: string): string => (caseInsensitive ? p.toLowerCase() : p);
  const rel = lib.relative(norm(root), norm(target));
  if (rel === '') return true;
  // Windows: boshqa disk ('D:\\x') relative() da mutlaq yo'l bo'lib qoladi; '..' bilan boshlanuvchi (lekin '..a' emas) tashqarida.
  return !lib.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${lib.sep}`);
}

export type CwdCheck = { ok: true; real: string } | { ok: false; code: Extract<CommandErrorCode, 'cwd_invalid' | 'cwd_not_allowed'>; message: string };

/**
 * Masofadan ochish/prompt/fayl o'qish uchun HECH QACHON ruxsat etilmaydigan papkalar (sirlar va agentd holati):
 * `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.claude`, `~/.commander`, `~/.config/commander`. `COMMANDER_HOME` boshqa joyga
 * ko'rsatilgan bo'lsa (yoki `commanderHome` berilsa) u ham qo'shiladi. `$HOME` butunlay ildiz bo'lganda (`allow-home`) ham amal qiladi.
 */
export function sensitiveDirs(home: string = homedir(), commanderHome?: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const dirs = [
    path.join(home, '.ssh'),
    path.join(home, '.gnupg'),
    path.join(home, '.aws'),
    path.join(home, '.claude'),
    path.join(home, '.commander'),
    path.join(home, '.config', 'commander'),
  ];
  const extra = commanderHome ?? env['COMMANDER_HOME'];
  if (extra && path.isAbsolute(extra) && !dirs.includes(extra)) dirs.push(extra);
  return dirs;
}

/** `real` (ALLAQACHON realpath) maxfiy papkalardan birining ichidami? Fayl o'qish API'lari uchun (ildiz = `$HOME` bo'lganda ham himoya). */
export function isInsideSensitive(real: string, ops: PathOps = realPathOps, sensitive: readonly string[] = sensitiveDirs()): boolean {
  for (const s of sensitive) {
    let rs = s;
    try {
      rs = ops.realpath(s);
    } catch {
      /* mavjud emas: matn bo'yicha solishtiramiz */
    }
    if (isInside(rs, real, ops.lib, ops.caseInsensitive)) return true;
  }
  return false;
}

/**
 * `cwd`: mutlaq, mavjud papka; realpath'dan (symlink/`..`/Windows qisqa nomlar hal bo'lgach) keyin ruxsat etilgan ildizlardan
 * birining ICHIDA bo'lishi va maxfiy papka bo'lmasligi shart. Ildizlar ham realpath qilinadi (mavjud bo'lmagan ildiz o'tkazib yuboriladi).
 */
export function checkCwd(cwd: string, roots: readonly string[], ops: PathOps = realPathOps, sensitive: readonly string[] = sensitiveDirs()): CwdCheck {
  if (cwd.includes('\0') || !ops.lib.isAbsolute(cwd)) return { ok: false, code: 'cwd_invalid', message: 'cwd must be an absolute path' };
  let real: string;
  try {
    real = ops.realpath(cwd);
  } catch {
    return { ok: false, code: 'cwd_invalid', message: 'cwd does not exist' };
  }
  if (!ops.isDirectory(real)) return { ok: false, code: 'cwd_invalid', message: 'cwd is not a directory' };

  if (isInsideSensitive(real, ops, sensitive)) return { ok: false, code: 'cwd_not_allowed', message: 'cwd is inside a protected directory' };
  for (const root of roots) {
    let rr: string;
    try {
      rr = ops.realpath(root);
    } catch {
      continue;
    }
    if (isInside(rr, real, ops.lib, ops.caseInsensitive)) return { ok: true, real };
  }
  return { ok: false, code: 'cwd_not_allowed', message: 'cwd is outside the allowed roots of the local policy' };
}

/** `allow-root`: mutlaq, mavjud papka; fayl tizimi ildizi va `$HOME` o'zi (juda keng) rad etiladi (`$HOME` faqat `allow-home` bilan). Realpath qaytaradi. */
export function validateRootToAdd(
  dir: string,
  ops: PathOps = realPathOps,
  home: string = homedir(),
): { ok: true; real: string } | { ok: false; message: string; code?: 'home' } {
  if (!ops.lib.isAbsolute(dir)) return { ok: false, message: 'allow-root: mutlaq yo\'l kerak' };
  let real: string;
  try {
    real = ops.realpath(dir);
  } catch {
    return { ok: false, message: 'allow-root: papka mavjud emas' };
  }
  if (!ops.isDirectory(real)) return { ok: false, message: 'allow-root: bu papka emas' };
  if (ops.lib.parse(real).root === real) return { ok: false, message: 'allow-root: fayl tizimi ildizi (juda keng) ruxsat etilmaydi' };
  let realHome = home;
  try {
    realHome = ops.realpath(home);
  } catch {
    /* home mavjud emas */
  }
  const eq = (a: string, b: string): boolean => (ops.caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (eq(real, realHome)) {
    return { ok: false, code: 'home', message: 'allow-root: $HOME ning o\'zi (juda keng) bu buyruq bilan ruxsat etilmaydi; aniq loyiha papkasini bering yoki ongli ravishda: agentd policy allow-home' };
  }
  return { ok: true, real };
}

/** `allow-home`: haqiqiy `$HOME` (realpath). Mavjud papka bo'lishi va fayl tizimi ildizi bo'lmasligi shart (HOME=/ rad). */
export function resolveHomeRoot(ops: PathOps = realPathOps, home: string = homedir()): { ok: true; real: string } | { ok: false; message: string } {
  if (!ops.lib.isAbsolute(home)) return { ok: false, message: 'allow-home: $HOME mutlaq yo\'l emas' };
  let real: string;
  try {
    real = ops.realpath(home);
  } catch {
    return { ok: false, message: 'allow-home: $HOME papkasi mavjud emas' };
  }
  if (!ops.isDirectory(real)) return { ok: false, message: 'allow-home: $HOME papka emas' };
  if (ops.lib.parse(real).root === real) return { ok: false, message: 'allow-home: $HOME fayl tizimi ildizi (juda keng) ruxsat etilmaydi' };
  return { ok: true, real };
}

/** `allow-home` yoqilganda chiqadigan ogohlantirish (o'zbekcha). */
export function homeWarning(real: string): string {
  return [
    `OGOHLANTIRISH: butun uy papkasi (${real}) masofaviy boshqaruv ildizi qilinmoqda.`,
    '  - Endi shu papkaning HAR QANDAY ichki papkasida (loyihalar, ish papkalari, uyning o\'zi) masofadan sessiya ochish/prompt yuborish,',
    '    loyiha md fayllarini o\'qish, git/deploy/scan amallari (siyosat bayroqlari ruxsat bersa) mumkin bo\'ladi.',
    '  - HIMOYALANGAN bo\'lib qoladi (cwd sifatida ham, fayl o\'qishda ham rad): ~/.ssh, ~/.gnupg, ~/.aws, ~/.claude, ~/.commander, ~/.config/commander.',
    '  - Boshqa maxfiy fayllar (masalan ~/.bashrc, ~/.netrc, ~/.kube, ~/.docker, ~/.config/gh) HIMOYALANMAGAN: sessiya ularni Claude vositalari orqali o\'qishi/yozishi mumkin.',
    '  - Qaytarish: agentd policy deny-home',
  ].join('\n') + '\n';
}

// --- qaror ------------------------------------------------------------------------------------

export interface PolicyDecisionInput {
  type: CommandType;
  policy: Policy;
  runningAsRoot: boolean;
  /** `session.start`: so'ralgan cwd; `prompt|set_mode`: sessiyaning cwd'si (agents ro'yxatidan). */
  cwd?: string | undefined;
  permissionMode?: string | undefined;
  /** `session.start` uchun: hozir tirik, biz ochgan sessiyalar soni. */
  liveStarted?: number;
  ops?: PathOps;
  sensitive?: readonly string[];
  /** `config.apply`: faqat reja (o'qish ruxsati yetadi). */
  dryRun?: boolean;
}

export type PolicyDecision = { ok: true; cwdReal?: string } | { ok: false; code: CommandErrorCode; message: string };

const FORBIDDEN_MODES: ReadonlySet<string> = new Set(['bypassPermissions', 'dontAsk']);

/** Lokal siyosat qarori (sof; fayl tizimi `ops` orqali). `bypassPermissions` va `dontAsk` HECH QACHON o'tmaydi. */
export function decidePolicy(i: PolicyDecisionInput): PolicyDecision {
  const r = i.policy.remote;
  if (i.runningAsRoot) return { ok: false, code: 'running_as_root', message: 'agentd runs as root: remote commands are refused' };
  if (!r.enabled) return { ok: false, code: 'policy_disabled', message: 'Remote control is disabled in ~/.commander/policy.json' };
  if (isConfigCommandType(i.type)) return decideConfigPolicy(i.type, r, i.dryRun === true);
  if (i.type === 'logs.tail') return r.allowLogs ? { ok: true } : { ok: false, code: 'action_not_allowed', message: 'Logs are disabled in the local policy (agentd policy allow-logs)' };
  if (isDeployCommandType(i.type) || isCheckpointCommandType(i.type)) return decideRepoPolicy(i, r);
  const allowed = {
    'session.start': r.allowStart,
    // 6.14: davom ettirish = tmux ichida yangi Claude jarayoni (session.start bilan bir xil ta'sir): xuddi shu bayroq, ildiz va soni chegarasi
    'session.resume': r.allowStart,
    'session.prompt': r.allowPrompt,
    'session.stop': r.allowStop,
    // 6.14: yopish (graceful /exit, o'zi ochgan tmux sessiyani o'chirish) = to'xtatish ruxsati
    'session.close': r.allowStop,
    'session.set_mode': r.allowSetMode,
    // 3.10: Remote Control = sessiyani claude.ai/mobil ilovadan boshqarish: prompt ruxsati bilan bir xil.
    'session.remote_control': r.allowPrompt,
    // Commander'dan savol (6.2): faqat o'qish (vositasiz haiku, markaz tuzgan kontekst)
    'assistant.ask': r.allowProjectRead,
    'project.refresh': r.allowProjectRead,
    'project.read_md': r.allowProjectRead,
    'project.summarize': r.allowProjectRead,
    'project.append_tasks': r.allowProjectWrite,
    'project.diff': r.allowProjectRead,
    'project.ci_status': r.allowProjectRead,
    // 6.10: faqat o'qiydigan xavfsizlik tekshiruvi: o'z bayrog'i
    'project.scan': r.allowScan,
    // PR ochish: branch'ni origin'ga yuboradi va `gh pr create` chaqiradi: yozish ruxsati
    'project.open_pr': r.allowProjectWrite,
  }[i.type as 'session.start'];
  if (!allowed) return { ok: false, code: 'action_not_allowed', message: `${i.type} is not allowed by the local policy` };

  if (i.permissionMode !== undefined) {
    if (FORBIDDEN_MODES.has(i.permissionMode)) return { ok: false, code: 'mode_forbidden', message: `${i.permissionMode} is never allowed remotely` };
    if (!(REMOTE_PERMISSION_MODES as readonly string[]).includes(i.permissionMode)) return { ok: false, code: 'mode_forbidden', message: 'unknown permission mode' };
    if (i.permissionMode === 'auto' && !r.allowAutoMode) return { ok: false, code: 'mode_not_allowed', message: 'auto mode is not enabled in the local policy' };
  }

  if (i.type.startsWith('project.')) {
    // Loyiha buyruqlari: loyiha ildizi (realpath) ruxsat etilgan ildiz ichida va maxfiy papka emas
    if (i.cwd === undefined) return { ok: false, code: 'cwd_invalid', message: 'project root is unknown' };
    const c = checkCwd(i.cwd, r.allowedRoots, i.ops ?? realPathOps, i.sensitive ?? sensitiveDirs());
    return c.ok ? { ok: true, cwdReal: c.real } : c;
  }
  if (i.type === 'session.start' || i.type === 'session.resume' || i.type === 'session.prompt' || i.type === 'session.set_mode' || i.type === 'session.remote_control') {
    if (i.cwd === undefined) return { ok: false, code: 'cwd_invalid', message: 'cwd is unknown' };
    const c = checkCwd(i.cwd, r.allowedRoots, i.ops ?? realPathOps, i.sensitive ?? sensitiveDirs());
    if (!c.ok) return c;
    if ((i.type === 'session.start' || i.type === 'session.resume') && (i.liveStarted ?? 0) >= r.maxConcurrentStarted) {
      return { ok: false, code: 'too_many_sessions', message: `maxConcurrentStarted (${r.maxConcurrentStarted}) reached` };
    }
    return { ok: true, cwdReal: c.real };
  }
  return { ok: true };
}

/**
 * Deploy (6.5) va checkpoint (6.9) buyruqlari: siyosat bayrog'i + repo ildizi (realpath) ruxsat etilgan ildiz ichida va maxfiy papka emas.
 * `deploy.run|rollback` -> `allowDeploy`; `deploy.inspect|git.checkpoint_list` -> `allowProjectRead`; `git.checkpoint|restore` -> `allowProjectWrite`.
 */
function decideRepoPolicy(i: PolicyDecisionInput, r: RemotePolicy): PolicyDecision {
  const flag =
    i.type === 'deploy.run' || i.type === 'deploy.rollback'
      ? { on: r.allowDeploy, hint: 'agentd policy allow-deploy' }
      : i.type === 'git.checkpoint' || i.type === 'git.checkpoint_restore'
        ? { on: r.allowProjectWrite, hint: 'allowProjectWrite' }
        : { on: r.allowProjectRead, hint: 'allowProjectRead' };
  if (!flag.on) return { ok: false, code: 'action_not_allowed', message: `${i.type} is not allowed by the local policy (${flag.hint})` };
  if (i.cwd === undefined) return { ok: false, code: 'cwd_invalid', message: 'project root is unknown' };
  const c = checkCwd(i.cwd, r.allowedRoots, i.ops ?? realPathOps, i.sensitive ?? sensitiveDirs());
  return c.ok ? { ok: true, cwdReal: c.real } : c;
}

// --- CLI (agentd policy ...) -------------------------------------------------------------------

export function describePolicy(l: LoadedPolicy): string {
  const r = l.policy.remote;
  const lines = [
    `policy: ${l.source}${l.detail ? ` (${l.detail})` : ''}`,
    `remote.enabled:        ${r.enabled}`,
    `remote.allowStart:     ${r.allowStart}`,
    `remote.allowPrompt:    ${r.allowPrompt}`,
    `remote.allowStop:      ${r.allowStop}`,
    `remote.allowSetMode:   ${r.allowSetMode}`,
    `remote.allowAutoMode:  ${r.allowAutoMode}`,
    `remote.allowProjectRead:  ${r.allowProjectRead}`,
    `remote.allowProjectWrite: ${r.allowProjectWrite}`,
    `remote.allowConfigRead:   ${r.allowConfigRead}`,
    `remote.allowConfigWrite:  ${r.allowConfigWrite}`,
    `remote.allowLogs:         ${r.allowLogs}`,
    `remote.allowScan:         ${r.allowScan}`,
    `remote.allowDeploy:       ${r.allowDeploy}`,
    `remote.allowDeployShell:  ${r.allowDeployShell}`,
    `remote.allowedLogRoots:   ${r.allowedLogRoots.length === 0 ? '(yo\'q: fayl loglari rad etiladi; macOS ~/Library/Logs/commander doim ruxsat)' : ''}`,
    ...r.allowedLogRoots.map((d) => `  - ${d}`),
    `remote.maxConcurrentStarted: ${r.maxConcurrentStarted}`,
    `remote.allowedRoots:   ${r.allowedRoots.length === 0 ? '(yo\'q: sessiya ochish rad etiladi)' : ''}`,
    ...r.allowedRoots.map((d) => `  - ${d}`),
  ];
  return lines.join('\n') + '\n';
}

/** `agentd policy <show|enable|disable|allow-root <dir>|remove-root <dir>|allow-home|deny-home|allow-auto|deny-auto|allow-config|allow-config-read|deny-config|allow-logs|deny-logs|allow-scan|deny-scan|allow-log-root <dir>|remove-log-root <dir>>`. Chiqish kodi. */
export function runPolicyCli(paths: AgentdPaths, args: string[], out: (s: string) => void, err: (s: string) => void, ops: PathOps = realPathOps, home: string = homedir()): number {
  const [action, arg] = args;
  const loaded = loadPolicy(paths);
  const base: Policy = loaded.source === 'file' ? loaded.policy : DISABLED_POLICY;
  const mutate = (fn: (r: RemotePolicy) => RemotePolicy): number => {
    if (loaded.source === 'insecure' || loaded.source === 'invalid') {
      err(`policy fayli yaroqsiz yoki xavfsiz emas (${loaded.detail ?? loaded.source}); avval tuzating\n`);
      return 1;
    }
    savePolicy(paths, { remote: fn(base.remote) });
    out(describePolicy(loadPolicy(paths)));
    return 0;
  };
  switch (action) {
    case undefined:
    case 'show':
      out(describePolicy(loaded));
      return 0;
    case 'enable':
      return mutate((r) => ({ ...r, enabled: true }));
    case 'disable':
      return mutate((r) => ({ ...r, enabled: false }));
    case 'allow-auto':
      return mutate((r) => ({ ...r, allowAutoMode: true }));
    case 'deny-auto':
      return mutate((r) => ({ ...r, allowAutoMode: false }));
    // Sozlamalar sinxronlash (3.7): `allow-config` = o'qish + yozish; `allow-config-read` = faqat capture va dry-run
    case 'allow-config':
      return mutate((r) => ({ ...r, allowConfigRead: true, allowConfigWrite: true }));
    case 'deny-config':
      return mutate((r) => ({ ...r, allowConfigRead: false, allowConfigWrite: false }));
    case 'allow-config-read':
      return mutate((r) => ({ ...r, allowConfigRead: true, allowConfigWrite: false }));
    // Log ko'ruvchi (6.6): docker/journal yoqish/o'chirish; fayl loglari uchun aniq papka (opt-in)
    case 'allow-logs':
      return mutate((r) => ({ ...r, allowLogs: true }));
    case 'deny-logs':
      return mutate((r) => ({ ...r, allowLogs: false }));
    // Xavfsizlik tekshiruvi (6.10)
    case 'allow-scan':
      return mutate((r) => ({ ...r, allowScan: true }));
    case 'deny-scan':
      return mutate((r) => ({ ...r, allowScan: false }));
    // Deploy (6.5): yoqish/o'chirish (default O'CHIQ); shell qadamlari alohida
    case 'allow-deploy':
      return mutate((r) => ({ ...r, allowDeploy: true }));
    case 'deny-deploy':
      return mutate((r) => ({ ...r, allowDeploy: false, allowDeployShell: false }));
    case 'allow-deploy-shell':
      return mutate((r) => ({ ...r, allowDeployShell: true }));
    case 'deny-deploy-shell':
      return mutate((r) => ({ ...r, allowDeployShell: false }));
    case 'allow-log-root': {
      if (!arg) {
        err('foydalanish: agentd policy allow-log-root <papka>\n');
        return 2;
      }
      const v = validateRootToAdd(path.resolve(arg), ops, home);
      if (!v.ok) {
        err((v.code === 'home' ? 'allow-log-root: $HOME ning o\'zi (juda keng) log ildizi bo\'la olmaydi; aniq log papkasini bering' : v.message.replace('allow-root', 'allow-log-root')) + '\n');
        return 2;
      }
      return mutate((r) => ({ ...r, allowedLogRoots: r.allowedLogRoots.includes(v.real) ? r.allowedLogRoots : [...r.allowedLogRoots, v.real] }));
    }
    case 'remove-log-root': {
      if (!arg) {
        err('foydalanish: agentd policy remove-log-root <papka>\n');
        return 2;
      }
      const abs = path.resolve(arg);
      let real = abs;
      try {
        real = ops.realpath(abs);
      } catch {
        /* papka o'chib ketgan bo'lishi mumkin */
      }
      return mutate((r) => ({ ...r, allowedLogRoots: r.allowedLogRoots.filter((d) => d !== real && d !== abs) }));
    }
    case 'allow-root': {
      if (!arg) {
        err('foydalanish: agentd policy allow-root <papka>\n');
        return 2;
      }
      const v = validateRootToAdd(path.resolve(arg), ops, home);
      if (!v.ok) {
        err(v.message + '\n');
        return 2;
      }
      return mutate((r) => ({ ...r, allowedRoots: r.allowedRoots.includes(v.real) ? r.allowedRoots : [...r.allowedRoots, v.real] }));
    }
    // `$HOME` ni ildiz qilish: FAQAT shu aniq buyruq bilan (egasi qarori, ADR 2026-11-14); maxfiy papkalar baribir yopiq
    case 'allow-home': {
      const h = resolveHomeRoot(ops, home);
      if (!h.ok) {
        err(h.message + '\n');
        return 2;
      }
      out(homeWarning(h.real));
      return mutate((r) => ({ ...r, allowedRoots: r.allowedRoots.includes(h.real) ? r.allowedRoots : [...r.allowedRoots, h.real] }));
    }
    case 'deny-home': {
      let real = home;
      try {
        real = ops.realpath(home);
      } catch {
        /* home o'chib ketgan bo'lishi mumkin: matn bo'yicha */
      }
      return mutate((r) => ({ ...r, allowedRoots: r.allowedRoots.filter((d) => d !== real && d !== home) }));
    }
    case 'remove-root': {
      if (!arg) {
        err('foydalanish: agentd policy remove-root <papka>\n');
        return 2;
      }
      const abs = path.resolve(arg);
      let real = abs;
      try {
        real = ops.realpath(abs);
      } catch {
        /* papka o'chib ketgan bo'lishi mumkin: matn bo'yicha olib tashlaymiz */
      }
      return mutate((r) => ({ ...r, allowedRoots: r.allowedRoots.filter((d) => d !== real && d !== abs) }));
    }
    default:
      err(`noma'lum policy buyrug'i: ${action}\n`);
      return 2;
  }
}

/** Test/diagnostika: fayl simvolik havola emasligini tekshiradi (policy.json symlink bo'lsa rad). */
export function isSymlink(file: string): boolean {
  try {
    return lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}
