import { describe, expect, it } from 'vitest';
import { parseChatIds } from './chat-ids.js';

describe('parseChatIds', () => {
  it('bo\'sh/aniqlanmagan -> []', () => {
    expect(parseChatIds(undefined)).toEqual([]);
    expect(parseChatIds('')).toEqual([]);
    expect(parseChatIds(' , ')).toEqual([]);
  });
  it('vergul bilan ajratilgan, dublikatsiz', () => {
    expect(parseChatIds('123, 456,123')).toEqual(['123', '456']);
  });
  it('yaroqsiz element (manfiy, harf, nol bilan boshlangan) -> xato', () => {
    for (const bad of ['-100123', 'abc', '012', '1.5', '123,x']) expect(() => parseChatIds(bad)).toThrow(/TELEGRAM_ALLOWED_CHAT_IDS/);
  });
});
