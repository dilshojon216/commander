#!/usr/bin/env node
import { createConnection } from 'node:net';
import { parseArgs } from 'node:util';
import { loadConfig, saveConfig } from './config.js';
import { fingerprintOf } from './center-pin.js';
import { runPolicyCli } from './policy.js';
import { startDaemon } from './daemon.js';
import { enroll } from './enroll.js';
import { createRotatingFileWriter } from './log-file.js';
import { createLogger, errMsg } from './logger.js';
import { watchParent } from './parent-watch.js';
import { resolvePaths } from './paths.js';
import { AGENTD_VERSION } from './version.js';

const USAGE = `agentd ${AGENTD_VERSION}

Foydalanish:
  agentd enroll --center <https url> (--code <kod|->|--code-stdin) [--force] [--claude-bin <yo'l>] [--statusline-cmd <buyruq>]
  agentd run [--center <url>] [--otlp-port <port>] [--log-file <yo'l>] [--exit-with-parent]     (default buyruq; --log-file yoki AGENTD_LOG_FILE: aylanuvchi fayl logi;
                                                       --exit-with-parent: ota jarayon o'lsa to'xtaydi, Windows ishga tushiruvchisi uchun)
  agentd policy [show|enable|disable|allow-root <papka>|remove-root <papka>|allow-home|deny-home|allow-auto|deny-auto]   (masofaviy boshqaruv siyosati, default: O'CHIQ)
  agentd center-key [show|reset [--key <b64url>]]        (markaz buyruq-imzo kaliti pin'i; reset keyin agentd'ni qayta ishga tushiring)
  agentd rotate-key                                     (qurilma Ed25519 kalitini aylantiradi: eski+yangi kalit bilan imzolangan so'rov, markaz kalitni atomik almashtiradi; agentd ishlab turishi va online bo'lishi shart)
  agentd status                                         (ishlayotgan agentd holati, lokal socket orqali)
  agentd version
`;

/** Konsolsiz ishga tushganda (Windows Scheduled Task) stderr yo'qoladi: `--log-file`/`AGENTD_LOG_FILE` bo'lsa log (va FATAL) faylga ham yoziladi. */
let writeLog: (line: string) => void = (line) => void process.stderr.write(line + '\n');

function setupLogFile(argv: string[]): void {
  const i = argv.indexOf('--log-file');
  const file = (i >= 0 ? argv[i + 1] : undefined) ?? process.env['AGENTD_LOG_FILE'];
  if (!file) return;
  const toFile = createRotatingFileWriter(file);
  const toStderr = writeLog;
  writeLog = (line) => {
    toStderr(line);
    toFile(line);
  };
}

