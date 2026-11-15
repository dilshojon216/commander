import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LOG_LIMITS, LogsTailPayloadSchema, StartLogsBodySchema } from '@commander/contracts';
import { LineSplitter, LogRedactor, checkLogFile, defaultLogRoots, effectiveLogRoots, lastLines, matchUnit, parseDockerNames, parseSince, parseUnitNames } from './logs-source.js';

const posix = process.platform !== 'win32';
let dir: string;
let root: string;
let outside: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'cmdr-logs-'));
  root = path.join(dir, 'logs');
  outside = path.join(dir, 'outside');
  mkdirSync(path.join(root, 'sub'), { recursive: true });
  mkdirSync(outside);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('nom/payload validatsiyasi (injection)', () => {
  it('docker/journal nomi bayroq yoki shell belgisi bo\'la olmaydi', () => {
    for (const name of ['--follow', '-f', '-rf', 'a b', 'x;rm -rf /', '$(id)', 'a`b`', 'a|b', '../x', 'a\nb', '', 'a'.repeat(129)]) {
      expect(LogsTailPayloadSchema.safeParse({ source: 'docker', name, lines: 10 }).success, name).toBe(false);
      expect(LogsTailPayloadSchema.safeParse({ source: 'journal', name, lines: 10 }).success, name).toBe(false);
    }
    expect(LogsTailPayloadSchema.safeParse({ source: 'docker', name: 'web-1', lines: 10 }).success).toBe(true);
    expect(LogsTailPayloadSchema.safeParse({ source: 'journal', name: 'nginx.service', lines: 10 }).success).toBe(true);
  });
  it('fayl: faqat mutlaq yo\'l, ".." segmenti va NUL yo\'q', () => {
    for (const name of ['relative.log', './a.log', '/var/log/../etc/passwd', '/var/log/a\0b']) {
      expect(LogsTailPayloadSchema.safeParse({ source: 'file', name, lines: 10 }).success, name).toBe(false);
    }
    expect(LogsTailPayloadSchema.safeParse({ source: 'file', name: '/var/log/app.log', lines: 10 }).success).toBe(true);
  });
  it('lines <= 2000, since faqat nisbiy yoki ISO', () => {
    expect(LogsTailPayloadSchema.safeParse({ source: 'docker', name: 'a', lines: 2001 }).success).toBe(false);
    expect(LogsTailPayloadSchema.safeParse({ source: 'docker', name: 'a', lines: 0 }).success).toBe(false);
    for (const since of ['10m', '2h', '1d', '30s', '2026-11-14', '2026-11-14T10:00', '2026-11-14 10:00:05', '2026-11-14T10:00:05Z']) {
      expect(LogsTailPayloadSchema.safeParse({ source: 'docker', name: 'a', lines: 5, since }).success, since).toBe(true);
    }
    for (const since of ['--all', '10m; id', 'yesterday', '$(date)', '10 minutes ago', '-1h']) {
      expect(LogsTailPayloadSchema.safeParse({ source: 'docker', name: 'a', lines: 5, since }).success, since).toBe(false);
    }
  });
  it('REST tana: default lines, ortiqcha maydon rad', () => {
    expect(StartLogsBodySchema.parse({ source: 'docker', name: 'a' }).lines).toBe(LOG_LIMITS.defaultLines);
    expect(StartLogsBodySchema.safeParse({ source: 'docker', name: 'a', extra: 1 }).success).toBe(false);
  });
});

