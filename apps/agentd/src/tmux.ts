import { execFile, spawn } from 'node:child_process';
import { resolveExecutable } from './trusted-bin.js';
import { randomBytes } from 'node:crypto';
import { lstatSync, readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * tmux ichidagi interaktiv Claude Code sessiyalarini boshqarish (task 2.6, POSIX).
 *
 * Xavfsizlik chegaralari:
 *  - FAQAT agentd foydalanuvchisining tmux soketlari (`<TMUX_TMPDIR|/tmp>/tmux-<uid>/*`: katalog va soket egasi == uid,
 *    katalog guruh/boshqalarga yopiq). Boshqa foydalanuvchi soketlariga tegilmaydi;
 *  - pane `claude` pid'ining ajdodi bo'lishi shart (pane_pid zanjirda), pane jarayonlari egasi == uid;
 *  - YUBORISH OLDIDAN qayta tekshiruv (`locate(pid, {fresh:true})`): kesh ishlatilmaydi;
 *  - pane'ning oldingi planidagi jarayon guruhi = claude pid guruhi (foydalanuvchi shell'ga o'tgan bo'lsa rad etiladi);
 *  - hamma chaqiruv `execFile`/`spawn` + argument MASSIVI (shell yo'q); matn argumentda emas, `load-buffer -` stdin'ida o'tadi.
 */

export interface ProcRow {
  pid: number;
  ppid: number;
  pgid: number;
  tpgid: number;
  uid: number;
  /** `/dev/` siz (`ttys004`, `pts/3`); terminalsiz jarayonda bo'sh. */
  tty: string;
}

export interface PaneRow {
  socket: string;
  panePid: number;
  paneId: string;
  paneTty: string;
  /** `sess:win.pane` (faqat tmux target sifatida; markazga yuborilmaydi). */
  label: string;
}

export interface TmuxTarget {
  socket: string;
  paneId: string;
  label: string;
}

const MAX_ANCESTRY = 64;

export function normalizeTty(tty: string): string {
  return tty.replace(/^\/dev\//, '').trim();
}

/** `ps -A -o pid=,ppid=,pgid=,tpgid=,uid=,tty=` chiqishini ajratadi. */
export function parsePs(stdout: string): Map<number, ProcRow> {
  const map = new Map<number, ProcRow>();
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\d+)\s*(\S*)\s*$/.exec(line);
    if (!m) continue;
    const tty = m[6] === '??' || m[6] === '?' || m[6] === '-' ? '' : normalizeTty(m[6] ?? '');
    map.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), tpgid: Number(m[4]), uid: Number(m[5]), tty });
  }
  return map;
}

/** `tmux list-panes -a -F '#{pane_pid} #{pane_id} #{pane_tty} #{session_name}:#{window_index}.#{pane_index}'` (label oxirida: bo'sh joy bo'lishi mumkin). */
export const LIST_PANES_FORMAT = '#{pane_pid} #{pane_id} #{pane_tty} #{session_name}:#{window_index}.#{pane_index}';

export function parsePanes(stdout: string, socket: string): PaneRow[] {
  const rows: PaneRow[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^(\d+) (%\d+) (\S+) (.+)$/.exec(line.trimEnd());
    if (!m) continue;
    rows.push({ socket, panePid: Number(m[1]), paneId: m[2] as string, paneTty: normalizeTty(m[3] as string), label: m[4] as string });
  }
  return rows;
}

/** `claude` pid'idan yuqoriga `ppid` zanjiri bo'ylab `panePid` ni qidiradi (tenglik ham mos). Sikl/chuqurlik cheklangan. */
export function isAncestorOrSelf(procs: Map<number, ProcRow>, pid: number, ancestor: number): boolean {
  const seen = new Set<number>();
  let cur: number | undefined = pid;
  for (let i = 0; i < MAX_ANCESTRY && cur !== undefined && cur > 1; i++) {
    if (cur === ancestor) return true;
    if (seen.has(cur)) return false;
    seen.add(cur);
    cur = procs.get(cur)?.ppid;
  }
  return false;
}

