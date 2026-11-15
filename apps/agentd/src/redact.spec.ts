import { describe, expect, it } from 'vitest';
import { redact } from './redact.js';

const LEAK = 'S3cr3tV4lue99';
describe('redact', () => {
  const cases: Array<[string, string]> = [
    ['curl -H "Authorization: Bearer abcdefghijklmnop1234" https://x', 'abcdefghijklmnop1234'],
    ['curl -H "Authorization: Basic dXNlcjpwYXNz" https://x', 'dXNlcjpwYXNz'],
    ['curl -H "X-Api-Key: ' + LEAK + '" u', LEAK],
    ['Cookie: sid=' + LEAK, LEAK],
    ['export API_TOKEN=' + LEAK, LEAK],
    ['export DB_PASSWORD="' + LEAK + ' with space"', LEAK],
    ['DATABASE_URL=postgres://u:' + LEAK + '@h/db', LEAK],
    ['git clone https://user:' + LEAK + '@github.com/a/b', LEAK],
    ['{"api_key":"' + LEAK + '","x":1}', LEAK],
    ['{"command":"echo","password": "' + LEAK + '"}', LEAK],
    ['key sk-ant-api03-abcdefghijkl', 'abcdefghijkl'],
    ['ghp_abcdefghijklmnopqrstuvwx1234', 'abcdefghijklmnopqrstuvwx'],
    ['AKIAABCDEFGHIJKLMNOP', 'AKIAABCDEFGHIJKLMNOP'],
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig_abc', 'eyJzdWIi'],
    ['-----BEGIN RSA PRIVATE KEY-----\\nMIIEvQ' + LEAK + '\\n-----END RSA PRIVATE KEY-----', LEAK],
    ['-----BEGIN PRIVATE KEY-----\nabc' + LEAK, LEAK],
    ['xoxb-1234567890-abcdefghij', 'abcdefghij'],
  ];
  it.each(cases)('maskalaydi: %s', (input, secret) => {
    const out = redact(input);
    expect(out).not.toContain(secret);
    expect(out).toContain('REDACTED');
  });
  it("oddiy buyruqqa tegmaydi", () => {
    expect(redact('echo hi && ls -la /tmp')).toBe('echo hi && ls -la /tmp');
    expect(redact('{"command":"echo hi"}')).toBe('{"command":"echo hi"}');
  });
});

import { redactChatText } from './redact.js';

describe('redact: qo\'shimcha shakllar va chat matni', () => {
  const extra: Array<[string, string]> = [
    ['glpat-abcdefghijklmnopqrst', 'abcdefghijklmnopqrst'],
    ['hf_abcdefghijklmnopqrstuvwxyzabcd', 'abcdefghijklmnopqrstuvwxyzabcd'],
    ['SG.abcdefghijklmnopqr.stuvwxyz0123456789', 'stuvwxyz0123456789'],
    ['bot 123456789:AAabcdefghijklmnopqrstuvwxyz0123456789', 'abcdefghijklmnopqrstuvwxyz0123456789'],
    ['mytool --password hunter2hunter2 run', 'hunter2hunter2'],
    ['mytool --token=hunter2hunter2', 'hunter2hunter2'],
    ['curl -u admin:hunter2hunter2 https://x', 'hunter2hunter2'],
  ];
  it.each(extra)('maskalaydi: %s', (input, secret) => {
    const out = redact(input);
    expect(out).not.toContain(secret);
  });

  it('.env qatorlari nomi sirli bo\'lmasa ham maskalanadi (faqat chat matni)', () => {
    const env = 'NODE_ENV=production\nSMTP_HOST=mail.internal.example\nexport FOO_BAR=baz qux\nnormal text line';
    const out = redactChatText(env);
    expect(out).not.toContain('production');
    expect(out).not.toContain('mail.internal.example');
    expect(out).not.toContain('baz qux');
    expect(out).toContain('normal text line');
    expect(out).toContain('SMTP_HOST=[REDACTED]');
  });

  it('buyruq ichidagi VAR=val ga tegmaydi (qator boshida emas)', () => {
    expect(redactChatText('run FOO=bar npm test')).toBe('run FOO=bar npm test');
  });
});

