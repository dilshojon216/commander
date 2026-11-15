import { describe, expect, it } from 'vitest';
import { callbackKey, decodeCallback, encodeCallback } from './callback-data.js';

const key = callbackKey('123456:TEST-token-for-unit-tests-only');
const id = '0b7f3c1e-9d2a-4c55-8f10-aa11bb22cc33';

describe('callback_data', () => {
  it('64 baytdan kichik va aylanma to\'g\'ri', () => {
    for (const action of ['ask', 'deny', 'confirm', 'back', 'pick'] as const) {
      const data = encodeCallback(key, action, id, 777);
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
      expect(decodeCallback(key, data, 777)).toEqual({ action, approvalId: id });
    }
  });
  it('boshqa chat id bilan rad etiladi (tugma ko\'chirib ishlatib bo\'lmaydi)', () => {
    expect(decodeCallback(key, encodeCallback(key, 'deny', id, 777), 778)).toBeNull();
  });
  it('amal yoki id o\'zgartirilsa rad etiladi', () => {
    const data = encodeCallback(key, 'deny', id, 777);
    expect(decodeCallback(key, `c${data.slice(1)}`, 777)).toBeNull(); // deny -> confirm
    const other = encodeCallback(key, 'deny', '0b7f3c1e-9d2a-4c55-8f10-aa11bb22cc34', 777);
    expect(decodeCallback(key, data.slice(0, 33) + other.slice(33), 777)).toBeNull();
  });
  it('boshqa kalit (boshqa token) bilan rad etiladi', () => {
    expect(decodeCallback(callbackKey('999:other-token-000000000000000000'), encodeCallback(key, 'deny', id, 1), 1)).toBeNull();
  });
  it('shakli noto\'g\'ri satrlar rad etiladi', () => {
    for (const bad of ['', 'x', 'd', `z${'0'.repeat(32)}${'A'.repeat(16)}`, `d${'0'.repeat(31)}${'A'.repeat(16)}`, 'a'.repeat(200), `d${'g'.repeat(32)}${'A'.repeat(16)}`]) {
      expect(decodeCallback(key, bad, 1)).toBeNull();
    }
  });
});

describe('callback arg (6.13)', () => {
  const key = callbackKey('123:token');
  const id = '0b7f3c1e-9d2a-4c55-8f10-aa11bb22cc33';
  it('arg imzoga kiradi: o\'zgartirilsa yoki olib tashlansa rad etiladi; uzunligi <= 64 bayt', () => {
    const data = encodeCallback(key, 'qopt', id, 42, '13');
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    expect(decodeCallback(key, data, 42)).toEqual({ action: 'qopt', approvalId: id, arg: '13' });
    expect(decodeCallback(key, `${data.slice(0, -2)}14`, 42)).toBeNull();
    expect(decodeCallback(key, data.slice(0, -2), 42)).toBeNull();
    expect(decodeCallback(key, data, 43)).toBeNull();
    expect(() => encodeCallback(key, 'qopt', id, 42, 'ABCDE')).toThrow();
  });
  it('argsiz eski format o\'zgarmagan', () => {
    expect(decodeCallback(key, encodeCallback(key, 'deny', id, 42), 42)).toEqual({ action: 'deny', approvalId: id });
  });
});
