/** Oddiy xotiradagi fixed-window limiter (bitta jarayon; restartda tiklanadi: qabul qilingan kompromiss). */
export class FixedWindowLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 10_000,
  ) {}

  private bucket(key: string, now: number): { count: number; resetAt: number } {
    let b = this.buckets.get(key);
    if (!b || b.resetAt <= now) {
      if (this.buckets.size >= this.maxKeys) this.prune(now);
      b = { count: 0, resetAt: now + this.windowMs };
      this.buckets.set(key, b);
    }
    return b;
  }

  private prune(now: number): void {
    for (const [k, b] of this.buckets) if (b.resetAt <= now) this.buckets.delete(k);
    // Hamon to'la bo'lsa eng eskilarini tashlaymiz (xotira chegarasi).
    if (this.buckets.size >= this.maxKeys) {
      for (const k of this.buckets.keys()) {
        this.buckets.delete(k);
        if (this.buckets.size < this.maxKeys / 2) break;
      }
    }
  }

  isBlocked(key: string, now: number = Date.now()): boolean {
    const b = this.buckets.get(key);
    return !!b && b.resetAt > now && b.count >= this.limit;
  }

  hit(key: string, now: number = Date.now()): number {
    const b = this.bucket(key, now);
    b.count += 1;
    return b.count;
  }

  retryAfterSeconds(key: string, now: number = Date.now()): number {
    const b = this.buckets.get(key);
    return b && b.resetAt > now ? Math.max(1, Math.ceil((b.resetAt - now) / 1000)) : 1;
  }
}
