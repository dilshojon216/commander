import { describe, expect, it } from 'vitest';
import { detectDanger, buildPreview } from './preview.js';
import { redactText } from './redact-text.js';

/**
 * H-03 (ReDoS): hujumchi boshqaradigan 64 KB kiritma < 50 ms. Review'dagi kubik holat (6000 belgi ~ 10 s) va
 * har bir regex turi uchun adversarial shakllar. Vaqt o'lchovi qizdirilgandan keyin, eng yaxshi 3 urinish.
 */
const SIZE = 65_536;
const rep = (unit: string): string => unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE);

const ADVERSARIAL: Array<[string, string]> = [
  ['token-token chain (review PoC)', rep('token-')],
  ['token_token chain', rep('token_')],
  ['api_key repeats no sep', rep('api_key')],
  ['secret spaces', rep('secret ')],
  ['TOKEN=a TOKEN=a', rep('TOKEN=a ')],
  ['key="unterminated', `API_TOKEN="${'x'.repeat(SIZE)}`],
  ['key=$( unbalanced', `TOKEN=$(${'('.repeat(SIZE)}`],
  ['key=$(a)$(a)...', `TOKEN=${rep('$(a)')}`],
  ['key=`a`...', `TOKEN=${rep('`a`')}`],
  ['nested subst', `TOKEN=${'$('.repeat(1000)}x${')'.repeat(1000)}`],
  ['jwt-like no dots', rep('eyJaaaaaaaaaa-')],
  ['jwt-like partial', rep('eyJaaaaaaaaaa.eyJbbbbbbbbbb.')],
  ['sk- short runs', rep('sk-aaaaaaaaaaaaaaaaaaa ')],
  ['sk- long no boundary', `sk-${rep('a-')}`],
  ['Bearer spaces', `Bearer${' '.repeat(SIZE)}x`],
  ['Bearer repeats', rep('Bearer ')],
  ['url creds no @', rep('://a:b')],
  ['url creds long', `://user:${'p'.repeat(SIZE)}`],
  ['url colons', rep('://a:://a:')],
  ['pem unterminated', rep('-----BEGIN PRIVATE KEY-----\n')],
  ['pem begin spaces', `-----BEGIN ${'A '.repeat(SIZE / 2)}`],
  ['digits (telegram)', '1'.repeat(SIZE)],
  ['digits colon', rep('12345678:')],
  ['--password flag repeats', rep('--password ')],
  ['mysql -p repeats', rep('mysql -u x ')],
  ['sshpass', rep('sshpass -p ')],
  ['whitespace', ' '.repeat(SIZE)],
  ['newlines', '\n'.repeat(SIZE)],
  ['dots dashes', rep('a.-')],
  ['quotes', `"${rep('token"')}`],
  ['all keywords', rep('passwordtokensecretcredentialapikey_private_key:')],
  ['ghp prefix repeats', rep('ghp_aaaa ')],
  ['slack hook', rep('https://hooks.slack.com/services/')],
];

function bestOf3(fn: () => unknown): number {
  fn();
  let best = Infinity;
  for (let i = 0; i < 3; i += 1) {
    const t = performance.now();
    fn();
    best = Math.min(best, performance.now() - t);
  }
  return best;
}

describe('redactText: linear time on adversarial 64 KB inputs (H-03)', () => {
  for (const [name, input] of ADVERSARIAL) {
    it(`${name} < 50 ms`, () => {
      expect(input.length).toBeLessThanOrEqual(SIZE + 64);
      expect(bestOf3(() => redactText(input))).toBeLessThan(50);
    });
  }

  it('the review PoC: 6000 chars of token- no longer takes seconds', () => {
    expect(bestOf3(() => redactText('token-'.repeat(1000)))).toBeLessThan(10);
  });

  it('inputs above the hard cap are cut, never scanned whole', () => {
    const huge = 'a '.repeat(2_000_000);
    const out = redactText(huge);
    expect(out.length).toBeLessThan(1_048_576 + 64);
    expect(out.endsWith('…[kesildi: juda uzun]')).toBe(true);
  });
});

describe('danger detection / preview: linear time on adversarial inputs', () => {
  for (const [name, input] of ADVERSARIAL) {
    it(`${name} < 50 ms`, () => {
      expect(bestOf3(() => buildPreview(input, 500))).toBeLessThan(50);
    });
  }
  it('dangerous shell shapes at the end of a huge input still run fast', () => {
    const input = `${'> ~/ '.repeat(10_000)}| sh`;
    expect(bestOf3(() => detectDanger(input))).toBeLessThan(50);
  });
});
