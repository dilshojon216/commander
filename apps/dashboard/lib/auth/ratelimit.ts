/**
 * Kirish urinishlari chegarasi (sof; soat tashqaridan beriladi). Barcha so'rovlar loopback'dan keladi, shuning uchun
 * kalit bo'yicha GLOBAL hisob: `max` ta xato `windowMs` ichida bo'lsa `lockMs` davomida bloklanadi.
 * Faqat taxmin qilinadigan yo'l (parol) uchun ishlatiladi: passkey va ilova siri taxmin qilinmaydi, shuning uchun
 * hujumchi parolni spam qilib egasini passkey/Touch ID'dan chiqarib yubora olmaydi.
 */
export interface LimiterOptions {
  max: number;
  windowMs: number;
  lockMs: number;
}

export class AttemptLimiter {
  private fails: number[] = [];
  private lockedUntil = 0;

  constructor(private readonly opts: LimiterOptions) {}

  /** `retryAfterMs > 0` bo'lsa urinish taqiqlangan. */
  check(now: number): { allowed: boolean; retryAfterMs: number } {
    if (now < this.lockedUntil) return { allowed: false, retryAfterMs: this.lockedUntil - now };
    return { allowed: true, retryAfterMs: 0 };
  }

  fail(now: number): void {
    this.fails = this.fails.filter((t) => now - t < this.opts.windowMs);
    this.fails.push(now);
    if (this.fails.length >= this.opts.max) {
      this.lockedUntil = now + this.opts.lockMs;
      this.fails = [];
    }
  }

  success(): void {
    this.fails = [];
  }
}

type GlobalWithLimiters = typeof globalThis & { __commanderLimiters?: Map<string, AttemptLimiter> };

/** Jarayon bo'yicha yagona nusxa (Next bir nechta bundle yuklasa ham `globalThis` umumiy). */
export function limiterFor(key: string, opts: LimiterOptions): AttemptLimiter {
  const g = globalThis as GlobalWithLimiters;
  g.__commanderLimiters ??= new Map();
  let l = g.__commanderLimiters.get(key);
  if (!l) {
    l = new AttemptLimiter(opts);
    g.__commanderLimiters.set(key, l);
  }
  return l;
}

export const PASSWORD_LIMIT: LimiterOptions = { max: 5, windowMs: 5 * 60_000, lockMs: 5 * 60_000 };
export const SECRET_LIMIT: LimiterOptions = { max: 10, windowMs: 5 * 60_000, lockMs: 2 * 60_000 };