describe('ro\'yxatlar', () => {
  it('docker nomlari: bayroq ko\'rinishidagi qatorlar tashlanadi', () => {
    expect(parseDockerNames('web-1\n--rm\n-x\n\napi_2\nweb-1\n')).toEqual(['web-1', 'api_2']);
  });
  it('systemd birliklari: birinchi ustun, bullet o\'tkaziladi', () => {
    const out = 'nginx.service loaded active running A web server\n● bad.service loaded failed failed Bad\nuser@1000.service loaded active running User\ngarbage line\n';
    expect(parseUnitNames(out)).toEqual(['nginx.service', 'bad.service', 'user@1000.service']);
  });
  it('matchUnit: faqat ro\'yxatdagi aniq moslik', () => {
    const units = ['nginx.service', 'docker.service'];
    expect(matchUnit('nginx', units)).toBe('nginx.service');
    expect(matchUnit('nginx.service', units)).toBe('nginx.service');
    expect(matchUnit('--user', units)).toBeUndefined();
    expect(matchUnit('nginx.service --follow', units)).toBeUndefined();
    expect(matchUnit('ssh', units)).toBeUndefined();
  });
});

describe('parseSince', () => {
  const now = Date.parse('2026-11-14T12:00:00Z');
  it('nisbiy va mutlaq', () => {
    expect(parseSince('10m', now)).toBe(now - 600_000);
    expect(parseSince('2h', now)).toBe(now - 7_200_000);
    expect(parseSince('2026-11-14', now)).toBe(Date.parse('2026-11-14T00:00:00Z'));
    expect(parseSince('2026-11-14 10:30', now)).toBe(Date.parse('2026-11-14T10:30:00Z'));
    expect(parseSince('2026-11-14T10:30:05Z', now)).toBe(Date.parse('2026-11-14T10:30:05Z'));
  });
  it('yaroqsiz -> undefined', () => {
    expect(parseSince('--all', now)).toBeUndefined();
    expect(parseSince('2026-13-45', now)).toBeUndefined();
  });
});

describe('checkLogFile (ruxsat etilgan ildizlar)', () => {
  it('ildiz ichidagi oddiy fayl ruxsat', () => {
    const f = path.join(root, 'sub', 'a.log');
    writeFileSync(f, 'x\n');
    const r = checkLogFile(f, [root], undefined, []);
    expect(r.ok).toBe(true);
  });
  it('bo\'sh ildizlar: hech narsaga ruxsat yo\'q', () => {
    const f = path.join(root, 'a.log');
    writeFileSync(f, 'x');
    const r = checkLogFile(f, [], undefined, []);
    expect(r).toMatchObject({ ok: false, code: 'logs_not_allowed' });
  });
  it('ildizdan tashqari fayl rad; ".." orqali chiqish rad', () => {
    const f = path.join(outside, 'secret.log');
    writeFileSync(f, 's');
    expect(checkLogFile(f, [root], undefined, [])).toMatchObject({ ok: false, code: 'logs_not_allowed' });
    expect(checkLogFile(path.join(root, 'sub', '..', '..', 'outside', 'secret.log'), [root], undefined, [])).toMatchObject({ ok: false, code: 'logs_not_allowed' });
  });
  it('nisbiy yo\'l, mavjud bo\'lmagan fayl, papka', () => {
    expect(checkLogFile('a.log', [root], undefined, [])).toMatchObject({ ok: false, code: 'path_invalid' });
    expect(checkLogFile(path.join(root, 'none.log'), [root], undefined, [])).toMatchObject({ ok: false, code: 'file_not_found' });
    expect(checkLogFile(path.join(root, 'sub'), [root], undefined, [])).toMatchObject({ ok: false, code: 'path_invalid' });
  });
  it.runIf(posix)('symlink: ildizdan tashqariga ishora qilsa rad; ildiz ichidagi nishonga ruxsat', () => {
    const secret = path.join(outside, 'secret.log');
    writeFileSync(secret, 's');
    const escape = path.join(root, 'escape.log');
    symlinkSync(secret, escape);
    expect(checkLogFile(escape, [root], undefined, [])).toMatchObject({ ok: false, code: 'logs_not_allowed' });
    const real = path.join(root, 'real.log');
    writeFileSync(real, 'r');
    const link = path.join(root, 'link.log');
    symlinkSync(real, link);
    expect(checkLogFile(link, [root], undefined, [])).toMatchObject({ ok: true });
    // papka symlink'i orqali chiqish
    symlinkSync(outside, path.join(root, 'outdir'));
    expect(checkLogFile(path.join(root, 'outdir', 'secret.log'), [root], undefined, [])).toMatchObject({ ok: false, code: 'logs_not_allowed' });
  });
  it('maxfiy papka ildiz ichida bo\'lsa ham rad', () => {
    const sens = path.join(root, '.ssh');
    mkdirSync(sens);
    const f = path.join(sens, 'id.log');
    writeFileSync(f, 'k');
    expect(checkLogFile(f, [root], undefined, [sens])).toMatchObject({ ok: false, code: 'logs_not_allowed' });
  });
  it('standart ildiz: faqat macOS ~/Library/Logs/commander', () => {
    expect(defaultLogRoots('/Users/x', 'darwin')).toEqual(['/Users/x/Library/Logs/commander']);
    expect(defaultLogRoots('/home/x', 'linux')).toEqual([]);
    expect(effectiveLogRoots(['/var/log/app'], '/Users/x', 'darwin')).toEqual(['/var/log/app', '/Users/x/Library/Logs/commander']);
  });
});