describe('redact: qamrov bo\'shliqlari (M-21)', () => {
  const gaps: Array<[string, string]> = [
    ['curl https://api.telegram.org/bot123456789:AAabcdefghijklmnopqrstuvwxyz0123456789/getMe', 'abcdefghijklmnopqrstuvwxyz0123456789'],
    ['-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQdGBF' + LEAK + '\n-----END PGP PRIVATE KEY BLOCK-----', LEAK],
    ['postgres://user:pa/ss' + LEAK + '@db.internal/app', LEAK],
    ['postgres://user:p@' + LEAK + '@db.internal/app', LEAK],
    ['curl -X POST https://hooks.slack.com/services/T01ABCDEF/B02GHIJKL/' + LEAK + 'abcdefgh', LEAK],
    ['https://discord.com/api/webhooks/123456789012345678/' + LEAK + 'abcdefghijklmn', LEAK],
    ['aws_key wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'],
    ['twine upload -p pypi-AgEIcHlwaS5vcmcCJGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6MDEyMzQ1Njc4OQ', 'AgEIcHlwaS5vcmc'],
    ['{"refresh_token":"1//0gAbCdEfGhIjKlMnOpQrStUvWxYz0123456789_abc"}', '0gAbCdEfGhIjKlMnOpQrStUvWxYz'],
    ['Bearer ' + LEAK, LEAK],
    ['curl --user=admin:' + LEAK + ' https://x', LEAK],
    ['sshpass -p ' + LEAK + ' ssh host', LEAK],
    ['sshpass -p' + LEAK + ' ssh host', LEAK],
    ['mysql -u root -p' + LEAK + ' mydb', LEAK],
    ['docker login -u me -p ' + LEAK + ' registry.io', LEAK],
    ['{"password": 123456789}', '123456789'],
    ['API-KEY: ' + LEAK, LEAK],
    ['PASSWORD=my long ' + LEAK + ' phrase', LEAK],
    ['cmdr_abcd1234', 'abcd1234'],
    ['x-api-key: ' + LEAK, LEAK],
    ['pypi: ' + 'pypi-' + 'A'.repeat(60), 'AAAAAAAAAA'],
  ];
  it.each(gaps)('maskalaydi: %s', (input, secret) => {
    expect(redact(input)).not.toContain(secret);
  });

  it('yolg\'on ijobiylar: git SHA, oddiy yo\'l, "bearer" so\'zi', () => {
    const sha = 'a'.repeat(8) + '0123456789abcdef0123456789abcdef';
    expect(redact(`commit ${sha}`)).toBe(`commit ${sha}`);
    expect(redact('see src/components/Button/index.tsx and docs/README.md')).toBe('see src/components/Button/index.tsx and docs/README.md');
    expect(redact('the bearer ok')).toBe('the bearer ok');
    expect(redact('mysql -p mydb')).toBe('mysql -p mydb');
  });
});

