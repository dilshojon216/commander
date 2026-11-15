import type { BillingCurrency } from '@commander/contracts';

/**
 * Pul hisobi (6.7): float YO'Q. Hamma narsa BigInt: stavka (matn, <= 4 kasr) -> minor birliklar -> yaxlitlash (half-up).
 * Valyuta aniqligi: USD 2 kasr (sent), UZS 0 kasr (butun so'm: tiyin amalda ishlatilmaydi).
 */

export const CURRENCY_DECIMALS: Record<BillingCurrency, number> = { USD: 2, UZS: 0 };

const DEC_RE = /^\d{1,12}(\.\d{1,4})?$/;

/** `"12.5"` -> `{ units: 125n, scale: 1 }` (units / 10^scale). `null` = noto'g'ri matn. */
export function parseDecimal(text: string): { units: bigint; scale: number } | null {
  if (!DEC_RE.test(text)) return null;
  const [int, frac = ''] = text.split('.');
  return { units: BigInt(int! + frac), scale: frac.length };
}

const pow10 = (n: number): bigint => 10n ** BigInt(n);

/** `num / den` ni half-up yaxlitlaydi (musbat son/maxraj). */
export function divRoundHalfUp(num: bigint, den: bigint): bigint {
  if (den <= 0n) throw new RangeError('denominator must be positive');
  return (num * 2n + den) / (den * 2n);
}

/** Minor birlikdagi (10^-decimals) butun sonni matnga: `1250n, 2 -> "12.50"`; decimals=0 -> `"1250"`. */
export function formatMinor(minor: bigint, decimals: number): string {
  const neg = minor < 0n;
  const abs = neg ? -minor : minor;
  const s = abs.toString().padStart(decimals + 1, '0');
  const body = decimals === 0 ? s : `${s.slice(0, s.length - decimals)}.${s.slice(s.length - decimals)}`;
  return neg ? `-${body}` : body;
}

/**
 * Summa = daqiqalar x soatlik stavka / 60, mijoz valyutasida, valyuta aniqligigacha half-up yaxlitlangan.
 * Daqiqa = faturalash birligi (soat ko'rinishi `h:mm` bilan mos kelishi uchun).
 */
export function amountForMinutes(minutes: number, rate: string, currency: BillingCurrency): bigint | null {
  const r = parseDecimal(rate);
  if (!r || !Number.isInteger(minutes) || minutes < 0) return null;
  const decimals = CURRENCY_DECIMALS[currency];
  // minutes * units / 10^scale / 60, natija 10^decimals birlikda
  const num = BigInt(minutes) * r.units * pow10(decimals);
  const den = 60n * pow10(r.scale);
  return divRoundHalfUp(num, den);
}

/** Valyuta konvertatsiyasi (qo'lda kurs: 1 USD = fx UZS). Natija `to` aniqligida (half-up). */
export function convertMinor(minor: bigint, from: BillingCurrency, to: BillingCurrency, fxUzsPerUsd: string): bigint | null {
  if (from === to) return minor;
  const fx = parseDecimal(fxUzsPerUsd);
  if (!fx || fx.units === 0n) return null;
  const fromDec = CURRENCY_DECIMALS[from];
  const toDec = CURRENCY_DECIMALS[to];
  if (from === 'USD') {
    // USD(minor 10^-2) * fx -> UZS(minor 10^0)
    return divRoundHalfUp(minor * fx.units * pow10(toDec), pow10(fromDec + fx.scale));
  }
  // UZS(minor 10^0) / fx -> USD(minor 10^-2)
  return divRoundHalfUp(minor * pow10(fx.scale + toDec), fx.units * pow10(fromDec));
}

/** Soniyani eng yaqin butun daqiqaga (half-up). */
export const billedMinutes = (seconds: number): number => Math.floor((Math.max(0, seconds) + 30) / 60);
