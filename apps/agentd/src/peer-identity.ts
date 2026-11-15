import { execFile, spawn } from 'node:child_process';
import { existsSync, readlinkSync } from 'node:fs';
import type { Socket } from 'node:net';
import { errMsg, type Logger } from './logger.js';

/**
 * Lokal socket peer'ining HAQIQIY (yadro tasdiqlagan) pid'i va undan sessiya identity'si (M-14, review 2026-11-14).
 *
 * MUAMMO: mailbox/orkestratsiya so'rovidagi `sessionId` o'z-o'zidan e'lon qilinadi; sessiya id'lari
 * `~/.claude/projects/*\/<id>.jsonl` nomlaridan ma'lum, shuning uchun prompt-injection qilingan sessiya boshqa sessiya (lead/peer)
 * nomidan `send`/`orch_dispatch`/`orch_step_update` qila olardi.
 *
 * YECHIM (per-chaqiruv attestatsiya, tokensiz): agentd ulanish PEER pid'ini yadrodan oladi (mijoz yolg'on gapira olmaydi):
 *   - macOS: `lsof -U` — qabul qilingan fd'ning pcb manzili (`d0x..`) va unga ulangan peer soket (`n->0x..`) egasi;
 *   - Linux: `SO_PEERCRED` (yadro, connect() paytidagi pid): qabul qilingan soket perl'ga stdin sifatida beriladi
 *     (`perl -MSocket -e 'getsockopt(STDIN,SOL_SOCKET,SO_PEERCRED)'`; perl-base Debian/Ubuntu'da doim bor). Zaxira: `ss -xnp`
 *     (/proc/<pid>/fd skaneri; systemd `NoNewPrivileges` xizmatida begona jarayonlar ko'rinmaydi, shuning uchun asosiy emas).
 * So'ng `ps` bilan peer'dan yuqoriga ota-ona zanjiri yuriladi: ENG YAQIN ajdod, `claude agents --json` dagi jonli sessiya pid'i
 * bo'lsa — peer SHU sessiyaniki. Boshqa sessiyaning nomini da'vo qilgan so'rov (sessionId mos kelmasa) RAD ETILADI.
 * Boshqa sessiya ostidagi jarayon bo'la olmaydi (uning ajdodlari zanjirida o'sha sessiya yo'q), ota-onasiz (reparent) qolgan
 * jarayon ham zanjirsiz -> rad.
 *
 * CHEGARALAR (hujjatlangan): (1) Windows named pipe'da peer pid olish native API talab qiladi (Node'da yo'q) -> `unattested`
 * rejim: eski xatti-harakat (o'z-o'zidan e'lon), status'da ko'rinadi; (2) lsof/ss yo'q mashinada ham `unattested` + ogohlantirish;
 * (3) bir xil foydalanuvchi ostidagi jarayon o'sha sessiyaning O'ZI bo'lgan (uning avlodi) bo'lsa o'sha sessiya nomidan ish
 * qiladi — bu kutilgan (sessiya o'z identity'sini bera oladi); (4) kernel attestatsiyasi poyga: peer so'rovdan keyin darhol
 * chiqib ketsa pid topilmaydi -> rad (cc-mcp/cc-hook javobni kutadi, shuning uchun amalda uchramaydi).
 */

export type PeerPidFn = () => Promise<number[]>;

export interface PeerAttestor {
  /** Platforma/vositalar bor (lsof/ss). `false` bo'lsa `unattested` rejim. */
  readonly available: boolean;
  /** Ulangan soket peer'ining pid'lari (bo'sh = aniqlab bo'lmadi). */
  peerPids(socket: Socket): Promise<number[]>;
}

// --- chiqishni tahlil qilish (sof, testlanadi) -------------------------------------------------------

interface LsofRecord {
  pid: number;
  fd: string;
  device: string;
  name: string;
}