export type TmuxMatch =
  | { ok: true; target: TmuxTarget }
  | { ok: false; reason: 'no_pane' | 'not_owned' | 'not_foreground' };

/**
 * Sof moslashtirish: `claudePid` ning pane'ini topadi va tekshiradi.
 *  - ajdod pane'lar bir nechta bo'lishi mumkin (ichma-ich tmux): eng YAKIN ajdod (pid'ga eng kam qadam) tanlanadi;
 *  - claude jarayoni va pane_pid egasi == uid (aks holda `not_owned`);
 *  - claude'ning tty'si pane_tty bilan bir xil va tty oldingi plani (`tpgid`) claude jarayon guruhi (aks holda `not_foreground`).
 */
export function matchPane(procs: Map<number, ProcRow>, panes: PaneRow[], claudePid: number, uid: number): TmuxMatch {
  const claude = procs.get(claudePid);
  if (!claude) return { ok: false, reason: 'no_pane' };
  let best: { pane: PaneRow; depth: number } | undefined;
  for (const pane of panes) {
    const depth = ancestorDepth(procs, claudePid, pane.panePid);
    if (depth === undefined) continue;
    if (!best || depth < best.depth) best = { pane, depth };
  }
  if (!best) return { ok: false, reason: 'no_pane' };
  const paneProc = procs.get(best.pane.panePid);
  if (claude.uid !== uid || !paneProc || paneProc.uid !== uid) return { ok: false, reason: 'not_owned' };
  if (claude.tty === '' || claude.tty !== best.pane.paneTty || claude.tpgid <= 0 || claude.tpgid !== claude.pgid) return { ok: false, reason: 'not_foreground' };
  return { ok: true, target: { socket: best.pane.socket, paneId: best.pane.paneId, label: best.pane.label } };
}

function ancestorDepth(procs: Map<number, ProcRow>, pid: number, ancestor: number): number | undefined {
  const seen = new Set<number>();
  let cur: number | undefined = pid;
  for (let i = 0; i < MAX_ANCESTRY && cur !== undefined && cur > 1; i++) {
    if (cur === ancestor) return i;
    if (seen.has(cur)) return undefined;
    seen.add(cur);
    cur = procs.get(cur)?.ppid;
  }
  return undefined;
}

// --- soketlar -------------------------------------------------------------------------------------------------------

export interface FsEntryStat {
  isSocket: boolean;
  isDirectory: boolean;
  isSymlink: boolean;
  uid: number;
  mode: number;
}

export interface SocketFs {
  readdir(dir: string): string[];
  lstat(p: string): FsEntryStat | undefined;
}