async function main(argv: string[]): Promise<number> {
  const command = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'run';
  const rest = command === argv[0] ? argv.slice(1) : argv;
  setupLogFile(rest);
  const log = createLogger({ write: (line) => writeLog(line) });
  const paths = resolvePaths();

  const { values } = parseArgs({
    args: rest,
    allowPositionals: true,
    strict: false,
    options: {
      center: { type: 'string' },
      code: { type: 'string' },
      'code-stdin': { type: 'boolean' },
      force: { type: 'boolean' },
      'claude-bin': { type: 'string' },
      'statusline-cmd': { type: 'string' },
      'otlp-port': { type: 'string' },
      'log-file': { type: 'string' },
      'exit-with-parent': { type: 'boolean' },
      key: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

  switch (command) {
    case 'version':
      process.stdout.write(AGENTD_VERSION + '\n');
      return 0;

    case 'enroll': {
      const center = str(values.center);
      const codeArg = str(values.code);
      const useCodeStdin = values['code-stdin'] === true;

      let code: string | undefined;
      if (useCodeStdin) {
        code = await readStdinLine();
      } else if (codeArg) {
        code = codeArg === '-' ? (await readStdinLine()) : codeArg;
      }

      if (!center || !code) {
        process.stderr.write('xato: --center va (--code <kod|-> yoki --code-stdin) majburiy\n' + USAGE);
        return 2;
      }
      const claudeBin = str(values['claude-bin']);
      const statuslineCommand = str(values['statusline-cmd']);
      const res = await enroll(
        paths,
        { centerUrl: center, code, force: values.force === true, ...(claudeBin ? { claudeBin } : {}), ...(statuslineCommand ? { statuslineCommand } : {}) },
        log,
      );
      process.stdout.write(`enrollment tayyor: deviceId=${res.deviceId} machineId=${res.machineId}\nkonfiguratsiya: ${paths.configFile}\n`);
      return 0;
    }

    case 'status':
      return queryStatus(paths.socketFile);

    case 'rotate-key':
      return rotateKeyViaDaemon(paths.socketFile);

    case 'policy':
      return runPolicyCli(paths, rest.filter((a) => !a.startsWith('--')), (t) => void process.stdout.write(t), (t) => void process.stderr.write(t));

    case 'center-key': {
      const sub = rest.find((a) => !a.startsWith('--')) ?? 'show';
      const config = loadConfig(paths);
      if (sub === 'show') {
        const k = config.centerKey;
        process.stdout.write(k ? `pinned: ${k.fingerprint} (${k.via}, ${k.pinnedAt})\npublic key: ${k.publicKey}\n` : 'pin yo\'q: masofaviy buyruqlar rad etiladi (markazga ulanganda TOFU bilan pin qilinadi)\n');
        return 0;
      }
      if (sub === 'reset') {
        const manual = str(values.key);
        if (manual !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(manual)) {
          process.stderr.write('xato: --key xom 32 bayt Ed25519 public key (base64url, 43 belgi) bo\'lishi kerak\n');
          return 2;
        }
        const { centerKey: _old, ...rest2 } = config;
        saveConfig(paths, manual ? { ...rest2, centerKey: { publicKey: manual, fingerprint: fingerprintOf(manual), pinnedAt: new Date().toISOString(), via: 'manual' } } : rest2);
        process.stdout.write(manual ? `pin qo'lda o'rnatildi: ${fingerprintOf(manual)}\n` : 'pin o\'chirildi: keyingi ulanishda markaz kaliti qayta pin qilinadi (TOFU). Markazdagi "center-key show" bilan solishtiring.\n');
        return 0;
      }
      process.stderr.write(`noma'lum center-key buyrug'i: ${sub}\n`);
      return 2;
    }

    case 'run': {
      const config = loadConfig(paths);
      const centerUrl = str(values.center);
      const port = str(values['otlp-port']);
      const handle = await startDaemon({
        paths,
        config,
        log,
        installTaskCommand: true,
        ...(centerUrl ? { centerUrl } : {}),
        ...(port ? { otlpPort: Number(port) } : {}),
      });
      await new Promise<void>((resolve) => {
        const shutdown = (sig: string): void => {
          log.info('signal olindi, to\'xtatilyapti', { signal: sig });
          void handle.stop().finally(resolve);
        };
        process.once('SIGTERM', () => shutdown('SIGTERM'));
        process.once('SIGINT', () => shutdown('SIGINT'));
        if (values['exit-with-parent'] === true) watchParent(process.ppid, () => shutdown('parent-exit'));
      });
      return 0;
    }

    default:
      process.stderr.write(`noma'lum buyruq: ${command}\n` + USAGE);
      return 2;
  }
}

/** stdin'dan bitta qator (enrollment kodi): `--code -`. Kod argv'da (jarayonlar ro'yxatida) ko'rinmaydi. */
async function readStdinLine(): Promise<string | undefined> {
  let text = '';
  for await (const chunk of process.stdin) {
    text += String(chunk);
    if (text.includes('\n') || text.length > 4096) break;
  }
  const line = text.split(/\r?\n/, 1)[0]?.trim();
  return line ? line : undefined;
}

/** `rotate-key`: ishlayotgan agentd'ga lokal socket orqali buyruq (kalit uning xotirasida va WS ulanishi unda). */
function rotateKeyViaDaemon(socketFile: string): Promise<number> {
  return new Promise((resolve) => {
    const c = createConnection(socketFile);
    let out = '';
    c.setTimeout(40_000, () => c.destroy());
    c.on('connect', () => c.end(JSON.stringify({ v: 1, kind: 'rotate-key' }) + '\n'));
    c.on('data', (d: Buffer) => (out += d.toString('utf8')));
    c.on('error', () => {
      process.stderr.write(`agentd ishlamayapti (${socketFile} ga ulanib bo'lmadi): kalitni aylantirish uchun agentd ishlab turishi kerak\n`);
      resolve(1);
    });
    c.on('close', () => {
      try {
        const r = JSON.parse(out) as { ok?: boolean; fingerprint?: string; reason?: string; error?: string };
        if (r.ok) {
          process.stdout.write(`kalit aylantirildi (yangi kalit: ${r.fingerprint ?? '?'}...). Eski kalit endi markaz tomonidan rad etiladi.\n`);
          resolve(0);
          return;
        }
        process.stderr.write(`kalit aylantirilmadi: ${r.reason ?? r.error ?? "noma'lum xato"}\n`);
      } catch {
        process.stderr.write("agentd'dan javob kelmadi\n");
      }
      resolve(1);
    });
  });
}

function queryStatus(socketFile: string): Promise<number> {
  return new Promise((resolve) => {
    const c = createConnection(socketFile);
    let out = '';
    c.setTimeout(3000, () => c.destroy());
    c.on('connect', () => c.end(JSON.stringify({ v: 1, kind: 'status' }) + '\n'));
    c.on('data', (d: Buffer) => (out += d.toString('utf8')));
    c.on('error', () => {
      process.stderr.write(`agentd ishlamayapti (${socketFile} ga ulanib bo'lmadi)\n`);
      resolve(1);
    });
    c.on('close', () => {
      if (out) {
        process.stdout.write(out);
        resolve(0);
      }
    });
  });
}

process.on('uncaughtException', (err) => {
  writeLog(`FATAL uncaughtException: ${errMsg(err)}`);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  writeLog(`FATAL unhandledRejection: ${errMsg(err)}`);
  process.exit(1);
});

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    writeLog(`xato: ${errMsg(err)}`);
    process.exit(1);
  },
);