/** `lsof -F pfdn` chiqishi: `p<pid>` blok, keyin `f<fd>`, `d<device>`, `n<name>` yozuvlari. */
export function parseLsofUnix(out: string): LsofRecord[] {
  const recs: LsofRecord[] = [];
  let pid = -1;
  let cur: { fd: string; device: string; name: string } | undefined;
  const flush = (): void => {
    if (cur && pid > 0) recs.push({ pid, ...cur });
    cur = undefined;
  };
  for (const line of out.split('\n')) {
    if (line.length < 2) continue;
    const tag = line[0];
    const val = line.slice(1);
    if (tag === 'p') {
      flush();
      pid = Number.parseInt(val, 10);
    } else if (tag === 'f') {
      flush();
      cur = { fd: val, device: '', name: '' };
    } else if (cur && tag === 'd') cur.device = val;
    else if (cur && tag === 'n') cur.name = val;
  }
  flush();
  return recs;
}

/** macOS: `fd` (agentd'ning qabul qilingan soketi) ga ulangan peer soketlarning egalari. */
export function peerPidsFromLsof(recs: readonly LsofRecord[], ownPid: number, ownFd: number): number[] {
  const mine = recs.find((r) => r.pid === ownPid && r.fd === String(ownFd));
  if (!mine || mine.device === '') return [];
  const target = `->${mine.device}`;
  const pids = new Set<number>();
  for (const r of recs) if (r.name === target && r.pid !== ownPid) pids.add(r.pid);
  // Bir jarayon ichida (test) peer o'zimiz bo'lishi mumkin: faqat boshqa pid topilmasa qaytariladi.
  if (pids.size === 0) for (const r of recs) if (r.name === target) pids.add(r.pid);
  return [...pids];
}

const SS_LINE = /^\S+\s+\S+\s+\d+\s+\d+\s+\S+\s+(\d+)\s+\S+\s+(\d+)(?:\s+(.*))?$/;

/** Linux: `ss -xnpH` -> `inode` ning peer inode'i va peer soket egalari (`pid=N`). */
export function peerPidsFromSs(out: string, ownInode: string): number[] {
  const rows = new Map<string, { peer: string; users: string }>();
  for (const line of out.split('\n')) {
    const m = SS_LINE.exec(line.trim());
    if (m) rows.set(m[1]!, { peer: m[2]!, users: m[3] ?? '' });
  }
  const mine = rows.get(ownInode);
  if (!mine) return [];
  const peer = rows.get(mine.peer);
  if (!peer) return [];
  const pids = new Set<number>();
  for (const m of peer.users.matchAll(/pid=(\d+)/g)) pids.add(Number.parseInt(m[1]!, 10));
  return [...pids];
}

/** `ps -A -o pid=,ppid=` -> pid -> ppid. */
export function parsePsParents(out: string): Map<number, number> {
  const map = new Map<number, number>();
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) map.set(Number.parseInt(m[1]!, 10), Number.parseInt(m[2]!, 10));
  }
  return map;
}

/** `pid` dan yuqoriga ota-ona zanjiri (o'zi bilan, chegaralangan, siklsiz). */
export function ancestorChain(pid: number, parents: ReadonlyMap<number, number>): number[] {
  const chain: number[] = [];
  const seen = new Set<number>();
  let p: number | undefined = pid;
  while (p !== undefined && p > 1 && !seen.has(p) && chain.length < 64) {
    chain.push(p);
    seen.add(p);
    p = parents.get(p);
  }
  return chain;
}

// --- yadro attestatsiyasi ----------------------------------------------------------------------------

type ExecOut = (file: string, args: string[]) => Promise<string>;
const defaultExec: ExecOut = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 4000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });

const socketFd = (socket: Socket): number | undefined => {
  const fd = (socket as unknown as { _handle?: { fd?: number } })._handle?.fd;
  return typeof fd === 'number' && fd >= 0 ? fd : undefined;
};