export const realSocketFs: SocketFs = {
  readdir: (dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
  lstat: (p) => {
    try {
      const s = lstatSync(p);
      return { isSocket: s.isSocket(), isDirectory: s.isDirectory(), isSymlink: s.isSymbolicLink(), uid: s.uid, mode: s.mode };
    } catch {
      return undefined;
    }
  },
};

/**
 * Foydalanuvchining tmux soketlari: `<tmpdir>/tmux-<uid>/<nom>`. Katalog bizniki (uid), symlink emas va guruh/boshqalarga
 * yopiq (0700) bo'lishi shart; soketning o'zi ham bizniki. `tmpdirs` = `$TMUX_TMPDIR` (bor bo'lsa) va `/tmp`.
 */
export function findUserSockets(uid: number, tmpdirs: string[], fs: SocketFs = realSocketFs): string[] {
  const out: string[] = [];
  for (const base of new Set(tmpdirs.filter((d) => d.length > 0))) {
    const dir = path.join(base, `tmux-${uid}`);
    const ds = fs.lstat(dir);
    if (!ds || !ds.isDirectory || ds.isSymlink || ds.uid !== uid || (ds.mode & 0o077) !== 0) continue;
    for (const name of fs.readdir(dir).sort()) {
      const p = path.join(dir, name);
      const s = fs.lstat(p);
      if (s && s.isSocket && !s.isSymlink && s.uid === uid) out.push(p);
    }
  }
  return out;
}

// --- yuborish rejasi (sof) ------------------------------------------------------------------------------------------

/** Maksimal prompt uzunligi: kontraktdagi `COMMAND_LIMITS.promptMaxChars` bilan bir xil (jim qisqartirilmaydi, oshsa rad etiladi). */
export const TMUX_PROMPT_MAX = 16_000;

/**
 * M-19: Claude Code TUI kirish rejimlari. Qator boshidagi `!` = bash rejimi (model turnisiz, permission/deny va hook'larsiz
 * shell), `/` = slash buyruq (shu jumladan repo-lokal `.claude/commands`). Masofaviy prompt matni model uchun, rejim tugmasi emas:
 * birinchi "ko'rinadigan" belgi shulardan biri bo'lsa RAD ETILADI (xato kodi `invalid_payload`, xabar `prompt_mode_char: ...`).
 * Ko'rinmas (Cf: zero-width, bidi) va bo'sh joylar e'tiborga olinmaydi (`\u200B!ls` hiylasi). `allowSlashCommand` faqat agentd'ning
 * o'z ichki ishi uchun (`/remote-control` alohida yo'ldan ketadi va bu tekshiruvdan o'tmaydi); tashqi payload'da bunday bayroq YO'Q.
 * `#` rad etilmaydi: oddiy markdown sarlavhasi (xotira rejimi yangi Claude Code'da olib tashlangan).
 */
export const PROMPT_MODE_CHAR_ERROR = 'prompt_mode_char';
export function checkPromptModeChar(text: string, opts: { allowSlashCommand?: boolean } = {}): string | null {
  const first = text.replace(/^[\s\p{Cf}]+/u, '').charAt(0);
  if (first === '!') return `${PROMPT_MODE_CHAR_ERROR}: a prompt cannot start with "!" (it would open the Claude Code shell mode); rephrase it`;
  if (first === '/' && opts.allowSlashCommand !== true) return `${PROMPT_MODE_CHAR_ERROR}: a prompt cannot start with "/" (it would run a slash command); rephrase it`;
  return null;
}

/**
 * Matnni tozalaydi: CRLF/CR/LS/PS -> `\n`; `\n` dan boshqa boshqaruv belgilari (ESC, C0, DEL, C1) va tab olib tashlanadi
 * (tab -> bo'sh joy); bracketed-paste tugatish ketma-ketligi ESC'siz qoladi (zararsiz). Bo'sh natija = `null`. Uzunlikni chaqiruvchi tekshiradi.
 */
export function sanitizePromptText(text: string): string | null {
  const s = text
    .replace(/\r\n?|\u2028|\u2029/g, '\n')
    .replace(/\t/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return s.length === 0 ? null : s;
}

export interface TmuxStep {
  /** tmux argumentlari (`-S <socket>` dan KEYIN). */
  args: string[];
  /** stdin (faqat `load-buffer -`). */
  stdin?: string;
}

/**
 * Prompt yuborish rejasi. Bir qatorli: `send-keys -l -- <matn>` + `Enter`. Ko'p qatorli: `load-buffer -` (stdin) +
 * `paste-buffer -p -d` (bracketed paste: Claude Code kiritishi qatorlarni yuborish deb emas, bitta matn deb oladi) + `Enter`.
 * `paste-buffer` `-r` siz LF'ni CR'ga almashtiradi, shuning uchun bracketed paste yoqilgan bo'lishi MUHIM (jonli tekshirilgan).
 */
export function planPromptSteps(paneId: string, text: string, bufferName: string): TmuxStep[] {
  if (!text.includes('\n')) {
    return [{ args: ['send-keys', '-t', paneId, '-l', '--', text] }, { args: ['send-keys', '-t', paneId, 'Enter'] }];
  }
  return [
    { args: ['load-buffer', '-b', bufferName, '-'], stdin: text },
    { args: ['paste-buffer', '-p', '-d', '-b', bufferName, '-t', paneId] },
    { args: ['send-keys', '-t', paneId, 'Enter'] },
  ];
}

/** Stop = JORIY TURNNI TO'XTATISH: `Escape` (Ctrl-C ikki marta bosilsa Claude Code CHIQIB KETADI, shuning uchun C-c yuborilmaydi). */
/**
 * 6.14 "Yopish": Escape (joriy turn/kiritishni tozalaydi) -> `/exit` (literal) -> Enter. Foydalanuvchi prompti EMAS: `session.prompt` dagi
 * "/" rad etish qoidasi o'zgarmaydi; bu alohida buyruq va matn sobit.
 */
export function planCloseSteps(paneId: string): TmuxStep[] {
  return [{ args: ['send-keys', '-t', paneId, 'Escape'] }, { args: ['send-keys', '-t', paneId, '-l', '--', '/exit'] }, { args: ['send-keys', '-t', paneId, 'Enter'] }];
}

/** Pane yorlig'idan (`sess:win.pane`) tmux sessiya nomi. */
export const tmuxSessionOfLabel = (label: string): string => label.split(':')[0] ?? '';

export function planInterruptSteps(paneId: string): TmuxStep[] {
  return [{ args: ['send-keys', '-t', paneId, 'Escape'] }];
}

// --- bajarish -------------------------------------------------------------------------------------------------------

export interface TmuxExec {
  /** tmux'ni `-S <socket>` bilan ishga tushiradi; stdout qaytaradi. Xato = tashlaydi. */
  tmux(socket: string, args: string[], stdin?: string): Promise<string>;
  /** `ps -A -o ...` chiqishi. */
  ps(): Promise<string>;
  /** `tmux -V` muvaffaqiyatli bo'ladimi (o'rnatilganmi). */
  available(): Promise<boolean>;
  /**
   * 6.14: STANDART soketda buyruq (`-S` YO'Q): tmux o'zi `tmux-<uid>` katalogini (0700) yaratadi va kerak bo'lsa serverni ishga tushiradi.
   * Faqat `new-session`/`has-session`/`kill-session`/`list-panes -s` uchun. Muhit agentd sirlaridan (`AGENTD_*`, `COMMANDER_*`) va `TMUX*` dan tozalanadi.
   * Ixtiyoriy: eski testlarning soxta `TmuxExec`lari bermaydi.
   */
  server?(args: string[], opts?: { cwd?: string }): Promise<string>;
}

/** tmux serveriga/yangi sessiyaga ketadigan muhit: agentd sirlari va ichma-ich tmux belgilari olib tashlanadi (sof, testlangan). */
export function scrubTmuxEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || k.startsWith('AGENTD_') || k.startsWith('COMMANDER_') || k === 'TMUX' || k === 'TMUX_PANE') continue;
    out[k] = v;
  }
  return out;
}

