import { describe, expect, it } from 'vitest';
import { amountForMinutes, billedMinutes, convertMinor, divRoundHalfUp, formatMinor, parseDecimal } from './money.js';

describe('parseDecimal', () => {
  it('to\'g\'ri va noto\'g\'ri matn', () => {
    expect(parseDecimal('12.5')).toEqual({ units: 125n, scale: 1 });
    expect(parseDecimal('150000')).toEqual({ units: 150000n, scale: 0 });
    expect(parseDecimal('0.0001')).toEqual({ units: 1n, scale: 4 });
    for (const bad of ['', '-1', '1,5', '1.', '.5', '1e3', '1.00001', 'abc', ' 1', '1234567890123']) expect(parseDecimal(bad), bad).toBeNull();
  });
});

describe('divRoundHalfUp', () => {
  it('yarmi yuqoriga', () => {
    expect(divRoundHalfUp(5n, 2n)).toBe(3n);
    expect(divRoundHalfUp(4n, 2n)).toBe(2n);
    expect(divRoundHalfUp(1n, 3n)).toBe(0n);
    expect(divRoundHalfUp(2n, 3n)).toBe(1n);
    expect(divRoundHalfUp(0n, 7n)).toBe(0n);
  });
});

describe('amountForMinutes (decimal, yaxlitlash)', () => {
  it("USD: 90 daqiqa x 10 = 15.00", () => expect(formatMinor(amountForMinutes(90, '10', 'USD')!, 2)).toBe('15.00'));
  it("USD: 1 daqiqa x 10 = 0.17 (0.1666.. half-up)", () => expect(formatMinor(amountForMinutes(1, '10', 'USD')!, 2)).toBe('0.17'));
  it("USD: 7 daqiqa x 12.5 = 1.46 (1.4583)", () => expect(formatMinor(amountForMinutes(7, '12.5', 'USD')!, 2)).toBe('1.46'));
  it("USD: aniq yarim sent yuqoriga: 3 daqiqa x 0.1 = 0.005 -> 0.01", () => expect(formatMinor(amountForMinutes(3, '0.1', 'USD')!, 2)).toBe('0.01'));
  it("UZS: butun so'm, 100 daqiqa x 150000 = 250000", () => expect(formatMinor(amountForMinutes(100, '150000', 'UZS')!, 0)).toBe('250000'));
  it("UZS: 1 daqiqa x 100000 = 1667 (1666.67)", () => expect(formatMinor(amountForMinutes(1, '100000', 'UZS')!, 0)).toBe('1667'));
  it('0 daqiqa = 0; katta son aniq (float xatosi yo\'q)', () => {
    expect(formatMinor(amountForMinutes(0, '10', 'USD')!, 2)).toBe('0.00');
    // 0.1 + 0.2 muammosi: 3 daqiqa * 0.2 / 60 -> aniq 0.01
    expect(formatMinor(amountForMinutes(300, '0.2', 'USD')!, 2)).toBe('1.00');
    expect(formatMinor(amountForMinutes(60 * 100_000, '999999999999.9999', 'USD')!, 2)).toBe('99999999999999990.00');
  });
  it("noto'g'ri kirish -> null", () => {
    expect(amountForMinutes(-1, '10', 'USD')).toBeNull();
    expect(amountForMinutes(1.5, '10', 'USD')).toBeNull();
    expect(amountForMinutes(5, 'x', 'USD')).toBeNull();
  });
});

describe('convertMinor (qo\'lda kurs)', () => {
  it('USD -> UZS', () => expect(convertMinor(1500n, 'USD', 'UZS', '12650.5')).toBe(189758n)); // 15.00 * 12650.5 = 189757.5 -> 189758
  it('UZS -> USD', () => expect(convertMinor(250000n, 'UZS', 'USD', '12500')).toBe(2000n)); // 20.00
  it('UZS -> USD yaxlitlash', () => expect(convertMinor(1000n, 'UZS', 'USD', '12650')).toBe(8n)); // 0.0790 -> 0.08
  it('bir xil valyuta o\'zgarmaydi; kurs 0 yoki xato -> null', () => {
    expect(convertMinor(77n, 'USD', 'USD', '0')).toBe(77n);
    expect(convertMinor(77n, 'USD', 'UZS', '0')).toBeNull();
    expect(convertMinor(77n, 'USD', 'UZS', 'abc')).toBeNull();
  });
});

describe('formatMinor / billedMinutes', () => {
  it('formatlash', () => {
    expect(formatMinor(5n, 2)).toBe('0.05');
    expect(formatMinor(123456n, 2)).toBe('1234.56');
    expect(formatMinor(7n, 0)).toBe('7');
    expect(formatMinor(0n, 2)).toBe('0.00');
    expect(formatMinor(-150n, 2)).toBe('-1.50');
  });
  it('daqiqaga yaxlitlash', () => {
    expect(billedMinutes(29)).toBe(0);
    expect(billedMinutes(30)).toBe(1);
    expect(billedMinutes(89)).toBe(1);
    expect(billedMinutes(90)).toBe(2);
    expect(billedMinutes(-5)).toBe(0);
  });
});