describe('LogRedactor', () => {
  it('tokenlar va sarlavhalar maskalanadi', () => {
    const r = new LogRedactor();
    const out = r.lines(['GET / Authorization: Bearer abcdef0123456789abcdef', 'token=ghp_' + 'a'.repeat(30), 'DATABASE_URL=postgres://u:pw@h/db', 'oddiy qator']);
    expect(out.join('\n')).not.toMatch(/abcdef0123456789|ghp_a{30}|u:pw@/);
    expect(out[3]).toBe('oddiy qator');
  });
  it('PEM kaliti qatorlar/chunklar chegarasidan oshsa ham chiqmaydi', () => {
    const r = new LogRedactor();
    const a = r.lines(['start', '-----BEGIN RSA PRIVATE KEY-----', 'MIIEowIBAAKCAQEA']);
    const b = r.lines(['abcdefghijklmnop', '-----END RSA PRIVATE KEY-----', 'after']);
    expect([...a, ...b].join('\n')).not.toMatch(/MIIEow|abcdefghijklmnop/);
    expect(b).toEqual(['after']);
    expect(a[0]).toBe('start');
  });
  it('ANSI va boshqaruv belgilari olib tashlanadi; uzun qator kesiladi', () => {
    const r = new LogRedactor();
    const [a, b] = r.lines(['\u001b[31mERROR\u001b[0m boom\u0007', 'x'.repeat(5000)]);
    expect(a).toBe('ERROR boom');
    expect(b!.length).toBeLessThanOrEqual(LOG_LIMITS.lineMaxChars + 20);
    expect(b!.endsWith('[truncated]')).toBe(true);
  });
  it('tugamagan PEM holati cheksiz yutmaydi', () => {
    const r = new LogRedactor();
    r.lines(['-----BEGIN PRIVATE KEY-----']);
    const lines = Array.from({ length: 500 }, (_, i) => `k${i}`);
    const out = r.lines(lines);
    expect(out.length).toBeGreaterThan(0); // 400 qatordan keyin yana chiqadi
  });
});

describe('LineSplitter / lastLines', () => {
  it('UTF-8 belgisi bo\'laklar orasida bo\'linsa ham butun', () => {
    const s = new LineSplitter();
    const buf = Buffer.from('salom 🌍\nikkinchi\r\nuchinchi');
    const mid = buf.indexOf(0xf0) + 2;
    const out = [...s.push(buf.subarray(0, mid)), ...s.push(buf.subarray(mid))];
    expect(out).toEqual(['salom 🌍', 'ikkinchi']);
    expect(s.end()).toEqual(['uchinchi']);
  });
  it('lastLines', () => {
    expect(lastLines('a\nb\nc\nd\n', 2, true)).toEqual(['c', 'd']);
    expect(lastLines('partial\nb\nc\n', 5, false)).toEqual(['b', 'c']);
  });
});