describe('redact: ReDoS / ishlash (M-17)', () => {
  const MB = 1024 * 1024;
  const families: Record<string, string> = {
    TOKEN: 'TOKEN'.repeat(Math.ceil(MB / 5)),
    'token-': 'token-'.repeat(Math.ceil(MB / 6)),
    'a.a.': 'a.'.repeat(Math.ceil(MB / 2)),
    'a-a-': 'a-'.repeat(Math.ceil(MB / 2)),
    'eyJ-': 'eyJ-'.repeat(Math.ceil(MB / 4)),
    BEGIN: '-----BEGIN PRIVATE KEY-----'.repeat(Math.ceil(MB / 26)),
    'x://a:': 'x://a:'.repeat(Math.ceil(MB / 6)),
    'NAME="': 'API_KEY="'.repeat(Math.ceil(MB / 9)),
    "NAME='": "PASSWORD='".repeat(Math.ceil(MB / 10)),
    spaces: 'cookie' + ' '.repeat(MB),
    quotes: '"api_key":'.repeat(Math.ceil(MB / 10)),
    Bearer: 'Bearer '.repeat(Math.ceil(MB / 7)),
    '-u': ' -u '.repeat(Math.ceil(MB / 4)),
    mysql: 'mysql '.repeat(Math.ceil(MB / 6)),
    b64: 'Ab1/'.repeat(Math.ceil(MB / 4)),
    newlines: 'TOKEN=\n'.repeat(Math.ceil(MB / 7)),
  };
  /**
   * Yuklamaga chidamli o'lchov (6.19). Devor soati (`performance.now`) parallel test yuklamasida
   * (CPU 8-10x band) yolg'on yiqiladi: jarayon navbat kutgan vaqt ham hisoblanadi, va katta kirish
   * kichigidan ko'proq preempt qilinadi (nisbat ham buziladi). Shuning uchun shu oqimning CPU vaqti
   * o'lchanadi (`process.threadCpuUsage`, Node >= 23.9; bo'lmasa jarayon CPU vaqti — vitest `forks`
   * pool'ida har fayl alohida jarayon). CPU vaqti navbat kutishni hisoblamaydi, regex ishini esa
   * to'liq hisoblaydi — halokatli backtracking baribir chegaradan oshadi.
   */
  const cpuMs = (fn: () => unknown): number => {
    const usage = (process as { threadCpuUsage?: (prev?: NodeJS.CpuUsage) => NodeJS.CpuUsage }).threadCpuUsage?.bind(process) ?? process.cpuUsage.bind(process);
    const t0 = usage();
    fn();
    const d = usage(t0);
    return (d.user + d.system) / 1000;
  };
  /**
   * Kichik (MB/8) va katta (MB) kirish NAVBATMA-NAVBAT `rounds` marta, har biri uchun eng yaxshisi.
   * `ratio` = katta / kichik: chiziqli ~8, kvadratik ~64, eksponensial — cheksiz.
   */
  const scaling = (fn: (s: string) => unknown, input: string, rounds = 3): { big: number; small: number; ratio: number } => {
    const small = input.slice(0, MB / 8);
    const large = input.slice(0, MB);
    fn(small); // JIT/regex kompilyatsiyasini o'lchovdan chiqarish
    let bestSmall = Infinity;
    let bestBig = Infinity;
    for (let i = 0; i < rounds; i++) {
      bestSmall = Math.min(bestSmall, cpuMs(() => fn(small)));
      bestBig = Math.min(bestBig, cpuMs(() => fn(large)));
    }
    return { big: bestBig, small: bestSmall, ratio: bestBig / Math.max(bestSmall, 0.05) };
  };
  /** Yolg'iz o'lchovda barcha oilalar ~8.0; 24 — 3x shovqin zaxirasi, kvadratik (~64) dan ancha past. */
  const MAX_RATIO = 24;
  /** Kichik kirish shundan tez bo'lsa nisbat ishonchsiz (o'lchov aniqligi); bunda faqat absolyut chegara. */
  const RATIO_FLOOR_MS = 1;

  for (const [name, input] of Object.entries(families)) {
    it(`1 MB "${name}" chiziqli (< 1 s CPU, MB/8 -> MB nisbati < ${MAX_RATIO})`, () => {
      const m = scaling(redactChatText, input);
      expect(m.big).toBeLessThan(1000);
      if (m.small >= RATIO_FLOOR_MS) expect(m.ratio).toBeLessThan(MAX_RATIO);
    });
  }
  it('1 MB TOKEN* < 200 ms (CPU vaqti, eng yaxshisi)', () => {
    const m = scaling(redact, families['TOKEN'] as string, 5);
    expect(m.big).toBeLessThan(200);
    expect(m.ratio).toBeLessThan(MAX_RATIO);
  });
  it('2 MB dan katta kirish: ortiqchasi tashlanadi va sir chiqmaydi', () => {
    const out = redact('a '.repeat(2 * MB) + 'API_TOKEN=' + LEAK);
    expect(out).not.toContain(LEAK);
    expect(out.length).toBeLessThan(2 * MB + 200);
  });
});
