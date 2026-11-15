import { execFile, spawn } from 'node:child_process';
import { constants as fsc, openSync, closeSync, fstatSync, lstatSync, readSync } from 'node:fs';
import { homedir, platform as osPlatform, tmpdir } from 'node:os';
import { LOG_LIMITS } from '@commander/contracts';
import type { CommandErrorCode, LogEndReason, LogsChunkPayload, LogsTailPayload } from '@commander/contracts';
import { errMsg, type Logger } from './logger.js';
import type { PathOps, Policy } from './policy.js';
import { realPathOps, sensitiveDirs } from './policy.js';
import type { RunnerOutcome } from './runner.js';
import { redact } from './redact.js';
import { safeExecEnv, trustedBin } from './trusted-bin.js';
import type { TrustedName } from './trusted-bin.js';
import {
  LineSplitter,
  LogRedactor,
  checkLogFile,
  dockerSince,
  effectiveLogRoots,
  journalSince,
  lastLines,
  lineBytes,
  matchUnit,
  parseDockerNames,
  parseSince,
  parseUnitNames,
} from './logs-source.js';

/**
 * Log ko'ruvchi (task 6.6): `logs.tail` — docker / journal / fayl. Imzo, muddat, nonce va lokal siyosat (`allowLogs`)
 * `CommandManager`da ALLAQACHON tekshirilgan; bu yerda manba ruxsati (ro'yxat bilan nom tekshiruvi, fayl uchun log ildizi),
 * bajarish, redaksiya va oqizish.
 *
 * Xavfsizlik:
 *  - shell YO'Q (`execFile`/`spawn` + argumentlar massivi); nomlar FAQAT `docker ps -a` / `systemctl list-units` ro'yxatidagi aniq
 *    moslik bo'lsa argumentga tushadi, ustiga `--` / `--unit=` bilan (bayroqqa aylana olmaydi);
 *  - fayl: realpath'dan keyin ruxsat etilgan log ildizi ichida va oddiy fayl (symlink/`..`/maxfiy papka rad); ochishda `O_NOFOLLOW`;
 *  - chiqish redakt qilinadi (qatorlar + PEM holati), qator 2000 belgigacha kesiladi, snapshot <= 256 KB (oxirgi qismi qoladi),
 *    follow <= 10 daqiqa va <= 8 MB; hech qayerda saqlanmaydi (faqat xotira orqali `logs.chunk`);
 *  - orqa bosim: ws buferi to'lsa follow qatorlari TASHLANADI (`dropped` hisobi bilan), snapshot esa kutadi.
 */

export interface LogProc {
  onStdout(cb: (chunk: Buffer) => void): void;
  onStderr(cb: (chunk: Buffer) => void): void;
  onExit(cb: (code: number | null) => void): void;
  kill(): void;
}

export interface RunResult {
  code: number | null;
  stdout: string;
}

export interface LogsTailDeps {
  log: Logger;
  /** `logs.chunk` yuborish; `false` = band/uzilgan (orqa bosim). */
  send: (p: LogsChunkPayload) => boolean;
  policy: () => Policy;
  bin?: (name: TrustedName) => string | undefined;
  /** Ro'yxat buyruqlari (`docker ps`, `systemctl list-units`): chiqish matni. Muddat/hajm chegaralangan. */
  run?: (bin: string, args: string[], timeoutMs: number) => Promise<RunResult>;
  spawn?: (bin: string, args: string[]) => LogProc;
  now?: () => number;
  home?: string;
  platform?: string;
  ops?: PathOps;
  sensitive?: readonly string[];
  /** Fayl follow so'rov oralig'i (ms). */
  filePollMs?: number;
  /** Snapshot yuborishda orqa bosim kutish (ms, tugash muddati bilan). */
  backpressureWaitMs?: number;
}

const fail = (code: CommandErrorCode, message: string): RunnerOutcome => ({ ok: false, code, message });

export const defaultRun = (bin: string, args: string[], timeoutMs: number): Promise<RunResult> =>
  new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024, cwd: tmpdir(), env: safeExecEnv(process.env), windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0;
      resolve({ code, stdout: typeof stdout === 'string' ? stdout : '' });
    });
  });