export function createTmuxExec(tmuxBinArg = 'tmux'): TmuxExec {
  // M-18: bare nom ishonchli PATH'dan absolyut yo'lga aylanadi (nisbiy PATH yozuvlari/cwd chiqariladi); topilmasa o'zi (spawn ENOENT).
  const tmuxBin = resolveExecutable(tmuxBinArg, 'tmux') ?? tmuxBinArg;
  const run = (file: string, args: string[], stdin?: string, timeout = 5000): Promise<string> =>
    new Promise((resolve, reject) => {
      const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'ignore'], timeout, windowsHide: true });
      let out = '';
      child.stdout.on('data', (d: Buffer) => {
        if (out.length < 1_000_000) out += d.toString('utf8');
      });
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}`))));
      child.stdin.on('error', () => undefined);
      child.stdin.end(stdin ?? '');
    });
  const runServer = (args: string[], cwd?: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const child = spawn(tmuxBin, args, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, windowsHide: true, env: scrubTmuxEnv(process.env), ...(cwd ? { cwd } : {}) });
      let out = '';
      child.stdout.on('data', (d: Buffer) => {
        if (out.length < 1_000_000) out += d.toString('utf8');
      });
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}`))));
    });
  return {
    server: (args, opts) => runServer(args, opts?.cwd),
    tmux: (socket, args, stdin) => run(tmuxBin, ['-S', socket, ...args], stdin),
    ps: () =>
      new Promise((resolve, reject) => {
        execFile('/bin/ps', ['-A', '-o', 'pid=,ppid=,pgid=,tpgid=,uid=,tty='], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
      }),
    available: () =>
      new Promise((resolve) => {
        execFile(tmuxBin, ['-V'], { timeout: 3000 }, (err) => resolve(!err));
      }),
  };
}