/** `perl -e` dasturi: stdin = ulangan Unix soket; chiqish `pid uid gid` (SO_PEERCRED). */
const PERL_PEERCRED = 'use Socket; my $c = getsockopt(STDIN, SOL_SOCKET, SO_PEERCRED); print join(" ", unpack("i3", $c)), "\\n" if defined $c;';
const PERL_CANDIDATES = ['/usr/bin/perl', '/bin/perl'];

/** `parseSoPeercred("1234 1000 1000\\n")` -> 1234. */
export function parseSoPeercred(out: string): number | undefined {
  const m = /^(\d+) \d+ \d+\s*$/.exec(out.trim());
  const pid = m ? Number.parseInt(m[1]!, 10) : 0;
  return pid > 0 ? pid : undefined;
}

/** Soketni child'ga stdin sifatida berib, stdout'ini qaytaradi (chegaralangan vaqt). */
const defaultExecWithSocket = (file: string, args: string[], socket: Socket): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: [socket, 'pipe', 'ignore'], timeout: 4000, windowsHide: true });
    let out = '';
    child.stdout?.on('data', (d: Buffer) => {
      if (out.length < 1000) out += d.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}`))));
  });

const LSOF_CANDIDATES = ['/usr/sbin/lsof', '/usr/bin/lsof'];
const SS_CANDIDATES = ['/usr/bin/ss', '/bin/ss', '/usr/sbin/ss', '/sbin/ss'];

/** Faqat ABSOLYUT, tizim yo'llari (PATH/cwd qidiruvi yo'q). */
export function createPeerAttestor(
  opts: { platform?: string; exec?: ExecOut; execWithSocket?: (file: string, args: string[], socket: Socket) => Promise<string>; exists?: (p: string) => boolean; readlink?: (p: string) => string; ownPid?: number } = {},
): PeerAttestor {
  const platform = opts.platform ?? process.platform;
  const exec = opts.exec ?? defaultExec;
  const exists = opts.exists ?? existsSync;
  const readlink = opts.readlink ?? ((p: string) => readlinkSync(p));
  const ownPid = opts.ownPid ?? process.pid;
  if (platform === 'darwin') {
    const lsof = LSOF_CANDIDATES.find((p) => exists(p));
    if (!lsof) return { available: false, peerPids: async () => [] };
    return {
      available: true,
      peerPids: async (socket) => {
        const fd = socketFd(socket);
        if (fd === undefined) return [];
        return peerPidsFromLsof(parseLsofUnix(await exec(lsof, ['-nP', '-w', '-U', '-F', 'pfdn'])), ownPid, fd);
      },
    };
  }
  if (platform === 'linux') {
    const perl = PERL_CANDIDATES.find((p) => exists(p));
    const ss = SS_CANDIDATES.find((p) => exists(p));
    if (!perl && !ss) return { available: false, peerPids: async () => [] };
    const execSock = opts.execWithSocket ?? defaultExecWithSocket;
    return {
      available: true,
      peerPids: async (socket) => {
        if (perl) {
          try {
            const pid = parseSoPeercred(await execSock(perl, ['-e', PERL_PEERCRED], socket));
            if (pid !== undefined) return [pid];
          } catch {
            /* perl ishlamadi: ss zaxirasi */
          }
        }
        if (!ss) return [];
        const fd = socketFd(socket);
        if (fd === undefined) return [];
        const m = /^socket:\[(\d+)\]$/.exec(readlink(`/proc/self/fd/${fd}`));
        if (!m) return [];
        return peerPidsFromSs(await exec(ss, ['-xnpH']), m[1]!);
      },
    };
  }
  return { available: false, peerPids: async () => [] }; // Windows named pipe: Node'da peer pid yo'q
}

// --- sessiya identity ------------------------------------------------------------------------------------

export interface LivePid {
  sessionId: string;
  pid: number;
}

export type IdentityResult = { ok: true; sessionId: string | undefined; attested: boolean } | { ok: false; reason: string };

export interface SessionIdentityDeps {
  attestor: PeerAttestor;
  /** Jonli sessiyalar (pid bilan). `fresh=true`: keshni chetlab `claude agents --json` ni qayta o'qiydi. */
  sessions: (fresh: boolean) => Promise<LivePid[]>;
  /** `ps` snapshot'i (pid -> ppid). */
  parents?: () => Promise<Map<number, number>>;
  log: Logger;
  /** Majburiy emas: `unattested` rejimni qo'lda yoqish (config). */
  forceUnattested?: boolean;
}

const defaultParents = async (): Promise<Map<number, number>> => parsePsParents(await defaultExec('/bin/ps', ['-A', '-o', 'pid=,ppid=']));

export class SessionIdentity {
  private warned = false;
  readonly mode: 'enforce' | 'unattested';

  constructor(private readonly d: SessionIdentityDeps) {
    this.mode = d.attestor.available && !d.forceUnattested ? 'enforce' : 'unattested';
    if (this.mode === 'unattested') {
      d.log.warn("sessiya identity'si TASDIQLANMAYDI (platforma/vosita yo'q: macOS lsof, Linux ss kerak; Windows named pipe peer pid bermaydi): sessionId o'z-o'zidan e'lon qilinadi (M-14 chegarasi)");
    }
  }

  /**
   * `claimed`: mijoz e'lon qilgan sessionId (bo'lmasligi mumkin). `peer`: yadro attestatsiyasi.
   * `enforce`: natija FAQAT peer ajdodidan (e'lon qilingani mos kelishi shart). `unattested`: e'lon qilingan qaytadi.
   */
  async verify(peer: PeerPidFn | undefined, claimed: string | undefined): Promise<IdentityResult> {
    if (this.mode === 'unattested') {
      if (!this.warned) {
        this.warned = true;
        this.d.log.warn('mailbox: sessiya identity tasdiqlanmagan rejimda ishlayapti');
      }
      return { ok: true, sessionId: claimed, attested: false };
    }
    if (!peer) return { ok: false, reason: 'peer identity is unavailable for this connection' };
    let pids: number[];
    try {
      pids = await peer();
    } catch (err) {
      this.d.log.warn('peer pid aniqlanmadi', { error: errMsg(err) });
      return { ok: false, reason: 'could not identify the calling process' };
    }
    if (pids.length === 0) return { ok: false, reason: 'could not identify the calling process' };

    let parents: Map<number, number>;
    try {
      parents = await (this.d.parents ?? defaultParents)();
    } catch (err) {
      this.d.log.warn('ps o\'qilmadi', { error: errMsg(err) });
      return { ok: false, reason: 'could not read the process table' };
    }

    for (const fresh of [false, true]) {
      let live: LivePid[];
      try {
        live = await this.d.sessions(fresh);
      } catch (err) {
        this.d.log.warn('jonli sessiyalar ro\'yxati olinmadi', { error: errMsg(err) });
        continue;
      }
      const bySid = new Map<number, string>(live.map((s) => [s.pid, s.sessionId]));
      const found = new Set<string>();
      for (const pid of pids) {
        for (const p of ancestorChain(pid, parents)) {
          const sid = bySid.get(p);
          if (sid) {
            found.add(sid); // eng yaqin sessiya ajdodi
            break;
          }
        }
      }
      if (found.size === 1) {
        const sid = [...found][0]!;
        if (claimed !== undefined && claimed !== sid) return { ok: false, reason: 'the calling process belongs to a different session than the one it claims' };
        return { ok: true, sessionId: sid, attested: true };
      }
      if (found.size > 1) return { ok: false, reason: 'the calling process maps to several sessions' };
      // topilmadi: yangi sessiya bo'lishi mumkin -> yangi ro'yxat bilan yana bir urinish
    }
    return { ok: false, reason: 'the calling process is not a descendant of a known Claude Code session' };
  }
}
