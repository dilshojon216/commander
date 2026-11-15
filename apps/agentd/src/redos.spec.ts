import { describe, expect, it } from 'vitest';
import { ChatItemConverter } from './chat-items.js';
import { authorNameOnly } from './git-info.js';
import { trimTrailingReplacement } from './project-files.js';

const MB = 1024 * 1024;
const fast = (fn: () => unknown, ms = 500): void => {
  const t0 = performance.now();
  fn();
  expect(performance.now() - t0).toBeLessThan(ms);
};

describe('agentd regexlari hujumchi kirishida chiziqli (M-17 keng ko\'rik)', () => {
  it('authorNameOnly: 1 MB `a` (email regex) tez', () => fast(() => authorNameOnly('a'.repeat(MB))));
  it('trimTrailingReplacement: ichki U+FFFD ketma-ketligi kvadratik emas, oxirgisi olib tashlanadi', () => {
    const s = '\uFFFD'.repeat(MB / 2) + 'x' + '\uFFFD\uFFFD';
    fast(() => expect(trimTrailingReplacement(s).endsWith('x')).toBe(true));
    expect(trimTrailingReplacement('abc')).toBe('abc');
  });
  it('chat-items: yopilmagan <system-reminder> / <bash-input> teglari 1 MB tez', () => {
    const conv = new ChatItemConverter({} as never);
    const text = '<system-reminder>'.repeat(MB / 17);
    const line = JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-11-14T00:00:00Z', message: { role: 'user', content: text } });
    fast(() => conv.convertLine(line), 1000);
    const bash = JSON.stringify({ type: 'user', uuid: 'u2', timestamp: '2026-11-14T00:00:00Z', message: { role: 'user', content: '<bash-input>'.repeat(MB / 12) } });
    fast(() => conv.convertLine(bash), 1000);
  });
});