export interface TmuxLocatorDeps {
  exec: TmuxExec;
  uid: number | undefined;
  platform?: string;
  tmpdirs?: () => string[];
  fs?: SocketFs;
  now?: () => number;
  /** Kesh umri (ms) heartbeat uchun; yuborishdan oldingi tekshiruvda ishlatilmaydi. */
  cacheMs?: number;
}

interface Snapshot {
  at: number;
  procs: Map<number, ProcRow>;
  panes: PaneRow[];
}

export class TmuxLocator {
  private snap: Snapshot | undefined;
  private avail: { at: number; ok: boolean } | undefined;
  private readonly platform: string;
  private readonly now: () => number;
  private readonly cacheMs: number;

  constructor(private readonly d: TmuxLocatorDeps) {
    this.platform = d.platform ?? process.platform;
    this.now = d.now ?? Date.now;
    this.cacheMs = d.cacheMs ?? 5000;
  }

  /** O'rnatilgan va POSIX bo'lsa `true` (natija 5 daqiqa keshlanadi; o'rnatilmagan bo'lsa `false`). */
  async isAvailable(): Promise<boolean> {
    if (this.platform === 'win32' || this.d.uid === undefined) return false;
    const t = this.now();
    if (!this.avail || t - this.avail.at > 5 * 60_000) this.avail = { at: t, ok: await this.d.exec.available().catch(() => false) };
    return this.avail.ok;
  }

  private async snapshot(fresh: boolean): Promise<Snapshot | undefined> {
    const t = this.now();
    if (!fresh && this.snap && t - this.snap.at < this.cacheMs) return this.snap;
    const uid = this.d.uid;
    if (uid === undefined) return undefined;
    const tmpdirs = this.d.tmpdirs?.() ?? [process.env.TMUX_TMPDIR ?? '', '/tmp'];
    const sockets = findUserSockets(uid, tmpdirs, this.d.fs);
    const panes: PaneRow[] = [];
    for (const socket of sockets) {
      try {
        panes.push(...parsePanes(await this.d.exec.tmux(socket, ['list-panes', '-a', '-F', LIST_PANES_FORMAT]), socket));
      } catch {
        // o'lik soket (server yo'q): e'tiborsiz
      }
    }
    let procs: Map<number, ProcRow>;
    try {
      procs = parsePs(await this.d.exec.ps());
    } catch {
      return undefined;
    }
    this.snap = { at: t, procs, panes };
    return this.snap;
  }

  /** `claude` pid'ining tmux pane'i (tekshirilgan) yoki sabab. `fresh=true`: keshsiz (yuborishdan oldin). */
  async locate(pid: number, opts: { fresh?: boolean } = {}): Promise<TmuxMatch> {
    if (!(await this.isAvailable())) return { ok: false, reason: 'no_pane' };
    const s = await this.snapshot(opts.fresh === true);
    if (!s || this.d.uid === undefined) return { ok: false, reason: 'no_pane' };
    return matchPane(s.procs, s.panes, pid, this.d.uid);
  }

  /** Bir snapshot bilan ko'p pid (heartbeat). Faqat tekshiruvdan o'tgan (`ok`) pane'lar qaytadi. */
  async locateMany(pids: number[]): Promise<Map<number, TmuxTarget>> {
    const out = new Map<number, TmuxTarget>();
    if (pids.length === 0 || !(await this.isAvailable())) return out;
    const s = await this.snapshot(false);
    if (!s || this.d.uid === undefined) return out;
    for (const pid of pids) {
      const m = matchPane(s.procs, s.panes, pid, this.d.uid);
      if (m.ok) out.set(pid, m.target);
    }
    return out;
  }

