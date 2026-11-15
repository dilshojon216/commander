import { z } from 'zod';
import type { AgentLimitsPayload, LimitWindow } from '@commander/contracts';

/** Status line JSON'dagi `rate_limits` (faqat kerakli qismi). Har oyna optional (five_hour faol bo'lmasa umuman yo'q). */
const WindowInSchema = z.looseObject({
  used_percentage: z.number().min(0).max(1000),
  resets_at: z.number().positive(),
});

export const StatuslineInputSchema = z.looseObject({
  session_id: z.string().min(1).max(255).optional(),
  rate_limits: z
    .looseObject({
      five_hour: WindowInSchema.optional(),
      seven_day: WindowInSchema.optional(),
    })
    .optional(),
});

export const MIN_LIMITS_INTERVAL_MS = 30_000;
/**
 * O'zgarmagan rasmiy qiymat ham shu oraliqda qayta yuboriladi: markaz `FRESH_SECONDS` (180 s) dan eski kuzatuvni eskirgan
 * deb `estimate` ko'rsatadi (2026-11-14: haftalik % bir soat o'zgarmagani uchun "taxmin" chiqqan). 180 s dan kichik bo'lsin.
 */
export const LIMITS_KEEPALIVE_MS = 120_000;

/** `resets_at` sekund (epoch s) -> ms; allaqachon ms bo'lsa (>1e12) o'zgarmaydi. */
export function resetsAtToMs(resetsAt: number): number {
  return Math.round(resetsAt > 1e12 ? resetsAt : resetsAt * 1000);
}

function toWindow(w: { used_percentage: number; resets_at: number } | undefined): LimitWindow | undefined {
  return w ? { usedPct: w.used_percentage, resetsAt: resetsAtToMs(w.resets_at) } : undefined;
}

function same(a: LimitWindow | undefined, b: LimitWindow | undefined): boolean {
  if (!a || !b) return a === b;
  return a.usedPct === b.usedPct && a.resetsAt === b.resetsAt;
}

/**
 * Limit kuzatuvlarini siqadi: qiymat o'zgarganda, lekin avvalgi yuborishdan 30 s dan tez emas, `agent.limits` chiqaradi.
 * `observedAt` = o'zgarish kuzatilgan vaqt (kutish davomida yangi qiymat kelsa, oxirgisiniki); u outbox'ga
 * tushgach retry'da o'zgarmaydi.
 */
export class LimitsThrottle {
  private lastSent: { fiveHour?: LimitWindow; sevenDay?: LimitWindow } | undefined;
  private lastSentAt = 0;
  private pending: AgentLimitsPayload | undefined;

  constructor(
    private readonly minIntervalMs: number = MIN_LIMITS_INTERVAL_MS,
    private readonly keepAliveMs: number = LIMITS_KEEPALIVE_MS,
  ) {}

  /** Yuborishga tayyor payload yoki `null` (o'zgarish yo'q / hali erta; keyin `flush` bilan olinadi). */
  observe(input: unknown, now: number): AgentLimitsPayload | null {
    const parsed = StatuslineInputSchema.safeParse(input);
    if (!parsed.success || !parsed.data.rate_limits) return this.flush(now);
    const fiveHour = toWindow(parsed.data.rate_limits.five_hour);
    const sevenDay = toWindow(parsed.data.rate_limits.seven_day);
    if (!fiveHour && !sevenDay) return this.flush(now);

    const changed = !this.lastSent || !same(fiveHour, this.lastSent.fiveHour) || !same(sevenDay, this.lastSent.sevenDay);
    // O'zgarmagan qiymat: faqat keep-alive oralig'i o'tgan bo'lsa (yangi observedAt bilan) qayta yuboriladi
    if (!changed && now - this.lastSentAt < this.keepAliveMs) {
      this.pending = undefined;
      return null;
    }
    this.pending = {
      ...(fiveHour ? { fiveHour } : {}),
      ...(sevenDay ? { sevenDay } : {}),
      ...(parsed.data.session_id ? { claudeSessionId: parsed.data.session_id } : {}),
      observedAt: now,
    };
    return this.flush(now);
  }

  /** Kutayotgan qiymat bor va interval o'tgan bo'lsa uni qaytaradi (taymer chaqiradi). */
  flush(now: number): AgentLimitsPayload | null {
    if (!this.pending) return null;
    if (this.lastSentAt !== 0 && now - this.lastSentAt < this.minIntervalMs) return null;
    const out = this.pending;
    this.pending = undefined;
    this.lastSent = { ...(out.fiveHour ? { fiveHour: out.fiveHour } : {}), ...(out.sevenDay ? { sevenDay: out.sevenDay } : {}) };
    this.lastSentAt = now;
    return out;
  }

  hasPending(): boolean {
    return this.pending !== undefined;
  }

  /** Taymer uchun: keyingi urinishgacha ms. */
  msUntilFlush(now: number): number {
    return Math.max(0, this.minIntervalMs - (now - this.lastSentAt));
  }
}