export const defaultSpawn = (bin: string, args: string[]): LogProc => {
  const child = spawn(bin, args, { cwd: tmpdir(), env: safeExecEnv(process.env), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  return {
    onStdout: (cb) => child.stdout.on('data', cb),
    onStderr: (cb) => child.stderr.on('data', cb),
    onExit: (cb) => {
      child.on('exit', (code) => cb(code));
      child.on('error', () => cb(null));
    },
    kill: () => {
      try {
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 2000).unref();
      } catch {
        /* allaqachon tugagan */
      }
    },
  };
};

interface Stream {
  id: string;
  seq: number;
  /** Yuborilmagan (redakt qilingan) qatorlar. */
  pending: string[];
  pendingBytes: number;
  dropped: number;
  truncated: boolean;
  totalBytes: number;
  totalLines: number;
  follow: boolean;
  ended: boolean;
  cleanup: Array<() => void>;
  red: LogRedactor;
  errTail: string;
}

type EndFn = (reason: LogEndReason, error?: { code: string; message: string }) => Promise<void>;

export class LogsTail {
  private readonly streams = new Map<string, { s: Stream; end: EndFn }>();
  private readonly now: () => number;
  private readonly home: string;
  private readonly platform: string;
  private readonly binOf: (n: TrustedName) => string | undefined;
  private readonly run: NonNullable<LogsTailDeps['run']>;
  private readonly spawnProc: NonNullable<LogsTailDeps['spawn']>;

  constructor(private readonly d: LogsTailDeps) {
    this.now = d.now ?? Date.now;
    this.home = d.home ?? homedir();
    this.platform = d.platform ?? osPlatform();
    this.binOf = d.bin ?? trustedBin;
    this.run = d.run ?? defaultRun;
    this.spawnProc = d.spawn ?? defaultSpawn;
  }

  get activeCount(): number {
    return this.streams.size;
  }

  /** Markaz `logs.stop` yubordi (yoki ulanish uzildi). */
  stop(commandId: string, reason: LogEndReason = 'stopped'): void {
    const e = this.streams.get(commandId);
    if (e) void e.end(reason);
  }

  stopAll(): void {
    for (const e of [...this.streams.values()]) void e.end('stopped');
  }

  async tail(commandId: string, p: LogsTailPayload): Promise<RunnerOutcome> {
    const policy = this.d.policy().remote;
    if (!policy.allowLogs) return fail('action_not_allowed', 'Logs are disabled in the local policy (agentd policy allow-logs)');
    if (this.streams.size >= LOG_LIMITS.maxStreamsPerAgent) return fail('logs_busy', 'Too many log streams are open on this machine');
    if (this.streams.has(commandId)) return fail('logs_busy', 'This log stream is already running');

    let sinceMs: number | undefined;
    if (p.since !== undefined) {
      sinceMs = parseSince(p.since, this.now());
      if (sinceMs === undefined) return fail('invalid_payload', 'invalid since');
    }
    if (p.source === 'file') return this.tailFile(commandId, p, sinceMs);
    return this.tailProcess(commandId, p, sinceMs);
  }

  // --- docker / journal ------------------------------------------------------------------------

  private async tailProcess(commandId: string, p: LogsTailPayload, sinceMs: number | undefined): Promise<RunnerOutcome> {
    let bin: string;
    let args: string[];
    if (p.source === 'docker') {
      const docker = this.binOf('docker');
      if (!docker) return fail('logs_source_unavailable', 'docker is not installed (or not in PATH) on this machine');
      const listed = await this.run(docker, ['ps', '-a', '--format', '{{.Names}}'], 10_000);
      if (listed.code !== 0) return fail('logs_source_unavailable', 'docker is not reachable (is the daemon running and the user allowed to use it?)');
      if (!parseDockerNames(listed.stdout).includes(p.name)) return fail('logs_not_found', 'No such container on this machine');
      bin = docker;
      args = ['logs', '--tail', String(p.lines), ...(sinceMs !== undefined ? ['--since', dockerSince(sinceMs)] : []), ...(p.follow ? ['--follow'] : []), '--', p.name];
    } else {
      if (this.platform !== 'linux') return fail('logs_source_unavailable', 'journal logs are only available on Linux machines');
      const journalctl = this.binOf('journalctl');
      const systemctl = this.binOf('systemctl');
      if (!journalctl || !systemctl) return fail('logs_source_unavailable', 'journalctl/systemctl is not available on this machine');
      const sys = await this.run(systemctl, ['list-units', '--all', '--type=service', '--plain', '--no-legend', '--no-pager'], 10_000);
      const usr = await this.run(systemctl, ['--user', 'list-units', '--all', '--type=service', '--plain', '--no-legend', '--no-pager'], 10_000);
      const sysUnit = sys.code === 0 ? matchUnit(p.name, parseUnitNames(sys.stdout)) : undefined;
      const usrUnit = usr.code === 0 ? matchUnit(p.name, parseUnitNames(usr.stdout)) : undefined;
      const unit = sysUnit ?? usrUnit;
      if (!unit) return fail('logs_not_found', 'No such systemd unit on this machine');
      bin = journalctl;
      args = [
        ...(sysUnit ? [] : ['--user']),
        `--unit=${unit}`,
        '-n',
        String(p.lines),
        '--no-pager',
        '-o',
        'short-iso',
        ...(sinceMs !== undefined ? [`--since=${journalSince(sinceMs)}`] : []),
        ...(p.follow ? ['--follow'] : []),
      ];
    }

    return new Promise<RunnerOutcome>((resolve) => {
      const s = this.newStream(commandId, p.follow === true);
      const proc = this.spawnProc(bin, args);
      const out = new LineSplitter();
      const err = new LineSplitter();
      let settled = false;
      const settle = (o: RunnerOutcome): void => {
        if (settled) return;
        settled = true;
        resolve(o);
      };
      s.cleanup.push(() => proc.kill());
      const end = this.register(s, async (reason, error) => {
        await this.finish(s, reason, error, p.follow !== true);
        if (!p.follow) {
          if (error) settle(fail(codeOf(error.code), error.message));
          else settle({ ok: true, result: { detail: `${s.totalLines} lines${s.truncated ? ' (truncated)' : ''}` } });
        }
      });
      proc.onStdout((b) => this.feed(s, out.push(b), end));
      proc.onStderr((b) => {
        const lines = err.push(b);
        for (const l of lines) s.errTail = redact(l).slice(0, 200);
        this.feed(s, lines, end);
      });
      proc.onExit((code) => {
        this.feed(s, [...out.end(), ...err.end()], end);
        if (s.ended) return;
        if (code === 0 || s.totalLines > 0) void end(p.follow ? 'ended' : 'complete');
        else void end('error', { code: 'logs_failed', message: s.errTail || `${bin.split('/').pop() ?? 'command'} exited with code ${code ?? 'null'}` });
      });
      const timeout = setTimeout(() => void end(p.follow ? 'timeout' : s.totalLines > 0 ? 'timeout' : 'error', p.follow || s.totalLines > 0 ? undefined : { code: 'logs_failed', message: 'timed out reading the logs' }), p.follow ? LOG_LIMITS.followMaxMs : LOG_LIMITS.snapshotTimeoutMs);
      timeout.unref();
      s.cleanup.push(() => clearTimeout(timeout));
      if (p.follow) this.startFlusher(s, end);
      if (p.follow) settle({ ok: true, result: { detail: 'follow started' } });
    });
  }

  // --- fayl ------------------------------------------------------------------------------------

  private async tailFile(commandId: string, p: LogsTailPayload, sinceMs: number | undefined): Promise<RunnerOutcome> {
    const roots = effectiveLogRoots(this.d.policy().remote.allowedLogRoots, this.home, this.platform);
    const ops = this.d.ops ?? realPathOps;
    const sensitive = this.d.sensitive ?? sensitiveDirs();
    const checked = checkLogFile(p.name, roots, ops, sensitive);
    if (!checked.ok) return fail(checked.code, checked.message);
    void sinceMs; // fayl satrlarida vaqt formati noma'lum: `since` fayl manbasida e'tiborsiz (so'nggi N qator)

    let fd: number;
    try {
      fd = openSync(checked.real, fsc.O_RDONLY | (fsc.O_NOFOLLOW ?? 0) | (fsc.O_NONBLOCK ?? 0));
    } catch {
      return fail('logs_failed', 'the log file could not be opened');
    }
    let st = fstatSync(fd);
    if (!st.isFile()) {
      closeSync(fd);
      return fail('path_invalid', 'the path is not a regular file');
    }

    const s = this.newStream(commandId, p.follow === true);
    let offset = st.size;
    let ino = st.ino;
    let carry = '';
    const readRange = (from: number, to: number): string => {
      const len = to - from;
      if (len <= 0) return '';
      const buf = Buffer.alloc(len);
      let got = 0;
      while (got < len) {
        const n = readSync(fd, buf, got, len - got, from + got);
        if (n <= 0) break;
        got += n;
      }
      return buf.subarray(0, got).toString('utf8');
    };

    return new Promise<RunnerOutcome>((resolve) => {
      let settled = false;
      const settle = (o: RunnerOutcome): void => {
        if (settled) return;
        settled = true;
        resolve(o);
      };
      s.cleanup.push(() => {
        try {
          closeSync(fd);
        } catch {
          /* allaqachon yopilgan */
        }
      });
      const end = this.register(s, async (reason, error) => {
        await this.finish(s, reason, error, p.follow !== true);
        if (!p.follow) {
          if (error) settle(fail(codeOf(error.code), error.message));
          else settle({ ok: true, result: { detail: `${s.totalLines} lines${s.truncated ? ' (truncated)' : ''}` } });
        }
      });

      try {
        const window = Math.min(st.size, 1024 * 1024);
        const text = readRange(st.size - window, st.size);
        this.feed(s, lastLines(text, p.lines, window === st.size), end);
      } catch (err) {
        this.d.log.warn('log faylini o\'qib bo\'lmadi', { error: errMsg(err).slice(0, 200) });
        void end('error', { code: 'logs_failed', message: 'the log file could not be read' });
        return;
      }

      if (!p.follow) {
        void end('complete');
        return;
      }
      this.startFlusher(s, end);
      settle({ ok: true, result: { detail: 'follow started' } });
      const poll = setInterval(() => {
        if (s.ended) return;
        try {
          // aylanish (rotation) / almashtirish: yo'l boshqa faylga ishora qilsa qayta tekshirib qayta ochamiz
          let pathStat: ReturnType<typeof lstatSync>;
          try {
            pathStat = lstatSync(checked.real);
          } catch {
            return; // vaqtincha yo'q (aylanish oralig'i): keyingi so'rovda
          }
          if (pathStat.ino !== ino || pathStat.size < offset) {
            const re = checkLogFile(p.name, roots, ops, sensitive);
            if (!re.ok || re.real !== checked.real) {
              void end('error', { code: 'logs_not_allowed', message: 'the log file path changed' });
              return;
            }
            try {
              closeSync(fd);
            } catch {
              /* ignore */
            }
            fd = openSync(checked.real, fsc.O_RDONLY | (fsc.O_NOFOLLOW ?? 0) | (fsc.O_NONBLOCK ?? 0));
            st = fstatSync(fd);
            ino = st.ino;
            offset = 0;
            carry = '';
          }
          const size = fstatSync(fd).size;
          if (size <= offset) return;
          const to = Math.min(size, offset + 256 * 1024);
          const text = carry + readRange(offset, to);
          offset = to;
          const parts = text.split('\n');
          carry = parts.pop() ?? '';
          if (carry.length > 64 * 1024) {
            parts.push(carry);
            carry = '';
          }
          this.feed(s, parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l)), end);
        } catch (err) {
          this.d.log.warn('log fayli follow xatosi', { error: errMsg(err).slice(0, 200) });
          void end('error', { code: 'logs_failed', message: 'the log file could not be read' });
        }
      }, this.d.filePollMs ?? 1000);
      poll.unref();
      s.cleanup.push(() => clearInterval(poll));
      const timeout = setTimeout(() => void end('timeout'), LOG_LIMITS.followMaxMs);
      timeout.unref();
      s.cleanup.push(() => clearTimeout(timeout));
    });
  }

  // --- umumiy oqim mexanikasi -------------------------------------------------------------------

  private newStream(id: string, follow: boolean): Stream {
    return { id, seq: 0, pending: [], pendingBytes: 0, dropped: 0, truncated: false, totalBytes: 0, totalLines: 0, follow, ended: false, cleanup: [], red: new LogRedactor(), errTail: '' };
  }

  private register(s: Stream, onEnd: (reason: LogEndReason, error?: { code: string; message: string }) => Promise<void>): EndFn {
    const end: EndFn = async (reason, error) => {
      if (s.ended) return;
      s.ended = true;
      for (const c of s.cleanup.splice(0)) c();
      this.streams.delete(s.id);
      await onEnd(reason, error);
    };
    this.streams.set(s.id, { s, end });
    return end;
  }

  /** Xom qatorlarni redakt qilib navbatga qo'shadi. Snapshot: oxirgi 256 KB saqlanadi; follow: bufer to'lsa eskilari tashlanadi. */
  private feed(s: Stream, raw: string[], end: EndFn): void {
    if (s.ended || raw.length === 0) return;
    const lines = s.red.lines(raw);
    for (const l of lines) {
      s.pending.push(l);
      const b = lineBytes(l);
      s.pendingBytes += b;
      s.totalBytes += b;
      s.totalLines++;
    }
    if (s.follow) {
      if (s.totalBytes > LOG_LIMITS.maxFollowBytes) {
        void end('byte_cap');
        return;
      }
      // follow: yuborilmagan navbat chegarasi (sekin aloqa): eng eskilari tashlanadi
      while (s.pending.length > LOG_LIMITS.chunkMaxLines * 5 || s.pendingBytes > LOG_LIMITS.chunkMaxBytes * 4) {
        const dropped = s.pending.shift();
        if (dropped === undefined) break;
        s.pendingBytes -= lineBytes(dropped);
        s.dropped++;
      }
      return;
    }
    // snapshot: oxirgi `maxSnapshotBytes`
    while (s.pendingBytes > LOG_LIMITS.maxSnapshotBytes && s.pending.length > 1) {
      const dropped = s.pending.shift()!;
      s.pendingBytes -= lineBytes(dropped);
      s.truncated = true;
    }
  }

  private startFlusher(s: Stream, end: EndFn): void {
    const t = setInterval(() => {
      if (s.ended) return;
      void this.flush(s, false).catch((err: unknown) => {
        this.d.log.warn('log chunk yuborilmadi', { error: errMsg(err).slice(0, 200) });
        void end('error', { code: 'logs_failed', message: 'could not deliver the log stream' });
      });
    }, LOG_LIMITS.followFlushMs);
    t.unref();
    s.cleanup.push(() => clearInterval(t));
  }

  /** Navbatni chunk'larga bo'lib yuboradi. `wait=true` (snapshot): orqa bosimda kutadi; aks holda tashlaydi (`dropped`). */
  private async flush(s: Stream, wait: boolean): Promise<void> {
    while (s.pending.length > 0) {
      const batch: string[] = [];
      let bytes = 0;
      while (s.pending.length > 0 && batch.length < LOG_LIMITS.chunkMaxLines) {
        const b = lineBytes(s.pending[0]!);
        if (batch.length > 0 && bytes + b > LOG_LIMITS.chunkMaxBytes) break;
        batch.push(s.pending.shift()!);
        bytes += b;
      }
      s.pendingBytes = Math.max(0, s.pendingBytes - bytes);
      const payload: LogsChunkPayload = { commandId: s.id, seq: s.seq, lines: batch, ...(s.dropped > 0 ? { dropped: s.dropped } : {}), ...(s.truncated && s.seq === 0 ? { truncated: true } : {}) };
      if (this.d.send(payload)) {
        s.seq++;
        s.dropped = 0;
        continue;
      }
      if (!wait) {
        // orqa bosim: bu partiyani tashlaymiz, hisobini keyingi chunk'da bildiramiz
        s.dropped += batch.length;
        continue;
      }
      // snapshot: bo'shashini kutamiz (cheklangan)
      const deadline = this.now() + (this.d.backpressureWaitMs ?? 10_000);
      let sent = false;
      while (this.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
        if (this.d.send(payload)) {
          sent = true;
          break;
        }
      }
      if (!sent) throw new Error('backpressure timeout');
      s.seq++;
      s.dropped = 0;
    }
  }

  /** Oqimni yakunlaydi: qolgan qatorlar + `done` chunk. Xato yuborilmasa ham `done` yuboriladi (klient tugaganini bilsin). */
  private async finish(s: Stream, reason: LogEndReason, error: { code: string; message: string } | undefined, wait: boolean): Promise<void> {
    try {
      await this.flush(s, wait);
    } catch (err) {
      this.d.log.warn('yakuniy log chunk yuborilmadi', { error: errMsg(err).slice(0, 200) });
    }
    this.d.send({
      commandId: s.id,
      seq: s.seq,
      lines: [],
      ...(s.dropped > 0 ? { dropped: s.dropped } : {}),
      ...(s.truncated && s.seq === 0 ? { truncated: true } : {}),
      done: true,
      reason,
      ...(error ? { error: { code: error.code.slice(0, 64), message: redact(error.message).slice(0, 300) } } : {}),
    });
    this.d.log.info('log oqimi tugadi', { commandId: s.id, reason, lines: s.totalLines, bytes: s.totalBytes });
  }
}

const KNOWN: ReadonlySet<string> = new Set(['logs_failed', 'logs_not_allowed', 'logs_not_found', 'logs_source_unavailable', 'logs_busy']);
const codeOf = (code: string): CommandErrorCode => (KNOWN.has(code) ? (code as CommandErrorCode) : 'logs_failed');