  /**
   * Pane'ning ko'rinadigan matni (`capture-pane -p -J`). FAQAT chaqiruvchi (Remote Control holat parseri, 3.10) o'qiydi va
   * undan faqat RC holat qatorini oladi; xom matn saqlanmaydi, logga yozilmaydi va markazga yuborilmaydi.
   */
  async capture(target: TmuxTarget): Promise<string> {
    return this.d.exec.tmux(target.socket, ['capture-pane', '-p', '-J', '-t', target.paneId]);
  }

  /** 6.14: tmux sessiya (standart soket) bormi. Aniq nom (`=`) bilan: boshqa sessiyaga prefiks bo'yicha tushmaydi. */
  async hasSession(name: string): Promise<boolean> {
    const ex = this.d.exec.server;
    if (!ex) return false;
    return ex(['has-session', '-t', `=${name}`]).then(() => true, () => false);
  }

  /** 6.14: yangi DETACHED tmux sessiya; `shellCommand` BITTA qator (eski tmux versiyalarida ham ishlaydi; qiymatlar chaqiruvchida qat'iy tekshirilgan va qo'shtirnoqlangan). */
  async newDetachedSession(o: { name: string; cwd: string; shellCommand: string }): Promise<void> {
    const ex = this.d.exec.server;
    if (!ex) throw new Error('tmux server exec is not available');
    await ex(['new-session', '-d', '-s', o.name, '-c', o.cwd, '-x', '200', '-y', '50', o.shellCommand], { cwd: o.cwd });
  }

  async killSession(name: string): Promise<void> {
    const ex = this.d.exec.server;
    if (!ex) return;
    await ex(['kill-session', '-t', `=${name}`]).catch(() => undefined);
  }

  /** 6.14: sessiya pane'ining pid'i (birinchi pane) yoki `undefined` (sessiya yo'q/yopilgan). */
  async sessionPanePid(name: string): Promise<number | undefined> {
    const ex = this.d.exec.server;
    if (!ex) return undefined;
    const out = await ex(['list-panes', '-s', '-t', `=${name}`, '-F', '#{pane_pid}']).catch(() => '');
    const n = Number(out.split('\n')[0]?.trim());
    return Number.isInteger(n) && n > 1 ? n : undefined;
  }

  /** 6.14: `pid` jarayoni `ancestorPid` ning avlodimi (yangi `ps` surati; kesh ishlatilmaydi). */
  async descendsFrom(pid: number, ancestorPid: number): Promise<boolean> {
    try {
      return isAncestorOrSelf(parsePs(await this.d.exec.ps()), pid, ancestorPid);
    } catch {
      return false;
    }
  }

  /** Reja bosqichlarini ketma-ket bajaradi. `betweenMs` — paste'dan keyin Enter'dan oldin qisqa kutish. */
  async run(target: TmuxTarget, steps: TmuxStep[], sleep: (ms: number) => Promise<void>, betweenMs = 150): Promise<void> {
    try {
      for (let i = 0; i < steps.length; i++) {
        const st = steps[i] as TmuxStep;
        await this.d.exec.tmux(target.socket, st.args, st.stdin);
        if (i < steps.length - 1 && st.args[0] !== 'load-buffer') await sleep(betweenMs);
      }
    } catch (err) {
      // Yarim qolgan paste: vaqtinchalik buferni o'chiramiz (matn tmux xotirasida qolmasin).
      const load = steps.find((s) => s.args[0] === 'load-buffer');
      const name = load?.args[2];
      if (name) await this.d.exec.tmux(target.socket, ['delete-buffer', '-b', name]).catch(() => undefined);
      throw err;
    }
  }
}

export const newBufferName = (): string => `cmdr-${randomBytes(6).toString('hex')}`;
