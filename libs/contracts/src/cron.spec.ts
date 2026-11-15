import { describe, expect, it } from 'vitest';
import { nextCronRun, validateCron } from './cron.js';

const t = (s: string): Date => new Date(s);

describe('cron (Asia/Tashkent, UTC+5)', () => {
  it('har kecha 02:00 Toshkent = 21:00 UTC', () => {
    expect(nextCronRun('0 2 * * *', t('2026-11-13T10:00:00Z'))!.toISOString()).toBe('2026-11-13T21:00:00.000Z');
    // 02:00 Toshkentning o'zida: qat'iy keyingisi
    expect(nextCronRun('0 2 * * *', t('2026-11-13T21:00:00Z'))!.toISOString()).toBe('2026-11-14T21:00:00.000Z');
    expect(nextCronRun('0 2 * * *', t('2026-11-13T20:59:59Z'))!.toISOString()).toBe('2026-11-13T21:00:00.000Z');
  });

  it('har dushanba 09:00', () => {
    // 2026-11-13 juma. Keyingi dushanba 2026-11-16 09:00 Toshkent = 04:00 UTC
    expect(nextCronRun('0 9 * * 1', t('2026-11-13T10:00:00Z'))!.toISOString()).toBe('2026-11-16T04:00:00.000Z');
    expect(nextCronRun('0 9 * * 1', t('2026-11-16T04:00:00Z'))!.toISOString()).toBe('2026-11-23T04:00:00.000Z');
  });

  it('UTC kuni chegarasi: Toshkent ertasi kuniga o\'tadi', () => {
    // 2026-11-13 20:00 UTC = 01:00 Toshkent 14-noyabr (shanba); "0 0 * * 6" -> 14-noyabr 00:00 allaqachon o'tgan
    expect(nextCronRun('0 0 * * 6', t('2026-11-13T20:00:00Z'))!.toISOString()).toBe('2026-11-20T19:00:00.000Z');
  });

  it('soat ro\'yxati, oy, yil almashishi', () => {
    expect(nextCronRun('30 8,20 * * *', t('2026-12-31T16:00:00Z'))!.toISOString()).toBe('2027-01-01T03:30:00.000Z');
    expect(nextCronRun('0 0 1 1 *', t('2026-11-13T00:00:00Z'))!.toISOString()).toBe('2026-12-31T19:00:00.000Z');
  });

  it('kun-oy va hafta kuni ikkalasi cheklangan => YOKI', () => {
    // 15-kun YOKI dushanba
    expect(nextCronRun('0 0 15 * 1', t('2026-11-13T20:00:00Z'))!.toISOString()).toBe('2026-11-14T19:00:00.000Z'); // 15-noyabr 00:00 (yakshanba)
  });

  it('7 = yakshanba', () => {
    expect(nextCronRun('0 12 * * 7', t('2026-11-13T00:00:00Z'))!.toISOString()).toBe('2026-11-15T07:00:00.000Z');
  });

  it('mavjud bo\'lmagan sana => null', () => {
    expect(nextCronRun('0 0 31 2 *', t('2026-11-13T00:00:00Z'))).toBeNull();
  });

  it('validatsiya: minimal oraliq 1 soat', () => {
    expect(validateCron('0 2 * * *')).toBeNull();
    expect(validateCron('15 * * * *')).toBeNull();
    expect(validateCron('0 */2 * * *')).toBeNull();
    expect(validateCron('*/30 * * * *')).toMatch(/Eng kichik/);
    expect(validateCron('* * * * *')).toMatch(/Eng kichik/);
    expect(validateCron('0,30 * * * *')).toMatch(/Eng kichik/);
  });

  it('validatsiya: xatolar', () => {
    expect(validateCron('0 2 * *')).toMatch(/5 ta/);
    expect(validateCron('0 25 * * *')).toMatch(/oralig/);
    expect(validateCron('0 2 * * x')).toMatch(/noto'g'ri/);
    expect(validateCron('0 2 */0 * *')).toMatch(/qadam/);
    expect(validateCron('0 2 5-1 * *')).toMatch(/oralig/);
  });
});
